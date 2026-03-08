import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../../utils/logger.js';
import { closePosition, modifyPosition, type PositionWithId } from './client.js';
import config from './config.js';

const log = createLogger('forex-position-mgr');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const META_FILE = path.resolve(__dirname, '../../../data/forex-position-meta.json');

// ── Типы ────────────────────────────────────────────────────────────────────

export interface PositionMeta {
  sl: number;
  tp: number;
  partialClosed: boolean;
  entryPrice: number;
  side: 'long' | 'short';
  lots: number;
}

// ── Хранилище мета-данных ────────────────────────────────────────────────────

const positionMetas = new Map<string, PositionMeta>();

export function loadMetas(): void {
  try {
    if (!fs.existsSync(META_FILE)) {
      log.debug('Position meta file not found, starting with empty state');
      return;
    }
    const raw = fs.readFileSync(META_FILE, 'utf-8');
    const data = JSON.parse(raw) as Record<string, PositionMeta>;
    positionMetas.clear();
    for (const [id, meta] of Object.entries(data)) {
      positionMetas.set(id, meta);
    }
    log.info(`Loaded position metas: ${positionMetas.size} entries`);
  } catch (error: unknown) {
    log.error('Failed to load position metas', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function saveMetas(): void {
  try {
    const dir = path.dirname(META_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const data: Record<string, PositionMeta> = {};
    for (const [id, meta] of positionMetas) {
      data[id] = meta;
    }
    fs.writeFileSync(META_FILE, JSON.stringify(data, null, 2), 'utf-8');
    log.debug('Position metas saved');
  } catch (error: unknown) {
    log.error('Failed to save position metas', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function registerPosition(posId: string, meta: PositionMeta): void {
  positionMetas.set(posId, meta);
  saveMetas();
  log.info(`Registered position meta: ${posId}`, {
    symbol: 'n/a',
    side: meta.side,
    lots: meta.lots,
    sl: meta.sl,
    tp: meta.tp,
  });
}

export function getPositionMeta(posId: string): PositionMeta | undefined {
  return positionMetas.get(posId);
}

export function cleanupClosedPositions(openIds: string[]): void {
  const openSet = new Set(openIds);
  let removed = 0;
  for (const id of [...positionMetas.keys()]) {
    if (!openSet.has(id)) {
      positionMetas.delete(id);
      removed++;
    }
  }
  if (removed > 0) {
    log.info(`Cleaned up ${removed} closed position(s) from meta`);
    saveMetas();
  }
}

// ── Pip value ────────────────────────────────────────────────────────────────

function pipValue(symbol: string, lots: number): number {
  // Для XXX/USD пар: 1 pip = $10 per standard lot
  // Для USD/XXX пар: зависит от цены
  // Для XAU/USD: 1 pip ($0.1 movement) = $10 per standard lot
  const s = symbol.toUpperCase();
  if (s.startsWith('XAU')) return lots * 100 * 0.1; // gold: $0.1/pip * 100oz
  if (s.endsWith('USD')) return lots * 100000 * 0.0001; // = lots * 10
  return lots * 10; // approximate
}

// ── Управление позициями ─────────────────────────────────────────────────────

export async function managePositions(positions: PositionWithId[]): Promise<void> {
  if (positions.length === 0) return;

  log.debug(`Managing ${positions.length} position(s)`);

  for (const pos of positions) {
    const posId = pos.positionId;
    const meta = positionMetas.get(posId);

    if (!meta) {
      log.warn(`No meta for position ${posId} (${pos.symbol}), skipping management`);
      continue;
    }

    const currentPrice = parseFloat(pos.markPrice);
    const entryPrice = meta.entryPrice;
    const unrealisedPnl = parseFloat(pos.unrealisedPnl);
    const lots = meta.lots;
    const pip = pipValue(pos.symbol, lots);
    const pipSizeVal = pos.symbol.toUpperCase().includes('JPY') ? 0.01 : 0.0001;

    // 1R = расстояние до SL в пипах * стоимость пипа
    const slDistancePips =
      meta.side === 'long'
        ? (entryPrice - meta.sl) / pipSizeVal
        : (meta.sl - entryPrice) / pipSizeVal;

    const riskAmount = slDistancePips * pip;

    if (riskAmount <= 0) {
      log.warn(`Invalid riskAmount=${riskAmount} for position ${posId}, skipping`);
      continue;
    }

    const currentR = unrealisedPnl / riskAmount;

    log.debug(
      `Position ${posId} ${pos.symbol}: currentR=${currentR.toFixed(2)}, PnL=${unrealisedPnl}`,
    );

    // ── Partial close при достижении partialCloseAtR ─────────────────────────
    if (currentR >= config.partialCloseAtR && !meta.partialClosed) {
      const partialLots = Math.round(lots * config.partialClosePercent * 100) / 100;

      log.info(
        `Partial close: ${pos.symbol} pos=${posId} at ${currentR.toFixed(2)}R` +
          ` — closing ${partialLots} lots (${config.partialClosePercent * 100}%)`,
      );

      try {
        await closePosition(posId, partialLots);

        // Перенос SL на безубыток (старые SL/TP ордера отменяются внутри modifyPosition)
        const breakevenSl = entryPrice;
        await modifyPosition(posId, { sl: { price: breakevenSl } });

        meta.partialClosed = true;
        meta.sl = breakevenSl;
        positionMetas.set(posId, meta);
        saveMetas();

        log.info(`SL moved to breakeven=${breakevenSl} for position ${posId}`);
      } catch (error: unknown) {
        log.error(`Partial close failed for position ${posId}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      continue;
    }

    // ── Trailing SL при достижении trailingStartR ─────────────────────────────
    if (currentR >= config.trailingStartR) {
      // ATR нужен для расчёта дистанции трейлинга.
      // Используем pipSizeVal * 100 как аппроксимацию ATR при отсутствии свечей.
      // В реальной реализации следует получать ATR из market data.
      const atrApprox = pipSizeVal * 100;
      const trailingDistance = atrApprox * config.trailingDistanceR;

      let newSl: number;
      if (meta.side === 'long') {
        newSl = currentPrice - trailingDistance;
      } else {
        newSl = currentPrice + trailingDistance;
      }

      // Округляем до 5 знаков
      newSl = Math.round(newSl * 100000) / 100000;

      // Проверяем, что новый SL лучше текущего
      const isImproved = meta.side === 'long' ? newSl > meta.sl : newSl < meta.sl;

      if (isImproved) {
        log.info(
          `Trailing SL: ${pos.symbol} pos=${posId} at ${currentR.toFixed(2)}R` +
            ` — moving SL from ${meta.sl} to ${newSl}`,
        );

        try {
          // Старые SL/TP ордера отменяются внутри modifyPosition перед установкой новых
          await modifyPosition(posId, { sl: { price: newSl } });

          meta.sl = newSl;
          positionMetas.set(posId, meta);
          saveMetas();

          log.info(`Trailing SL updated to ${newSl} for position ${posId}`);
        } catch (error: unknown) {
          log.error(`Trailing SL update failed for position ${posId}`, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }
}
