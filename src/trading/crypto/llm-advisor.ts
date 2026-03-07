/**
 * LLM Advisor — использует Claude Code CLI (Opus) для торговых решений.
 *
 * Получает полный контекст: все пары, индикаторы, позиции, историю.
 * Claude Code сам анализирует данные и принимает решения ENTER/SKIP/WAIT.
 */

import { createLogger } from '../../utils/logger.js';
import { runClaudeCli } from '../../utils/claude-cli.js';
import { checkLLMBudget } from './llm-cost-tracker.js';
import type { TradeSignalInternal } from './market-analyzer.js';
import { loadAllRecentSnapshots, type MarketSnapshot } from './market-snapshot.js';
import * as state from './state.js';
import { getTradeHistory } from './decision-journal.js';
import { isWatched } from './watchlist.js';

const log = createLogger('llm-advisor');

const DAILY_TRADE_TARGET = 3;

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

  return `**${sig.pair}**${watched ? ' [WATCHED]' : ''}
Side: ${sig.side} @ ${sig.entryPrice} | SL=${sig.sl} | TP=${sig.tp} | R:R=${sig.rr}
Confluence: ${sig.confluence.total} (${sig.confluence.signal}) | Confidence: ${sig.confidence}% | Regime: ${sig.regime}
Score trend (4 cycles): ${scoreHistory} — ${trend}
Details: ${sig.confluence.details.join(' | ')}`;
}

function buildDailyContext(): string {
  const s = state.get();
  const d = s.daily;
  const hour = new Date().getUTCHours();
  const hoursLeft = 24 - hour;
  const tradesNeeded = Math.max(0, DAILY_TRADE_TARGET - d.trades);
  const isActiveSession = hour >= 8 && hour < 22;

  let positions = 'Нет';
  if (s.positions.length > 0) {
    positions = s.positions
      .map(
        (p) =>
          `${p.symbol} ${p.side} size=${p.size} entry=${p.entryPrice} mark=${p.markPrice} PnL=${p.unrealisedPnl} SL=${p.stopLoss ?? 'нет'} TP=${p.takeProfit ?? 'нет'}`,
      )
      .join('\n  ');
  }

  return `ТЕКУЩЕЕ СОСТОЯНИЕ:
- Баланс: $${s.balance.total.toFixed(0)} (доступно: $${s.balance.available.toFixed(0)})
- Позиции (${s.positions.length}/3): ${positions}
- Сегодня: ${d.trades} сделок (цель: ${DAILY_TRADE_TARGET}, нужно ещё: ${tradesNeeded})
- P&L за день: $${d.totalPnl.toFixed(2)} (win=${d.wins}, loss=${d.losses}, stops=${d.stops})
- Время UTC: ${hour}:00, осталось ${hoursLeft}ч
- Сессия: ${isActiveSession ? 'активная (Европа/Америка)' : 'азиатская (низкая ликвидность)'}`;
}

