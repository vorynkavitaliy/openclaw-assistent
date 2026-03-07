import { createLogger } from '../../utils/logger.js';
import { estimateTokens, runClaudeCli } from '../../utils/claude-cli.js';
import { checkLLMBudget, recordLLMCall } from '../crypto/llm-cost-tracker.js';
import type { ForexAnalysisResult } from './market-analyzer.js';
import { loadAllRecentForexSnapshots } from './market-snapshot.js';
import type { ForexSnapshot } from './market-snapshot.js';
import * as state from './state.js';
import { isWatched } from './watchlist.js';

const log = createLogger('forex-llm-advisor');

const DAILY_TRADE_TARGET = 3;

export type LLMDecisionType = 'ENTER' | 'SKIP' | 'WAIT';

export interface LLMDecision {
  pair: string;
  decision: LLMDecisionType;
  reason: string;
  confidence: number;
}

function formatSignal(
  analysis: ForexAnalysisResult,
  snapshots: ForexSnapshot[],
  watched: boolean,
): string {
  const scores = snapshots.slice(-4).map((s) => s.confluenceScore);
  const trend =
    scores.length >= 2
      ? scores[scores.length - 1]! > scores[0]!
        ? 'improving'
        : 'weakening'
      : 'no history';
  const scoreHistory =
    snapshots
      .slice(-4)
      .map((s) => `${s.confluenceScore}@${s.timestamp.slice(11, 16)}`)
      .join(', ') || 'none';

  return `**${analysis.pair}**${watched ? ' [WATCHED — re-evaluating]' : ''}
Direction: ${analysis.confluenceScore >= 0 ? 'BUY' : 'SELL'} @ ${analysis.lastPrice}
Confluence: ${analysis.confluenceScore} (${analysis.signal}) | Confidence: ${analysis.confidence}% | Regime: ${analysis.regime}
Bias (H4): ${analysis.bias} | ATR(M15): ${analysis.atr.toFixed(5)}
Score history (last 4 cycles): ${scoreHistory} — ${trend}
Key factors: ${analysis.details.slice(0, 4).join(' | ')}`;
}

function buildDailyContext(): string {
  const s = state.getState();
  const hour = new Date().getUTCHours();
  const hoursLeft = 24 - hour;
  const tradesNeeded = Math.max(0, DAILY_TRADE_TARGET - s.tradesCount);

  // Форекс торговые сессии
  const session =
    hour >= 7 && hour < 16
      ? 'London'
      : hour >= 13 && hour < 22
        ? 'New York'
        : hour >= 0 && hour < 9
          ? 'Asian'
          : 'Off-hours';

  const isActiveSession = hour >= 7 && hour < 22;
  const urgency =
    tradesNeeded > 0 && hoursLeft <= 8 && isActiveSession
      ? 'HIGH — few trades today, time running out, prefer ENTER over SKIP'
      : tradesNeeded > 0 && hoursLeft <= 16 && isActiveSession
        ? 'MODERATE — still need trades, lean towards ENTER for decent signals'
        : !isActiveSession
          ? 'LOW — Asian session, lower liquidity for majors, be more selective'
          : 'NORMAL';

  return `Daily context:
- Trades today: ${s.tradesCount} (target: ${DAILY_TRADE_TARGET}, need ${tradesNeeded} more)
- Day P&L: $${s.dailyPnl.toFixed(2)} (wins: ${s.wins}, losses: ${s.losses}, stops: ${s.stopsCount})
- Balance: $${s.accountBalance.toFixed(0)}
- Session: ${session} (${hour}:00 UTC, ${hoursLeft}h left)
- Urgency: ${urgency}
- Account: FTMO demo $10k (max daily DD 4%, max total DD 8%)`;
}

function parseDecisions(content: string, pairs: string[]): LLMDecision[] {
  const match = content.match(/\[[\s\S]*?\]/);
  if (!match) {
    log.warn('LLM response missing JSON array — defaulting to SKIP', {
      preview: content.slice(0, 300),
    });
    return pairs.map((pair) => ({
      pair,
      decision: 'SKIP' as LLMDecisionType,
      reason: 'LLM parse error — defaulting to SKIP',
      confidence: 0,
    }));
  }

  try {
    type RawDecision = { pair: string; decision: string; reason: string; confidence: number };
    const raw = JSON.parse(match[0]) as RawDecision[];
    const valid = new Set<LLMDecisionType>(['ENTER', 'SKIP', 'WAIT']);
    return raw.map((d) => ({
      pair: d.pair,
      decision: valid.has(d.decision as LLMDecisionType) ? (d.decision as LLMDecisionType) : 'SKIP',
      reason: String(d.reason ?? ''),
      confidence: Math.max(0, Math.min(100, Number(d.confidence ?? 50))),
    }));
  } catch {
    log.warn('LLM JSON parse failed — defaulting to SKIP', {
      preview: content.slice(0, 300),
    });
    return pairs.map((pair) => ({
      pair,
      decision: 'SKIP' as LLMDecisionType,
      reason: 'LLM JSON parse error — defaulting to SKIP',
      confidence: 0,
    }));
  }
}

