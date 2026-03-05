import { getArg, hasFlag } from '../../utils/args.js';
import { createLogger } from '../../utils/logger.js';
import { runMain } from '../../utils/process.js';
import { getBalance, getPositions } from './bybit-client.js';
import config from './config.js';
import { generateCycleId, logDecision, rotateIfNeeded } from './decision-journal.js';
import { runLLMAdvisorCycle } from './llm-advisor.js';
import { analyzeMarket } from './market-analyzer.js';
import { saveSnapshots } from './market-snapshot.js';
import { managePositions } from './position-manager.js';
import { cancelStaleOrders, executeSignals } from './signal-executor.js';
import * as state from './state.js';
import { addToWatchlist, cleanExpired, removeFromWatchlist } from './watchlist.js';

const log = createLogger('crypto-monitor');

const DRY_RUN = hasFlag('dry-run') || config.mode !== 'execute';
const SINGLE_PAIR = getArg('pair');

const LLM_INTERVAL_MS = 1 * 60 * 60 * 1000; // 1 hour
const FIRST_RUN_DELAY_MS = 30 * 60 * 1000; // 30 min (3 cycles of data before first LLM)

// Fast-track: сигналы выше этих порогов исполняются немедленно, без ожидания LLM
const FAST_TRACK_CONFLUENCE = 65;
const FAST_TRACK_CONFIDENCE = 75;

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
  if (!s.lastLLMCycleAt) return false;
  const elapsed = Date.now() - new Date(s.lastLLMCycleAt).getTime();
  return elapsed >= LLM_INTERVAL_MS;
}

function isFirstRunReady(): boolean {
  const s = state.get();
  if (!s.lastLLMCycleAt) return false;
  // Первый LLM-цикл через 30 мин вместо полного интервала
  const elapsed = Date.now() - new Date(s.lastLLMCycleAt).getTime();
  return elapsed >= FIRST_RUN_DELAY_MS;
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

  // First run ever: set timer, skip execution (нет исторических данных)
  if (!s.lastLLMCycleAt) {
    s.lastLLMCycleAt = new Date().toISOString();
    log.info('First monitor run — data collected, LLM activates in 30 min', {
      signals: signals.length,
      cycleId,
    });
    state.save();
    return;
  }

  // === FAST-TRACK: сильные сигналы исполняются сразу, не ждут LLM ===
  const fastTrack = signals.filter(
    (sig) =>
      Math.abs(sig.confluence.total) >= FAST_TRACK_CONFLUENCE &&
      sig.confidence >= FAST_TRACK_CONFIDENCE,
  );
  const normalSignals = signals.filter(
    (sig) =>
      Math.abs(sig.confluence.total) < FAST_TRACK_CONFLUENCE ||
      sig.confidence < FAST_TRACK_CONFIDENCE,
  );

  if (fastTrack.length > 0 && !DRY_RUN) {
    for (const sig of fastTrack) {
      logDecision(cycleId, 'entry', sig.pair, 'FAST_TRACK', [
        `Confluence ${sig.confluence.total} >= ${FAST_TRACK_CONFLUENCE}, confidence ${sig.confidence}% >= ${FAST_TRACK_CONFIDENCE}%`,
        `Bypass LLM — immediate execution`,
      ]);
      // Если пара была на watchlist — убираем
      removeFromWatchlist(sig.pair);
    }

    const fastResults = await executeSignals(fastTrack, cycleId, DRY_RUN);
    const executed = fastResults.filter((r) => r.action === 'EXECUTED').length;

    if (executed > 0) {
      log.info('Fast-track executed', {
        cycleId,
        candidates: fastTrack.length,
        executed,
        pairs: fastTrack.map((s) => s.pair).join(', '),
      });
    }
  }

  // === LLM CYCLE: каждый час (или через 30 мин для первого запуска) ===
  const isReady = shouldRunLLMCycle() || isFirstRunReady();

  if (isReady && normalSignals.length > 0) {
    const expired = cleanExpired();
    if (expired > 0) log.info(`Cleaned ${expired} expired watchlist entries`);

    const llmDecisions = await runLLMAdvisorCycle(cycleId, normalSignals);

    const enterSignals = normalSignals.filter((sig) => {
      const dec = llmDecisions.find((d) => d.pair === sig.pair);
      return !dec || dec.decision === 'ENTER';
    });

    for (const dec of llmDecisions) {
      if (dec.decision === 'WAIT') {
        const sig = normalSignals.find((si) => si.pair === dec.pair);
        if (sig) addToWatchlist(sig.pair, sig, dec.reason);
      }
    }

    const execResults = await executeSignals(enterSignals, cycleId, DRY_RUN);

    s.lastLLMCycleAt = new Date().toISOString();

    state.logEvent('llm_cycle', {
      cycleId,
      signals: normalSignals.length,
      fastTrack: fastTrack.length,
      enter: enterSignals.length,
      executed: execResults.filter((r) => r.action === 'EXECUTED').length,
      skip: llmDecisions.filter((d) => d.decision === 'SKIP').length,
      wait: llmDecisions.filter((d) => d.decision === 'WAIT').length,
      elapsed: `${((Date.now() - startTime) / 1000).toFixed(1)}s`,
    });

    log.info('LLM cycle complete', {
      cycleId,
      signals: normalSignals.length,
      fastTrack: fastTrack.length,
      enter: enterSignals.length,
      executed: execResults.filter((r) => r.action === 'EXECUTED').length,
    });
  } else if (isReady && normalSignals.length === 0) {
    // LLM cycle ready but no normal signals — just update timer
    s.lastLLMCycleAt = new Date().toISOString();
    log.info('LLM cycle — no candidates after fast-track', { cycleId });
  } else {
    const elapsed = Date.now() - new Date(s.lastLLMCycleAt).getTime();
    const nextLLMInMin = Math.round((LLM_INTERVAL_MS - elapsed) / 60_000);

    log.info('Data collection cycle', {
      cycleId,
      signals: signals.length,
      fastTrack: fastTrack.length,
      nextLLMInMin: Math.max(0, nextLLMInMin),
    });
  }

  s.lastMonitor = new Date().toISOString();
  state.save();
}

runMain(main, () => state.save());