function parseDecisions(content: string, pairs: string[]): LLMDecision[] {
  const match = content.match(/\[[\s\S]*?\]/);
  if (!match) {
    log.warn('Claude response missing JSON array — defaulting to SKIP', {
      preview: content.slice(0, 300),
    });
    return pairs.map((pair) => ({
      pair,
      decision: 'SKIP' as LLMDecisionType,
      reason: 'Parse error — defaulting to SKIP',
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
    log.warn('Claude JSON parse failed — defaulting to SKIP', {
      preview: content.slice(0, 300),
    });
    return pairs.map((pair) => ({
      pair,
      decision: 'SKIP' as LLMDecisionType,
      reason: 'JSON parse error — defaulting to SKIP',
      confidence: 0,
    }));
  }
}

const TRADING_RULES = `Ты — агрессивный крипто-трейдер с опытом. Твоя задача — ЗАРАБАТЫВАТЬ, а не сидеть в стороне.

ПРАВИЛА:
1. Риск: 1% баланса на сделку, макс 3 позиции одновременно
2. SL обязателен. R:R минимум 1.5
3. Не торгуй против СИЛЬНОГО тренда D1/H4 (но контр-тренд на коррекциях — ОК)
4. CHOPPY — можно торговать если есть чёткий уровень
5. Макс 3 стопа в день — после этого стоп-дей
6. Коррелированные пары: SOL+AVAX+SUI = одна группа, ETH+LINK = другая
7. Цель: 2-3 сделки в день. Если 0 сделок за день — ты проигрываешь

КРИТЕРИИ ВХОДА:
- Confluence score > 20 для тренда — УЖЕ достаточно для входа
- Рейндж: score > 25 с чётким уровнем поддержки/сопротивления
- Confidence > 20% — если алгоритм видит сигнал, доверяй ему
- Score improving — бонус, но НЕ обязательно для входа
- Не нужно ждать идеального сетапа — хороший сетап = ENTER

КРИТЕРИИ ОТКАЗА (только эти причины для SKIP):
- Сигнал явно против D1 тренда БЕЗ уровня поддержки
- Funding rate экстремальный в направлении сделки (>0.03%)
- Уже есть 3 позиции или коррелированная пара открыта
- 3 стопа за день
- Score < 15 (совсем мусор)

ВАЖНО: Ты ТРЕЙДЕР-БИЗНЕСМЕН. Каждый пропущенный хороший вход = упущенная прибыль.
Лучше войти с SL и потерять 1%, чем пропустить движение на 5%.
ENTER должен быть твоим DEFAULT решением если нет явных причин для SKIP.

ФОРМАТ ОТВЕТА — ТОЛЬКО JSON массив, без маркдауна, без пояснений:
[{"pair": "BTCUSDT", "decision": "ENTER|SKIP|WAIT", "reason": "краткая причина на русском", "confidence": 0-100}]`;

export async function runLLMAdvisorCycle(
  cycleId: string,
  signals: TradeSignalInternal[],
): Promise<LLMDecision[]> {
  if (signals.length === 0) return [];

  // Проверка бюджета
  const budget = await checkLLMBudget();
  if (!budget.allowed) {
    log.warn('LLM budget exceeded — auto-entering top signals', { reason: budget.reason });
    return signals
      .filter((s) => Math.abs(s.confluence.total) >= 35 && s.confidence >= 40)
      .map((s) => ({
        pair: s.pair,
        decision: 'ENTER' as LLMDecisionType,
        reason: `Budget exceeded, auto-enter: ${budget.reason}`,
        confidence: s.confidence,
      }));
  }

  const allSnapshots = loadAllRecentSnapshots(2);
  const dailyContext = buildDailyContext();
  const tradeHistory = getTradeHistory(20);

  const signalBlocks = signals
    .map((sig) => formatSignal(sig, allSnapshots.get(sig.pair) ?? [], isWatched(sig.pair)))
    .join('\n\n---\n\n');

  const prompt = `${TRADING_RULES}

---

${dailyContext}

---

ИСТОРИЯ СДЕЛОК (учись на ошибках и успехах):
${tradeHistory}

---

Анализ ${signals.length} пар (цикл ${cycleId}):

${signalBlocks}

Ответь ТОЛЬКО JSON массивом. Решение для КАЖДОЙ пары из списка.`;

  try {
    log.info('Calling Claude Code for trading decisions', {
      cycleId,
      pairs: signals.map((s) => s.pair).join(', '),
    });

    const content = await runClaudeCli(prompt, {
      maxOutput: 4000,
      timeoutMs: 180_000, // 3 мин макс
      stream: false, // не стримить в Telegram (это фоновый процесс)
      useSession: false, // каждый цикл — чистый контекст
    });

    log.info('Claude Code response received', {
      cycleId,
      responseLength: content.length,
    });

    const decisions = parseDecisions(
      content,
      signals.map((s) => s.pair),
    );

    log.info('Trading decisions', {
      cycleId,
      enter: decisions.filter((d) => d.decision === 'ENTER').length,
      skip: decisions.filter((d) => d.decision === 'SKIP').length,
      wait: decisions.filter((d) => d.decision === 'WAIT').length,
      decisions: decisions.map((d) => `${d.pair}:${d.decision}(${d.confidence}%)`).join(', '),
    });

    return decisions;
  } catch (err) {
    log.error('Claude Code advisor failed — falling back to score-based', {
      error: (err as Error).message,
    });
    // Fallback: входим в сильные сигналы автоматически
    return signals
      .filter((s) => Math.abs(s.confluence.total) >= 40 && s.confidence >= 50)
      .map((s) => ({
        pair: s.pair,
        decision: 'ENTER' as LLMDecisionType,
        reason: `Claude Code unavailable, auto-enter strong signal`,
        confidence: s.confidence,
      }));
  }
}
