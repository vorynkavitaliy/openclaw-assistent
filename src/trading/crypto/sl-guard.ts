import path from 'node:path';
import { loadEnv } from '../../utils/env.js';
loadEnv();

import { createLogger } from '../../utils/logger.js';
import { acquireLock, releaseLock } from '../../utils/lockfile.js';
import { sendTelegram } from '../../utils/telegram.js';
import { runMain } from '../../utils/process.js';
import { getPositions, modifyPosition } from './bybit-client.js';
import { calcDefaultSl, calcDefaultTp } from './position-manager.js';
import { roundPrice } from './symbol-specs.js';
import config from './config.js';

const log = createLogger('sl-guard');

async function main(): Promise<void> {
  const LOCK_FILE = path.join(path.dirname(config.stateFile), 'sl-guard.lock');
  if (!acquireLock(LOCK_FILE, 60_000)) {
    log.warn('SL-Guard cycle skipped — previous still running');
    return;
  }

  try {
    const positions = await getPositions();

    if (positions.length === 0) return;

    for (const pos of positions) {
      const entry = parseFloat(pos.entryPrice) || 0;
      const sl = parseFloat(pos.stopLoss ?? '0') || 0;
      const tp = parseFloat(pos.takeProfit ?? '0') || 0;
      const size = parseFloat(pos.size) || 0;

      if (entry === 0 || size === 0) continue;

      // SL/TP отсутствует если биржа вернула '0', '' или равен entry (невалидный)
      const needsSl = sl === 0 || sl === entry;
      const needsTp = tp === 0 || tp === entry;

      if (!needsSl && !needsTp) continue;

      // pos.side уже нормализован: 'long' | 'short' (bybit-client)
      const side = pos.side;

      const newSl = needsSl ? roundPrice(calcDefaultSl(entry, side), pos.symbol) : sl;
      const newTp = needsTp ? roundPrice(calcDefaultTp(entry, newSl, side), pos.symbol) : tp;

      try {
        await modifyPosition(
          pos.symbol,
          needsSl ? String(newSl) : undefined,
          needsTp ? String(newTp) : undefined,
        );

        const missing = needsSl && needsTp ? 'SL и TP' : needsSl ? 'SL' : 'TP';
        const applied: string[] = [];
        if (needsSl) applied.push(`SL=${newSl}`);
        if (needsTp) applied.push(`TP=${newTp}`);

        const msg =
          `⚠️ SL-Guard: ${pos.symbol} ${pos.side.toUpperCase()}\n` +
          `Позиция без ${missing}!\n` +
          `Установлено: ${applied.join(', ')}\n` +
          `Entry: ${entry}, Size: ${size}`;

        log.warn('SL-Guard: применены дефолтные значения', {
          symbol: pos.symbol,
          side: pos.side,
          entry,
          newSl: needsSl ? newSl : 'без изменений',
          newTp: needsTp ? newTp : 'без изменений',
        });

        await sendTelegram(msg);
      } catch (error: unknown) {
        log.error('SL-Guard: ошибка установки SL/TP', {
          symbol: pos.symbol,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    releaseLock(LOCK_FILE);
  }
}

runMain(main);