const SYSTEM_PROMPT = `You are a professional forex trading assistant for an FTMO-funded account. You review pre-screened signals and make final ENTER/SKIP/WAIT decisions.

Each signal already passed technical filters (confluence scoring on H4 trend + M15 entry, regime detection). Your role: add judgment based on overall context.

Decision rules:
- ENTER: Execute now. Default choice for signals with confluence > 40 and confidence > 60%.
- SKIP: Too weak or risky. Use only when signal clearly deteriorating, regime hostile, or R:R poor.
- WAIT: Needs more data. Re-evaluate next cycle. Max 2 per cycle.

IMPORTANT constraints (FTMO rules):
- Max daily drawdown: 4% ($400 on $10k)
- Max total drawdown: 8% ($800 on $10k)
- Be conservative if day P&L is already negative
- Avoid trading during low-liquidity Asian session for major pairs
- Prefer London/NY overlap (13-16 UTC) for best fills

You are a TRADER, not a risk manager. The pre-filters already removed bad setups. If a signal looks decent — ENTER it.`;

/**
 * Запускает LLM-советник для форекс сигналов.
 * Event-driven: вызывается только когда есть кандидаты после confluence фильтра.
 */
export async function runForexLLMAdvisor(
  cycleId: string,
  candidates: ForexAnalysisResult[],
): Promise<LLMDecision[]> {
  if (candidates.length === 0) return [];

  const budget = await checkLLMBudget();
  if (!budget.allowed) {
    log.warn('LLM budget exceeded — auto-entering all signals', { reason: budget.reason });
    return candidates.map((c) => ({
      pair: c.pair,
      decision: 'ENTER' as LLMDecisionType,
      reason: `LLM budget exceeded — auto-enter: ${budget.reason}`,
      confidence: 50,
    }));
  }

  const dailyContext = buildDailyContext();
  const allSnapshots = loadAllRecentForexSnapshots(2);

  const signalBlocks = candidates
    .map((c) => formatSignal(c, allSnapshots.get(c.pair) ?? [], isWatched(c.pair)))
    .join('\n\n---\n\n');

  const prompt = `${SYSTEM_PROMPT}

---

${dailyContext}

---

Review ${candidates.length} forex signal(s) for cycle ${cycleId}:

${signalBlocks}

Respond with ONLY a JSON array (no markdown, no explanation):
[{"pair": "EURUSD", "decision": "ENTER|SKIP|WAIT", "reason": "brief reason", "confidence": 0-100}]`;

  try {
    const content = await runClaudeCli(prompt, {
      maxOutput: 2000,
      timeoutMs: 120_000,
    });

    const promptTokens = estimateTokens(prompt);
    const completionTokens = estimateTokens(content);
    const costEntry = recordLLMCall(cycleId, promptTokens, completionTokens, 'advisor');
    log.info('LLM advisor response', {
      cycleId,
      promptTokens,
      completionTokens,
      costUSD: costEntry.costUSD,
    });

    const decisions = parseDecisions(
      content,
      candidates.map((c) => c.pair),
    );
    log.info('LLM decisions', {
      cycleId,
      enter: decisions.filter((d) => d.decision === 'ENTER').length,
      skip: decisions.filter((d) => d.decision === 'SKIP').length,
      wait: decisions.filter((d) => d.decision === 'WAIT').length,
      decisions: decisions.map((d) => `${d.pair}:${d.decision}(${d.confidence}%)`).join(', '),
    });

    return decisions;
  } catch (err) {
    log.error('LLM advisor failed — falling back to auto-enter', {
      error: (err as Error).message,
    });
    return candidates.map((c) => ({
      pair: c.pair,
      decision: 'ENTER' as LLMDecisionType,
      reason: `LLM error fallback: ${(err as Error).message}`,
      confidence: 50,
    }));
  }
}
