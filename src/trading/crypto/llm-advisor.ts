import { createLogger } from '../../utils/logger.js';
import type { TradeSignalInternal } from './market-analyzer.js';
import { loadAllRecentSnapshots, type MarketSnapshot } from './market-snapshot.js';
import { isWatched } from './watchlist.js';

const log = createLogger('llm-advisor');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'anthropic/claude-sonnet-4';

export type LLMDecisionType = 'ENTER' | 'SKIP' | 'WAIT';

export interface LLMDecision {
  pair: string;
  decision: LLMDecisionType;
  reason: string;
  confidence: number;
}

interface OpenRouterResponse {
  choices: Array<{ message: { content: string } }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

interface ChatMessage {
  role: string;
  content: string;
}

function getApiKey(): string {
  return process.env.OPENROUTER_API_KEY ?? '';
}

async function callOpenRouter(
  messages: ChatMessage[],
): Promise<{ content: string; promptTokens: number; completionTokens: number }> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not configured');

  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/openclaw/crypto-trader',
      'X-Title': 'OpenClaw Crypto Trader',
    },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: 1024, temperature: 0.1 }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as OpenRouterResponse;
  return {
    content: data.choices[0]?.message?.content ?? '',
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
  };
}

function formatSignal(
  sig: TradeSignalInternal,
  snapshots: MarketSnapshot[],
  watched: boolean,
): string {
  const scores = snapshots.map((s) => s.confluenceScore);
  const trend =
    scores.length >= 2
      ? scores[scores.length - 1]! > scores[0]!
        ? 'improving'
        : 'weakening'
      : 'no history';
  const scoreHistory = scores.slice(-4).join(', ') || 'none';

  return `**${sig.pair}**${watched ? ' [WATCHED — re-evaluating]' : ''}
Direction: ${sig.side} @ ${sig.entryPrice} | SL=${sig.sl} | TP=${sig.tp} | R:R ${sig.rr}
Confluence: ${sig.confluence.total} (${sig.confluence.signal}) | Confidence: ${sig.confidence}% | Regime: ${sig.regime}
Score history (last 4 cycles): ${scoreHistory} — ${trend}
Key factors: ${sig.confluence.details.slice(0, 4).join(' | ')}`;
}

function parseDecisions(content: string, pairs: string[]): LLMDecision[] {
  const match = content.match(/\[[\s\S]*?\]/);
  if (!match) {
    log.warn('LLM response missing JSON array', { preview: content.slice(0, 300) });
    return pairs.map((pair) => ({
      pair,
      decision: 'SKIP' as LLMDecisionType,
      reason: 'parse error — defaulting to SKIP',
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
    log.warn('LLM JSON parse failed', { preview: content.slice(0, 300) });
    return pairs.map((pair) => ({
      pair,
      decision: 'SKIP' as LLMDecisionType,
      reason: 'JSON parse error — defaulting to SKIP',
      confidence: 0,
    }));
  }
}

const SYSTEM_PROMPT = `You are a professional crypto futures trading assistant reviewing pre-screened signals.

Each signal passed technical filters (confluence scoring, spread/funding checks, regime detection). Your role: final ENTER/SKIP/WAIT judgment.

Decision guide:
- ENTER: Strong signal, execute now. Use when confluence > 45, improving trend, matches regime.
- SKIP: Pass this cycle. Use when signal is weak, deteriorating, or risk too high.
- WAIT: Has potential but needs confirmation. Adds to 4h watchlist. Use sparingly (max 2/cycle).

Default to ENTER for strong signals (confluence > 50, confidence > 65%). Be decisive.`;

export async function runLLMAdvisorCycle(
  cycleId: string,
  signals: TradeSignalInternal[],
): Promise<LLMDecision[]> {
  if (signals.length === 0) return [];

  if (!getApiKey()) {
    log.warn('No OPENROUTER_API_KEY — auto-entering all signals');
    return signals.map((s) => ({
      pair: s.pair,
      decision: 'ENTER' as LLMDecisionType,
      reason: 'LLM not configured — auto-enter',
      confidence: 50,
    }));
  }

  const allSnapshots = loadAllRecentSnapshots(2);
  const signalBlocks = signals
    .map((sig) => formatSignal(sig, allSnapshots.get(sig.pair) ?? [], isWatched(sig.pair)))
    .join('\n\n---\n\n');

  const userPrompt = `Review ${signals.length} trading signal(s) for cycle ${cycleId}:\n\n${signalBlocks}\n\nRespond with ONLY a JSON array:\n[{"pair": "BTCUSDT", "decision": "ENTER|SKIP|WAIT", "reason": "...", "confidence": 0-100}]`;

  try {
    const { content, promptTokens, completionTokens } = await callOpenRouter([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ]);

    const estimatedCostUSD = ((promptTokens * 3 + completionTokens * 15) / 1_000_000).toFixed(4);
    log.info('LLM advisor response', {
      cycleId,
      promptTokens,
      completionTokens,
      estimatedCostUSD,
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
    // Fallback: enter all signals (same as pre-LLM behavior)
    return signals.map((s) => ({
      pair: s.pair,
      decision: 'ENTER' as LLMDecisionType,
      reason: `LLM error fallback: ${(err as Error).message}`,
      confidence: 50,
    }));
  }
}
