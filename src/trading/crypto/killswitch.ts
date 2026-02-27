/**
 * Crypto Kill Switch — экстренная остановка торговли.
 *
 * Использование:
 *   tsx src/trading/crypto/killswitch.ts --on --reason="manual stop"
 *   tsx src/trading/crypto/killswitch.ts --off
 *   tsx src/trading/crypto/killswitch.ts --close-all
 *   tsx src/trading/crypto/killswitch.ts --status
 *
 * Мигрировано из scripts/crypto_killswitch.js
 */

import { createLogger } from '../../utils/logger.js';
import { closeAllPositions, getBalance, getPositions } from './bybit-client.js';
import config from './config.js';
import * as state from './state.js';

const log = createLogger('killswitch');

// ─── CLI утилиты ──────────────────────────────────────────────

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((a: string) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

// ─── Действия ─────────────────────────────────────────────────

async function showStatus(): Promise<void> {
  state.load();
  const s = state.get();
  const killActive = state.isKillSwitchActive();

  let balanceInfo: string;
  let posInfo: string;

  try {
    const balance = await getBalance();
    balanceInfo = `$${balance.totalEquity.toFixed(2)}`;
  } catch {
    balanceInfo = 'недоступен';
  }

  try {
    const positions = await getPositions();
    posInfo =
      positions.length > 0
        ? positions.map((p) => `  ${p.symbol} ${p.side} ${p.size} @ ${p.entryPrice}`).join('\n')
        : '  Нет открытых позиций';
  } catch {
    posInfo = '  Не удалось получить';
  }

  console.log(`
╔════════════════════════════════════╗
║      CRYPTO TRADING STATUS        ║
╠════════════════════════════════════╣
║ Kill Switch: ${killActive ? '🔴 АКТИВЕН' : '🟢 Выключен'}
║ Stop-Day:    ${s.daily.stopDay ? `🔴 ${s.daily.stopDayReason}` : '🟢 Нет'}
║ Режим:       ${config.mode}
║ Demo:        ${config.demoTrading ? 'Да' : 'Нет'}
╠════════════════════════════════════╣
║ Сделок:      ${s.daily.trades} (${s.daily.wins}W/${s.daily.losses}L)
║ Стопов:      ${s.daily.stops}/${config.maxStopsPerDay}
║ P&L день:    $${s.daily.totalPnl.toFixed(2)}
║ Баланс:      ${balanceInfo}
╠════════════════════════════════════╣
║ Позиции:
${posInfo}
╚════════════════════════════════════╝
`);
}

async function main(): Promise<void> {
  state.load();

  if (hasFlag('on') || hasFlag('close-all')) {
    const reason = getArg('reason') ?? 'manual';
    state.activateKillSwitch(reason);
    log.info(`Kill Switch АКТИВИРОВАН: ${reason}`);

    if (hasFlag('close-all')) {
      log.info('Закрываю все позиции...');
      try {
        const result = await closeAllPositions();
        log.info(`Закрыто позиций: ${result.closed}/${result.total}`);
        for (const d of result.details) {
          log.info(`  ${d.symbol}: ${d.result}`);
        }
      } catch (err) {
        log.error(`Ошибка закрытия позиций: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    state.save();
    return;
  }

  if (hasFlag('off')) {
    state.deactivateKillSwitch();
    log.info('Kill Switch ДЕАКТИВИРОВАН');
    state.save();
    return;
  }

  // По умолчанию — статус
  await showStatus();
}

main().catch((err) => {
  log.error(`Критическая ошибка: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
