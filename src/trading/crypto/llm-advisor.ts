import { createLogger } from '../../utils/logger.js';
import { estimateTokens, runClaudeCli } from '../../utils/claude-cli.js';
import { checkLLMBudget, recordLLMCall } from './llm-cost-tracker.js';
import type { TradeSignalInternal } from './market-analyzer.js';
import { loadAllRecentSnapshots, type MarketSnapshot } from './market-snapshot.js';
import * as state from './state.js';
import { isWatched } from './watchlist.js';

const log = createLogger('llm-advisor');

const DAILY_TRADE_TARGET = 3; // Целевое количество сделок в день

export type LLMDecisionType = 'ENTER' | 'SKIP' | 'WAIT';

export interface LLMDecision {
  pair: string;
  decision: LLMDecisionType;
  reason: string;
  confidence: number;
}

function formatSignal(
  sig: TradeSignalInternal,
  snapshots: MarketSnapshot[],
  watched: boolean,
): string {
  const recent = snapshots.slice(-4);
  const scores = recent.map((s) => s.confluenceScore);
  const trend =
    scores.length >= 2
      ? scores[scores.length - 1]! > scores[0]!
        ? 'improving'
        : 'weakening'
      : 'no history';
  const scoreHistory =
    recent.map((s) => `${s.confluenceScore}@${s.timestamp.slice(11, 16)}`).join(', ') || 'none';

  return `**${sig.pair}**${watched ? ' [WATCHED — re-evaluating]' : ''}
Direction: ${sig.side} @ ${sig.entryPrice} | SL=${sig.sl} | TP=${sig.tp} | R:R ${sig.rr}
Confluence: ${sig.confluence.total} (${sig.confluence.signal}) | Confidence: ${sig.confidence}% | Regime: ${sig.regime}
Score history (last 4 cycles): ${scoreHistory} — ${trend}
Key factors: ${sig.confluence.details.slice(0, 4).join(' | ')}`;
}

function buildDailyContext(): string {
  const s = state.get();
  const d = s.daily;
  const hour = new Date().getUTCHours();
  const hoursLeft = 24 - hour;
  const tradesNeeded = Math.max(0, DAILY_TRADE_TARGET - d.trades);
  // Активные торговые сессии: 08-22 UTC (Европа + Америка)
  const isActiveSession = hour >= 8 && hour < 22;
  const urgency =
    tradesNeeded > 0 && hoursLeft <= 8 && isActiveSession
      ? 'HIGH — few trades today, time running out, prefer ENTER over SKIP'
      : tradesNeeded > 0 && hoursLeft <= 16 && isActiveSession
        ? 'MODERATE — still need trades, lean towards ENTER for decent signals'
        : !isActiveSession
          ? 'LOW — Asian session (00-08 UTC), lower liquidity, be more selective'
          : 'NORMAL';

  return `Daily context:
- Trades today: ${d.trades} (target: ${DAILY_TRADE_TARGET}, need ${tradesNeeded} more)
- Day P&L: $${d.totalPnl.toFixed(2)} (wins: ${d.wins}, losses: ${d.losses}, stops: ${d.stops})
- Open positions: ${s.positions.length} / ${3}
- Balance: $${s.balance.total.toFixed(0)} (available: $${s.balance.available.toFixed(0)})
- Hours left in day (UTC): ${hoursLeft}
- Urgency: ${urgency}`;
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

const SYSTEM_PROMPT = `You are a professional crypto futures trading assistant. You review pre-screened signals and make final ENTER/SKIP/WAIT decisions.

Each signal already passed technical filters (confluence scoring, spread/funding, regime detection). Your role: add judgment based on overall context.

Decision rules:
- ENTER: Execute now. Default choice for signals with confluence > 40 and confidence > 60%.
- SKIP: Too weak or risky. Use only when signal clearly deteriorating, regime hostile, or R:R poor.
- WAIT: Needs more data. Adds to 4h watchlist. Max 2 per cycle.

IMPORTANT: You are a TRADER, not a risk manager. Your job is to find opportunities, not avoid all risk. The pre-filters already removed bad setups. If a signal looks decent — ENTER it.

Pay attention to daily context: if few trades have been made today and urgency is HIGH, lower your threshold and favor ENTER.`;

export async function runLLMAdvisorCycle(
  cycleId: string,
  signals: TradeSignalInternal[],
): Promise<LLMDecision[]> {
  if (signals.length === 0) return [];

  // Проверка бюджета LLM
  const budget = await checkLLMBudget();
  if (!budget.allowed) {
    log.warn('LLM budget exceeded — auto-entering all signals', { reason: budget.reason });
    return signals.map((s) => ({
      pair: s.pair,
      decision: 'ENTER' as LLMDecisionType,
      reason: `LLM budget exceeded — auto-enter: ${budget.reason}`,
      confidence: 50,
    }));
  }

  const allSnapshots = loadAllRecentSnapshots(2);
  const dailyContext = buildDailyContext();

  const signalBlocks = signals
    .map((sig) => formatSignal(sig, allSnapshots.get(sig.pair) ?? [], isWatched(sig.pair)))
    .join('\n\n---\n\n');

  const prompt = `${SYSTEM_PROMPT}

---

${dailyContext}

---

Review ${signals.length} trading signal(s) for cycle ${cycleId}:

${signalBlocks}

Respond with ONLY a JSON array (no markdown, no explanation):
[{"pair": "BTCUSDT", "decision": "ENTER|SKIP|WAIT", "reason": "brief reason", "confidence": 0-100}]`;

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
      signals.map((s) => s.pair),
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
    return signals.map((s) => ({
      pair: s.pair,
      decision: 'ENTER' as LLMDecisionType,
      reason: `LLM error fallback: ${(err as Error).message}`,
      confidence: 50,
    }));
  }
}
