import { createLogger } from '../../utils/logger.js';
import { modifyPosition, partialClosePosition } from './bybit-client.js';
import config from './config.js';
import { logDecision } from './decision-journal.js';
import * as state from './state.js';
import { getQtyPrecision, roundPrice } from './symbol-specs.js';

const log = createLogger('position-manager');

// Дефолтный SL: ATR * atrSlMultiplier от цены входа (fallback — 2% от entry)
export function calcDefaultSl(entry: number, side: string, atrEstimate?: number): number {
  const slDist = atrEstimate ? atrEstimate * config.atrSlMultiplier : entry * 0.02;
  return side === 'long' ? entry - slDist : entry + slDist;
}

// Дефолтный TP: SL_distance * minRR от entry
export function calcDefaultTp(entry: number, sl: number, side: string): number {
  const slDist = Math.abs(entry - sl);
  return side === 'long' ? entry + slDist * config.minRR : entry - slDist * config.minRR;
}

export async function managePositions(
  cycleId: string,
  dryRun: boolean,
): Promise<Array<Record<string, unknown>>> {
  const s = state.get();
  const actions: Array<Record<string, unknown>> = [];

  for (const pos of s.positions) {
    const uPnl = parseFloat(pos.unrealisedPnl) || 0;
    const entry = parseFloat(pos.entryPrice) || 0;
    const sl = parseFloat(pos.stopLoss ?? '0') || 0;
    const tp = parseFloat(pos.takeProfit ?? '0') || 0;
    const size = parseFloat(pos.size) || 0;

    if (entry === 0 || size === 0) continue;

    const slDistance = Math.abs(entry - sl);

    // SL-Guard: позиция без стоп-лосса — установить дефолтный SL/TP
    if (slDistance === 0) {
      const defaultSl = roundPrice(calcDefaultSl(entry, pos.side), pos.symbol);
      const defaultTp =
        tp === 0 ? roundPrice(calcDefaultTp(entry, defaultSl, pos.side), pos.symbol) : undefined;

      if (!dryRun) {
        try {
          await modifyPosition(
            pos.symbol,
            String(defaultSl),
            defaultTp ? String(defaultTp) : undefined,
          );
          actions.push({
            type: 'sl_guard_applied',
            symbol: pos.symbol,
            defaultSl,
            defaultTp: defaultTp ?? 'unchanged',
            result: 'OK',
          });
          state.logEvent('sl_guard', {
            symbol: pos.symbol,
            entry,
            defaultSl,
            defaultTp,
            reason: 'Position found without SL — default SL/TP applied',
          });
          logDecision(
            cycleId,
            'manage',
            pos.symbol,
            'SL_GUARD',
            [
              'Позиция без стоп-лосса — установлен дефолтный SL/TP',
              `SL: ${defaultSl}, TP: ${defaultTp ?? 'без изменений'}`,
            ],
            { entry, sl: defaultSl, ...(defaultTp !== undefined ? { tp: defaultTp } : {}) },
          );
          log.warn('SL-Guard: applied default SL/TP', { symbol: pos.symbol, defaultSl, defaultTp });
        } catch (err) {
          actions.push({
            type: 'sl_guard_failed',
            symbol: pos.symbol,
            result: `ERROR: ${(err as Error).message}`,
          });
          state.logEvent('api_error', {
            type: 'sl_guard_failed',
            symbol: pos.symbol,
            entry,
            error: (err as Error).message,
          });
          log.error('SL-Guard: failed to apply default SL/TP', {
            symbol: pos.symbol,
            error: (err as Error).message,
          });
        }
      } else {
        actions.push({
          type: 'sl_guard_applied',
          symbol: pos.symbol,
          defaultSl,
          defaultTp: defaultTp ?? 'unchanged',
          result: 'DRY_RUN',
        });
      }
      continue; // Пропускаем trailing/partial для этой позиции до следующего цикла
    }

    const oneR = slDistance * size;
    const currentR = uPnl / oneR;

    if (currentR >= config.partialCloseAtR && !dryRun) {
      const partialQty = (size * config.partialClosePercent).toFixed(getQtyPrecision(pos.symbol));
      if (parseFloat(partialQty) > 0) {
        try {
          await partialClosePosition(pos.symbol, partialQty);
          actions.push({
            type: 'partial_close',
            symbol: pos.symbol,
            qty: partialQty,
            atR: currentR.toFixed(2),
            result: 'OK',
          });

          // После частичного закрытия — SL в безубыток + пересчёт TP на расширенную цель
          const extendedTp = roundPrice(
            pos.side === 'long'
              ? entry + slDistance * (config.minRR + 1)
              : entry - slDistance * (config.minRR + 1),
            pos.symbol,
          );
          await modifyPosition(pos.symbol, String(entry), String(extendedTp));
          actions.push({
            type: 'sl_breakeven_tp_extended',
            symbol: pos.symbol,
            newSl: entry,
            newTp: extendedTp,
            note: `TP extended to ${config.minRR + 1}R after partial close`,
            result: 'OK',
          });

          state.logEvent('partial_close', {
            symbol: pos.symbol,
            qty: partialQty,
            pnlAtClose: uPnl,
            rMultiple: currentR.toFixed(2),
            newTp: extendedTp,
          });
        } catch (err) {
          actions.push({
            type: 'partial_close',
            symbol: pos.symbol,
            result: `ERROR: ${(err as Error).message}`,
          });
        }
      }
    }

    if (currentR >= config.trailingStartR && !dryRun) {
      const mark = parseFloat(pos.markPrice) || 0;
      const trailingDistance = slDistance * config.trailingDistanceR;

      try {
        if (pos.side === 'long') {
          const newSl = mark - trailingDistance;
          if (newSl > sl) {
            await modifyPosition(pos.symbol, String(roundPrice(newSl, pos.symbol)));
            actions.push({
              type: 'trailing_sl',
              symbol: pos.symbol,
              oldSl: sl,
              newSl: String(roundPrice(newSl, pos.symbol)),
              result: 'OK',
            });
          }
        } else {
          const newSl = mark + trailingDistance;
          if (newSl < sl) {
            await modifyPosition(pos.symbol, String(roundPrice(newSl, pos.symbol)));
            actions.push({
              type: 'trailing_sl',
              symbol: pos.symbol,
              oldSl: sl,
              newSl: String(roundPrice(newSl, pos.symbol)),
              result: 'OK',
            });
          }
        }
      } catch (err) {
        actions.push({
          type: 'trailing_sl',
          symbol: pos.symbol,
          result: `ERROR: ${(err as Error).message}`,
        });
      }
    }
  }

  return actions;
}
