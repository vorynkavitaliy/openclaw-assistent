import { getArg, hasFlag } from '../../utils/args.js';
import { createLogger } from '../../utils/logger.js';
import { runMain } from '../../utils/process.js';
import { closeAllPositions, getBalance, getPositions } from './bybit-client.js';
import config from './config.js';
import * as state from './state.js';

const log = createLogger('killswitch');

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
    balanceInfo = 'unavailable';
  }

  try {
    const positions = await getPositions();
    posInfo =
      positions.length > 0
        ? positions.map((p) => `  ${p.symbol} ${p.side} ${p.size} @ ${p.entryPrice}`).join('\n')
        : '  No open positions';
  } catch {
    posInfo = '  Failed to fetch';
  }

  console.log(`
╔════════════════════════════════════╗
║      CRYPTO TRADING STATUS        ║
╠════════════════════════════════════╣
║ Kill Switch: ${killActive ? '🔴 ACTIVE' : '🟢 Off'}
║ Stop-Day:    ${s.daily.stopDay ? `🔴 ${s.daily.stopDayReason}` : '🟢 No'}
║ Mode:        ${config.mode}
║ Demo:        ${config.demoTrading ? 'Yes' : 'No'}
╠════════════════════════════════════╣
║ Trades:      ${s.daily.trades} (${s.daily.wins}W/${s.daily.losses}L)
║ Stops:       ${s.daily.stops}/${config.maxStopsPerDay}
║ P&L today:   $${s.daily.totalPnl.toFixed(2)}
║ Balance:     ${balanceInfo}
╠════════════════════════════════════╣
║ Positions:
${posInfo}
╚════════════════════════════════════╝
`);
}

async function main(): Promise<void> {
  state.load();

  if (hasFlag('on') || hasFlag('close-all')) {
    const reason = getArg('reason') ?? 'manual';
    state.activateKillSwitch(reason);
    log.info(`Kill Switch ACTIVATED: ${reason}`);

    if (hasFlag('close-all')) {
      log.info('Closing all positions...');
      try {
        const result = await closeAllPositions();
        log.info(`Positions closed: ${result.closed}/${result.total}`);
        for (const d of result.details) {
          log.info(`  ${d.symbol}: ${d.result}`);
        }
      } catch (err) {
        log.error(`Error closing positions: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    state.save();
    return;
  }

  if (hasFlag('off')) {
    state.deactivateKillSwitch();
    log.info('Kill Switch DEACTIVATED');
    state.save();
    return;
  }

  await showStatus();
}

runMain(main, () => state.save());
