/**
 * LLM Advisor — использует Claude Code CLI для торговых решений.
 *
 * Claude получает полный контекст: позиции, рынок, баланс, историю.
 * Принимает решения: ENTER, CLOSE, MODIFY_SL, MODIFY_TP, SKIP, WAIT.
 */

import { createLogger } from '../../utils/logger.js';
import { runClaudeCli } from '../../utils/claude-cli.js';
import { sendTelegram } from '../../utils/telegram.js';
import type { TradeSignalInternal } from './market-analyzer.js';
import { buildTraderContext, buildSystemPrompt } from './claude-trader-context.js';
import {
  parseClaudeResponse,
  executeClaudeActions,
  type ClaudeResponse,
  type ActionResult,
} from './claude-action-executor.js';
import * as state from './state.js';

const log = createLogger('llm-advisor');

// Re-export для обратной совместимости
export type LLMDecisionType = 'ENTER' | 'SKIP' | 'WAIT';

export interface LLMDecision {
  pair: string;
  decision: LLMDecisionType;
  reason: string;
  confidence: number;
}

/**
 * Запускает цикл Claude-трейдера.
 * Получает ВСЕ сигналы рынка (не только прошедшие фильтр) + текущие позиции.
 * Возвращает LLMDecision[] для обратной совместимости с monitor.ts.
 */
export async function runLLMAdvisorCycle(
  cycleId: string,
  candidateSignals: TradeSignalInternal[],
  allSignals: TradeSignalInternal[] = candidateSignals,
  dryRun: boolean = false,
): Promise<{ decisions: LLMDecision[]; actionResults: ActionResult[] }> {
  const s = state.get();
  const pairs = [...candidateSignals.map((s) => s.pair), ...s.positions.map((p) => p.symbol)];
  const uniquePairs = [...new Set(pairs)];

  if (candidateSignals.length === 0 && s.positions.length === 0) {
    return { decisions: [], actionResults: [] };
  }

  const systemPrompt = buildSystemPrompt();
  const traderContext = buildTraderContext(candidateSignals, allSignals);

  const prompt = `${systemPrompt}

---

${traderContext}

Проанализируй ситуацию и верни JSON с решениями. Для каждого кандидата на вход — ENTER/SKIP/WAIT. Для каждой открытой позиции — оцени нужно ли CLOSE или MODIFY_SL/TP.`;

  try {
    log.info('Calling Claude for trading decisions', {
      cycleId,
      candidates: candidateSignals.length,
      positions: s.positions.length,
      pairs: uniquePairs.join(', '),
    });

    const content = await runClaudeCli(prompt, {
      maxOutput: 4000,
      timeoutMs: 180_000,
      stream: false,
      useSession: false,
    });

    log.info('Claude response received', {
      cycleId,
      responseLength: content.length,
    });

    // Парсим ответ
    const response: ClaudeResponse = parseClaudeResponse(content, uniquePairs);

    // Исполняем действия
    const actionResults = await executeClaudeActions(response, candidateSignals, cycleId, dryRun);

    // Конвертируем в LLMDecision для обратной совместимости
    const decisions: LLMDecision[] = response.actions
      .filter((a) => ['ENTER', 'SKIP', 'WAIT'].includes(a.type))
      .map((a) => ({
        pair: a.pair,
        decision: a.type as LLMDecisionType,
        reason: a.reason,
        confidence: a.confidence ?? 50,
      }));

    // Логируем summary в Telegram
    const enterCount = actionResults.filter((r) => r.type === 'ENTER' && r.status === 'OK').length;
    const closeCount = actionResults.filter((r) => r.type === 'CLOSE' && r.status === 'OK').length;
    const modifyCount = actionResults.filter(
      (r) => (r.type === 'MODIFY_SL' || r.type === 'MODIFY_TP') && r.status === 'OK',
    ).length;

    if (enterCount > 0 || closeCount > 0 || modifyCount > 0) {
      const parts = [];
      if (enterCount > 0) parts.push(`📈 ${enterCount} вход`);
      if (closeCount > 0) parts.push(`📉 ${closeCount} закрытие`);
      if (modifyCount > 0) parts.push(`🔧 ${modifyCount} модификация`);
      await sendTelegram(`🤖 Claude: ${parts.join(', ')}\n${response.summary}`);
    }

    log.info('Claude cycle complete', {
      cycleId,
      summary: response.summary,
      enter: decisions.filter((d) => d.decision === 'ENTER').length,
      skip: decisions.filter((d) => d.decision === 'SKIP').length,
      wait: decisions.filter((d) => d.decision === 'WAIT').length,
      closes: closeCount,
      modifies: modifyCount,
      decisions: decisions.map((d) => `${d.pair}:${d.decision}(${d.confidence}%)`).join(', '),
    });

    return { decisions, actionResults };
  } catch (err) {
    log.error('Claude advisor failed — falling back to score-based', {
      error: (err as Error).message,
    });
    // Fallback: входим в сильные сигналы автоматически
    const decisions: LLMDecision[] = candidateSignals
      .filter((s) => Math.abs(s.confluence.total) >= 40 && s.confidence >= 50)
      .map((s) => ({
        pair: s.pair,
        decision: 'ENTER' as LLMDecisionType,
        reason: 'Claude unavailable, auto-enter strong signal',
        confidence: s.confidence,
      }));
    return { decisions, actionResults: [] };
  }
}
