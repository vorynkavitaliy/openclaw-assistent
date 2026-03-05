import { getArg, hasFlag } from '../../utils/args.js';
import { createLogger } from '../../utils/logger.js';
import { runMain } from '../../utils/process.js';
import { getBalance, getPositions } from './bybit-client.js';
import config from './config.js';
import { generateCycleId, rotateIfNeeded } from './decision-journal.js';
import { analyzeMarket } from './market-analyzer.js';
import { managePositions } from './position-manager.js';
import { cancelStaleOrders, executeSignals } from './signal-executor.js';
import * as state from './state.js';

const log = createLogger('crypto-monitor');

const DRY_RUN = hasFlag('dry-run') || config.mode !== 'execute';
const SINGLE_PAIR = getArg('pair');

function checkStatus(): { ok: boolean; reason: string } {
  state.load();

  if (state.isKillSwitchActive()) {
    return { ok: false, reason: 'KILL_SWITCH active' };
  }

  const s = state.get();
  if (s.daily.stopDay) {
    return { ok: false, reason: `STOP_DAY: ${s.daily.stopDayReason}` };
  }

  return { ok: true, reason: 'OK' };
}

async function refreshAccount(): Promise<void> {
  try {
    const balance = await getBalance();
    state.updateBalance({
      totalEquity: String(balance.totalEquity),
      totalWalletBalance: String(balance.totalWalletBalance),
      totalAvailableBalance: String(balance.availableBalance),
      totalPerpUPL: String(balance.unrealisedPnl),
    });
  } catch (err) {
    log.warn('Failed to get balance', { error: (err as Error).message });
  }

  try {
    const positions = await getPositions();
    state.updatePositions(
      positions.map((p) => ({
        symbol: p.symbol,
        side: p.side,
        size: p.size,
        entryPrice: p.entryPrice,
        markPrice: p.markPrice,
        unrealisedPnl: p.unrealisedPnl,
        leverage: p.leverage,
        stopLoss: p.stopLoss,
        takeProfit: p.takeProfit,
      })),
    );
  } catch (err) {
    log.warn('Failed to get positions', { error: (err as Error).message });
  }

  // Проверяем дневные лимиты с учётом unrealized P&L
  state.checkDayLimits();
}

async function main(): Promise<void> {
  const startTime = Date.now();
  const cycleId = generateCycleId();
  rotateIfNeeded();

  const report: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    mode: DRY_RUN ? 'dry-run' : 'execute',
    cycleId,
  };

  const status = checkStatus();
  report.status = status;
  if (!status.ok) {
    report.result = 'STOPPED';
    log.warn('Monitor stopped', { reason: status.reason });
    return;
  }

  await refreshAccount();
  report.balance = state.get().balance;
  report.openPositions = state.get().positions.length;

  const posActions = await managePositions(cycleId, DRY_RUN);
  report.positionActions = posActions;

  // Отменяем зависшие лимитные ордера перед анализом
  const staleActions = DRY_RUN ? [] : await cancelStaleOrders();
  report.staleOrdersCancelled = staleActions;

  const signals = await analyzeMarket(cycleId, SINGLE_PAIR ?? undefined);
  report.signals = signals;

  const execResults = await executeSignals(signals, cycleId, DRY_RUN);
  report.execution = execResults;

  const s = state.get();
  s.lastMonitor = new Date().toISOString();
  state.save();

  report.daily = s.daily;
  report.elapsed = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
  report.result = 'OK';

  state.logEvent('monitor', {
    signals: signals.length,
    executed: execResults.filter((r) => r.action === 'EXECUTED').length,
    positions: s.positions.length,
    mode: DRY_RUN ? 'dry-run' : 'execute',
    topSignals: signals.slice(0, 3).map((sig) => ({
      pair: sig.pair,
      score: sig.confluence.total,
      signal: sig.confluence.signal,
      regime: sig.regime,
    })),
  });

  log.info('Monitor cycle complete', report);
}

runMain(main, () => state.save());
