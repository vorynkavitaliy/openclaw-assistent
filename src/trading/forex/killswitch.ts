import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../../utils/logger.js';
import { sendTelegram } from '../../utils/telegram.js';
import { hasFlag, getArg } from '../../utils/args.js';
import { runMain } from '../../utils/process.js';
import { closeAll, disconnect } from './client.js';
import {
  loadState,
  getState,
  activateKillSwitch,
  deactivateKillSwitch,
  isKillSwitchActive,
} from './state.js';

const log = createLogger('forex-killswitch');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../../data');
const KILL_SWITCH_FILE = path.join(DATA_DIR, 'FOREX_KILL_SWITCH');

function getKillSwitchMeta(): { activated: string; reason: string } | null {
  if (!fs.existsSync(KILL_SWITCH_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(KILL_SWITCH_FILE, 'utf-8')) as {
      activated: string;
      reason: string;
    };
  } catch {
    return null;
  }
}

function showStatus(): void {
  loadState();
  const state = getState();
  const killActive = isKillSwitchActive();
  const meta = getKillSwitchMeta();

  log.info('Статус форекс трейдера', {
    killSwitch: killActive,
    killReason: meta?.reason ?? null,
    killActivated: meta?.activated ?? null,
    stopDay: state.stopDay,
    stopDayReason: state.stopDayReason,
    tradesCount: state.tradesCount,
    wins: state.wins,
    losses: state.losses,
    stopsCount: state.stopsCount,
    dailyPnl: state.dailyPnl,
    lastResetDate: state.lastResetDate,
  });
}

async function main(): Promise<void> {
  loadState();

  if (hasFlag('on')) {
    const reason = getArg('reason') ?? 'manual';
    activateKillSwitch(reason);
    log.warn(`Kill Switch АКТИВИРОВАН: ${reason}`);

    log.info('Закрываем все форекс позиции...');
    try {
      await closeAll();
      log.info('Все позиции закрыты');
    } catch (error: unknown) {
      log.error('Ошибка при закрытии позиций', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    await sendTelegram(
      `🚨 *FOREX KILL SWITCH АКТИВИРОВАН*\n\nПричина: ${reason}\nВремя: ${new Date().toISOString()}\n\nВсе форекс позиции закрыты.`,
    );

    return;
  }

  if (hasFlag('off')) {
    deactivateKillSwitch();
    log.info('Kill Switch ДЕАКТИВИРОВАН');

    await sendTelegram(
      `✅ *Forex Kill Switch деактивирован*\n\nВремя: ${new Date().toISOString()}\nТорговля возобновлена.`,
    );

    return;
  }

  showStatus();
}

runMain(main, () => {
  disconnect();
});
