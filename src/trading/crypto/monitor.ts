import fs from 'node:fs';
import path from 'node:path';
import { getArg, hasFlag } from '../../utils/args.js';
import { loadEnv } from '../../utils/env.js';
import { createLogger } from '../../utils/logger.js';
import { acquireLock, releaseLock } from '../../utils/lockfile.js';

loadEnv();
import { validateRequiredEnv } from '../../utils/config.js';
import { runMain } from '../../utils/process.js';
import { getBalance, getPositions } from './bybit-client.js';
import config from './config.js';
import {
  generateCycleId,
  getDecisionsBySymbol,
  logDecision,
  rotateIfNeeded,
} from './decision-journal.js';
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

// Claude вызывается каждый цикл, cooldown только для предотвращения перегрузки
const LLM_COOLDOWN_MS = 5 * 60 * 1000; // 5 мин между вызовами
const SKIP_DEDUP_HOURS = 0.25; // 15 мин дедупликация SKIP

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

function isLLMCooldownPassed(): boolean {
  const s = state.get();
  if (!s.lastLLMCycleAt) return true;
  const elapsed = Date.now() - new Date(s.lastLLMCycleAt).getTime();
  return elapsed >= LLM_COOLDOWN_MS;
}

function deduplicateSkippedPairs(
  signals: import('./market-analyzer.js').TradeSignalInternal[],
): import('./market-analyzer.js').TradeSignalInternal[] {
  return signals.filter((sig) => {
    const recentDecisions = getDecisionsBySymbol(sig.pair, SKIP_DEDUP_HOURS);
    const lastSkip = recentDecisions
      .filter((d) => d.action === 'LLM_SKIP' || (d.type === 'skip' && d.action === 'LLM_SKIP'))
      .pop();
    if (!lastSkip) return true;

    const prevScore = lastSkip.data.confluenceScore ?? 0;
    const scoreImproved = Math.abs(sig.confluence.total) - Math.abs(prevScore) >= 10;
    if (scoreImproved) {
      log.info('Re-evaluating previously skipped pair (score improved)', {
        pair: sig.pair,
        prevScore,
        newScore: sig.confluence.total,
      });
      return true;
    }

    log.debug('Dedup: skipping pair (LLM SKIP < 15min ago)', {
      pair: sig.pair,
      skippedAt: lastSkip.timestamp,
    });
    return false;
  });
}

/**
 * Проверяет, есть ли сигналы ПРОТИВ открытых позиций.
 * Если да — Claude должен оценить нужно ли закрывать.
 */
function hasPositionReviewNeeded(
  allSignals: import('./market-analyzer.js').TradeSignalInternal[],
): boolean {
  const s = state.get();
  if (s.positions.length === 0) return false;

  for (const pos of s.positions) {
    const signal = allSignals.find((sig) => sig.pair === pos.symbol);
    if (!signal) continue;

    const isAgainstPosition =
      (pos.side === 'long' && signal.confluence.total < -25) ||
      (pos.side === 'short' && signal.confluence.total > 25);

    if (isAgainstPosition) {
      log.info('Signal against open position detected', {
        symbol: pos.symbol,
        positionSide: pos.side,
        confluenceScore: signal.confluence.total,
      });
      return true;
    }
  }
  return false;
}

