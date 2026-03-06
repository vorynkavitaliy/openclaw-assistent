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

    // SL-Guard: позиция без стоп-лосса или тейк-профита
    // Биржа возвращает '0' или '' для отсутствующих SL/TP
    const needsSl = sl === 0 || sl === entry;
    const needsTp = tp === 0 || tp === entry;

    if (needsSl || needsTp) {
      const defaultSl = needsSl ? roundPrice(calcDefaultSl(entry, pos.side), pos.symbol) : sl;
      const defaultTp = needsTp
        ? roundPrice(calcDefaultTp(entry, defaultSl, pos.side), pos.symbol)
        : undefined;

      if (!dryRun) {
        try {
          await modifyPosition(
            pos.symbol,
            needsSl ? String(defaultSl) : undefined,
            defaultTp ? String(defaultTp) : undefined,
          );
          const missing = needsSl && needsTp ? 'SL и TP' : needsSl ? 'SL' : 'TP';
          actions.push({
            type: 'sl_guard_applied',
            symbol: pos.symbol,
            defaultSl: needsSl ? defaultSl : 'unchanged',
            defaultTp: defaultTp ?? 'unchanged',
            result: 'OK',
          });
          state.logEvent('sl_guard', {
            symbol: pos.symbol,
            entry,
            defaultSl: needsSl ? defaultSl : undefined,
            defaultTp,
            reason: `Позиция без ${missing} — дефолтные значения установлены`,
          });
          logDecision(
            cycleId,
            'manage',
            pos.symbol,
            'SL_GUARD',
            [
              `Позиция без ${missing} — установлены дефолтные значения`,
              `SL: ${needsSl ? defaultSl : 'без изменений'}, TP: ${defaultTp ?? 'без изменений'}`,
            ],
            {
              entry,
              ...(needsSl ? { sl: defaultSl } : {}),
              ...(defaultTp !== undefined ? { tp: defaultTp } : {}),
            },
          );
          log.warn('SL-Guard: applied defaults', {
            symbol: pos.symbol,
            missing,
            defaultSl: needsSl ? defaultSl : undefined,
            defaultTp,
          });
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
          defaultSl: needsSl ? defaultSl : 'unchanged',
          defaultTp: defaultTp ?? 'unchanged',
          result: 'DRY_RUN',
        });
      }
      continue; // Пропускаем trailing/partial для этой позиции до следующего цикла
    }

    // Если дошли сюда — SL валиден, считаем slDistance для trailing/partial
    const slDistance = Math.abs(entry - sl);
    if (slDistance === 0) continue; // safety: не должно случиться после guard

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
