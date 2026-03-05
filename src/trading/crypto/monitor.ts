import { getArg, hasFlag } from '../../utils/args.js';
import { createLogger } from '../../utils/logger.js';
import { runMain } from '../../utils/process.js';
import { getBalance, getPositions } from './bybit-client.js';
import config from './config.js';
import { generateCycleId, rotateIfNeeded } from './decision-journal.js';
import { runLLMAdvisorCycle } from './llm-advisor.js';
import { analyzeMarket } from './market-analyzer.js';
import { saveSnapshots } from './market-snapshot.js';
import { managePositions } from './position-manager.js';
import { cancelStaleOrders, executeSignals } from './signal-executor.js';
import * as state from './state.js';
import { addToWatchlist, cleanExpired } from './watchlist.js';

const log = createLogger('crypto-monitor');

const DRY_RUN = hasFlag('dry-run') || config.mode !== 'execute';
const SINGLE_PAIR = getArg('pair');
const LLM_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours

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

  state.checkDayLimits();
}

function shouldRunLLMCycle(): boolean {
  const s = state.get();
  if (!s.lastLLMCycleAt) return false; // First run: collect data only
  const elapsed = Date.now() - new Date(s.lastLLMCycleAt).getTime();
  return elapsed >= LLM_INTERVAL_MS;
}

async function main(): Promise<void> {
  const startTime = Date.now();
  const cycleId = generateCycleId();
  rotateIfNeeded();

  const status = checkStatus();
  if (!status.ok) {
    log.warn('Monitor stopped', { reason: status.reason });
    return;
  }

  await refreshAccount();

  // Position management runs every cycle (10 min)
  await managePositions(cycleId, DRY_RUN);
  if (!DRY_RUN) await cancelStaleOrders();

  // Market analysis — every cycle
  const signals = await analyzeMarket(cycleId, SINGLE_PAIR ?? undefined);
  saveSnapshots(cycleId, signals);

  const s = state.get();

  // First run: initialise LLM timer, skip execution (no historical data yet)
  if (!s.lastLLMCycleAt) {
    s.lastLLMCycleAt = new Date().toISOString();
    log.info('First monitor run — data collected, LLM advisor activates in 2h', {
      signals: signals.length,
      cycleId,
    });
    state.save();
    return;
  }

  // LLM advisory cycle every 2h
  if (shouldRunLLMCycle()) {
    const expired = cleanExpired();
    if (expired > 0) log.info(`Cleaned ${expired} expired watchlist entries`);

    const llmDecisions = await runLLMAdvisorCycle(cycleId, signals);

    // Separate ENTER from WAIT/SKIP
    const enterSignals = signals.filter((sig) => {
      const dec = llmDecisions.find((d) => d.pair === sig.pair);
      // If LLM has no opinion on this pair (pair count mismatch), default to ENTER
      return !dec || dec.decision === 'ENTER';
    });

    // Add WAIT pairs to watchlist
    for (const dec of llmDecisions) {
      if (dec.decision === 'WAIT') {
        const sig = signals.find((si) => si.pair === dec.pair);
        if (sig) addToWatchlist(sig.pair, sig, dec.reason);
      }
    }

    const execResults = await executeSignals(enterSignals, cycleId, DRY_RUN);

    s.lastLLMCycleAt = new Date().toISOString();

    state.logEvent('llm_cycle', {
      cycleId,
      signals: signals.length,
      enter: enterSignals.length,
      executed: execResults.filter((r) => r.action === 'EXECUTED').length,
      skip: llmDecisions.filter((d) => d.decision === 'SKIP').length,
      wait: llmDecisions.filter((d) => d.decision === 'WAIT').length,
      elapsed: `${((Date.now() - startTime) / 1000).toFixed(1)}s`,
    });

    log.info('LLM cycle complete', {
      cycleId,
      signals: signals.length,
      enter: enterSignals.length,
      executed: execResults.filter((r) => r.action === 'EXECUTED').length,
      skip: llmDecisions.filter((d) => d.decision === 'SKIP').length,
      wait: llmDecisions.filter((d) => d.decision === 'WAIT').length,
    });
  } else {
    // Data collection cycle (every 10 min between LLM cycles)
    const elapsed = Date.now() - new Date(s.lastLLMCycleAt).getTime();
    const nextLLMInMin = Math.round((LLM_INTERVAL_MS - elapsed) / 60_000);

    log.info('Data collection cycle', {
      cycleId,
      signals: signals.length,
      nextLLMInMin,
    });
  }

  s.lastMonitor = new Date().toISOString();
  state.save();
}

runMain(main, () => state.save());
