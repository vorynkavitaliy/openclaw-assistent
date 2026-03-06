import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../../utils/logger.js';
import { sendTelegram } from '../../utils/telegram.js';
import { runMain } from '../../utils/process.js';
import { getBalance, getPositions, disconnect } from './client.js';
import config from './config.js';
import { loadMetas, getPositionMeta, cleanupClosedPositions } from './position-manager.js';

const log = createLogger('forex-sl-guard');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const KILL_SWITCH_FILE = path.resolve(__dirname, '../../../data/FOREX_KILL_SWITCH');

// ── Kill switch ──────────────────────────────────────────────────────────────

function isKillSwitchActive(): boolean {
  return fs.existsSync(KILL_SWITCH_FILE);
}

function activateKillSwitch(reason: string): void {
  const dir = path.dirname(KILL_SWITCH_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(KILL_SWITCH_FILE, `${new Date().toISOString()}: ${reason}`, 'utf-8');
  log.error(`KILL SWITCH ACTIVATED: ${reason}`);
}

// ── Основная логика ──────────────────────────────────────────────────────────

async function runGuard(): Promise<void> {
  log.info('SL Guard started');

  if (isKillSwitchActive()) {
    log.warn('Kill switch already active, skipping guard run');
    return;
  }

  // Загружаем position metas
  loadMetas();

  // Получаем баланс и позиции
  const [account, positions] = await Promise.all([getBalance(), getPositions()]);

  if (positions.length === 0) {
    log.info('No open positions, guard done');
    return;
  }

  log.info(`Checking ${positions.length} position(s), balance=${account.totalWalletBalance}`);

  // Удаляем мета для закрытых позиций
  const openIds = positions.map((p) => p.positionId);
  cleanupClosedPositions(openIds);

  const walletBalance = account.totalWalletBalance;
  let totalDrawdown = 0;
  let hasAlert = false;

  for (const pos of positions) {
    const posId = pos.positionId;
    const meta = getPositionMeta(posId);
    const unrealisedPnl = parseFloat(pos.unrealisedPnl);

    // ── Проверка наличия SL ───────────────────────────────────────────────────
    if (!meta || meta.sl <= 0) {
      const msg = `🚨 FOREX: позиция ${pos.symbol} (${posId}) без SL!`;
      log.error(`CRITICAL: position ${posId} ${pos.symbol} has no SL in meta`);
      hasAlert = true;

      try {
        await sendTelegram(msg);
      } catch (err: unknown) {
        log.error('Failed to send Telegram alert', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      continue;
    }

    // ── Проверка убытка > 2% баланса ─────────────────────────────────────────
    if (walletBalance > 0 && unrealisedPnl < 0) {
      const lossPct = (Math.abs(unrealisedPnl) / walletBalance) * 100;

      if (lossPct > 2) {
        log.warn(
          `WARNING: position ${posId} ${pos.symbol} loss=${lossPct.toFixed(2)}% of balance`,
          { unrealisedPnl, walletBalance },
        );
      }

      totalDrawdown += Math.abs(unrealisedPnl);
    }
  }

  // ── Проверка дневного drawdown ────────────────────────────────────────────
  if (walletBalance > 0) {
    const drawdownPct = (totalDrawdown / walletBalance) * 100;

    log.debug(`Total drawdown: ${drawdownPct.toFixed(2)}% (limit=${config.maxDailyDrawdownPct}%)`);

    if (drawdownPct >= config.maxDailyDrawdownPct) {
      const reason = `Daily drawdown ${drawdownPct.toFixed(2)}% exceeds limit ${config.maxDailyDrawdownPct}%`;

      activateKillSwitch(reason);
      hasAlert = true;

      const msg =
        `🚨 FOREX KILL SWITCH: дневной drawdown ${drawdownPct.toFixed(2)}%` +
        ` превысил лимит ${config.maxDailyDrawdownPct}%. Торговля остановлена.`;

      try {
        await sendTelegram(msg);
      } catch (err: unknown) {
        log.error('Failed to send Telegram kill switch alert', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  if (!hasAlert) {
    log.info('SL Guard: all positions OK');
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

runMain(
  async () => {
    await runGuard();
  },
  () => {
    disconnect();
  },
);
