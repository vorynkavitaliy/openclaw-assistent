import { getArg, hasFlag } from '../../utils/args.js';
import { createLogger } from '../../utils/logger.js';
import { runMain } from '../../utils/process.js';
import { cancelAllOrders, closeAllPositions, getBalance, getPositions } from './bybit-client.js';
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

  log.info('Trading status', {
    killSwitch: killActive,
    stopDay: s.daily.stopDay,
    stopDayReason: s.daily.stopDayReason,
    mode: config.mode,
    demo: config.demoTrading,
    trades: s.daily.trades,
    wins: s.daily.wins,
    losses: s.daily.losses,
    stops: `${s.daily.stops}/${config.maxStopsPerDay}`,
    pnlToday: s.daily.totalPnl,
    balance: balanceInfo,
    positions: posInfo,
  });
}

async function main(): Promise<void> {
  state.load();

  if (hasFlag('on') || hasFlag('close-all')) {
    const reason = getArg('reason') ?? 'manual';
    state.activateKillSwitch(reason);
    log.info(`Kill Switch ACTIVATED: ${reason}`);

    if (hasFlag('close-all')) {
      // Сначала отменяем ВСЕ pending ордера (включая grid-уровни)
      try {
        const cancelled = await cancelAllOrders();
        log.info(`Pending orders cancelled: ${cancelled}`);
      } catch (err) {
        log.error(`Error cancelling orders: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Затем закрываем позиции
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