async function main(): Promise<void> {
  const startTime = Date.now();
  const cycleId = generateCycleId();
  rotateIfNeeded();

  const envCheck = validateRequiredEnv('crypto');
  if (!envCheck.valid) {
    log.error('Configuration invalid — aborting', { errors: envCheck.errors });
    return;
  }

  const LOCK_FILE = path.join(path.dirname(config.stateFile), 'monitor.lock');
  if (!acquireLock(LOCK_FILE)) {
    log.warn('Monitor cycle skipped — previous still running', { cycleId });
    return;
  }

  try {
    const status = checkStatus();
    if (!status.ok) {
      log.warn('Monitor stopped', { reason: status.reason });
      return;
    }

    await refreshAccount();

    // Position management — каждый цикл (trailing SL, partial close, SL guard)
    await managePositions(cycleId, DRY_RUN);
    if (!DRY_RUN) await cancelStaleOrders();

    // Market analysis — каждый цикл (бесплатно, только Bybit API)
    const allSignals = await analyzeMarket(cycleId, SINGLE_PAIR ?? undefined);
    saveSnapshots(cycleId, allSignals);

    const s = state.get();
    const cooldownOk = isLLMCooldownPassed();

    // Кандидаты на вход (прошедшие confluence фильтр)
    const candidates = deduplicateSkippedPairs(
      allSignals.filter((sig) => sig.confluence.signal !== 'NEUTRAL'),
    );

    // Проверяем нужен ли review позиций (сигнал против)
    const needsReview = hasPositionReviewNeeded(allSignals);

    // Claude вызывается если:
    // 1. Есть кандидаты на вход И cooldown прошёл
    // 2. Есть сигнал против открытой позиции (review)
    // 3. Есть позиции и прошёл cooldown (регулярная проверка)
    const shouldCallClaude =
      cooldownOk && (candidates.length > 0 || needsReview || s.positions.length > 0);

    if (shouldCallClaude) {
      const expired = cleanExpired();
      if (expired > 0) log.info(`Cleaned ${expired} expired watchlist entries`);

      const { decisions, actionResults } = await runLLMAdvisorCycle(
        cycleId,
        candidates,
        allSignals,
        DRY_RUN,
      );

      // Обработка ENTER решений через signal-executor
      const enterSignals = candidates.filter((sig) => {
        const dec = decisions.find((d) => d.pair === sig.pair);
        return dec?.decision === 'ENTER';
      });

      for (const dec of decisions) {
        if (dec.decision === 'WAIT') {
          const sig = candidates.find((si) => si.pair === dec.pair);
          if (sig) addToWatchlist(sig.pair, sig, dec.reason);
        }
        if (dec.decision === 'SKIP') {
          const sig = candidates.find((si) => si.pair === dec.pair);
          logDecision(cycleId, 'skip', dec.pair, 'LLM_SKIP', [dec.reason], {
            ...(sig
              ? {
                  confluenceScore: sig.confluence.total,
                  confluenceSignal: sig.confluence.signal,
                  confidence: sig.confidence,
                  regime: sig.regime,
                }
              : {}),
          });
        }
      }

      // Исполняем ENTER через signal-executor (только если action-executor не сделал это)
      const alreadyEntered = new Set(
        actionResults.filter((r) => r.type === 'ENTER' && r.status === 'OK').map((r) => r.pair),
      );
      const remainingEnters = enterSignals.filter((sig) => !alreadyEntered.has(sig.pair));
      const execResults = await executeSignals(remainingEnters, cycleId, DRY_RUN);

      s.lastLLMCycleAt = new Date().toISOString();

      state.logEvent('llm_cycle', {
        cycleId,
        candidates: candidates.length,
        positions: s.positions.length,
        needsReview,
        enter: enterSignals.length,
        executed: execResults.filter((r) => r.action === 'EXECUTED').length,
        skip: decisions.filter((d) => d.decision === 'SKIP').length,
        wait: decisions.filter((d) => d.decision === 'WAIT').length,
        closes: actionResults.filter((r) => r.type === 'CLOSE' && r.status === 'OK').length,
        modifies: actionResults.filter(
          (r) => (r.type === 'MODIFY_SL' || r.type === 'MODIFY_TP') && r.status === 'OK',
        ).length,
        elapsed: `${((Date.now() - startTime) / 1000).toFixed(1)}s`,
      });

      log.info('Claude cycle complete', {
        cycleId,
        candidates: candidates.length,
        enter: enterSignals.length,
        executed: execResults.filter((r) => r.action === 'EXECUTED').length,
      });
    } else {
      const reasons: string[] = [];
      if (candidates.length === 0 && s.positions.length === 0)
        reasons.push('no signals and no positions');
      if (!cooldownOk) {
        const elapsed = s.lastLLMCycleAt
          ? Math.round((Date.now() - new Date(s.lastLLMCycleAt).getTime()) / 60_000)
          : 0;
        reasons.push(`cooldown ${elapsed}m / ${LLM_COOLDOWN_MS / 60_000}m`);
      }

      log.info('Claude not triggered', {
        cycleId,
        signals: allSignals.length,
        candidates: candidates.length,
        positions: s.positions.length,
        reasons: reasons.join('; '),
      });
    }

    s.lastMonitor = new Date().toISOString();
    state.save();

    // Healthcheck
    const healthFile = path.join(path.dirname(config.stateFile), 'health.json');
    try {
      const healthData = {
        timestamp: new Date().toISOString(),
        cycleId,
        positions: state.get().positions.length,
        balance: state.get().balance.total,
        elapsed: `${((Date.now() - startTime) / 1000).toFixed(1)}s`,
      };
      const tmpHealth = healthFile + '.tmp';
      fs.writeFileSync(tmpHealth, JSON.stringify(healthData), 'utf8');
      fs.renameSync(tmpHealth, healthFile);
    } catch {
      // best effort
    }
  } finally {
    releaseLock(LOCK_FILE);
  }
}

runMain(main, () => state.save());
