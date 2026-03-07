import { createLogger } from '../../utils/logger.js';
import { estimateTokens, runClaudeCli } from '../../utils/claude-cli.js';
import { recordLLMCall } from './llm-cost-tracker.js';
import * as state from './state.js';

const log = createLogger('llm-chat');

const SYSTEM_PROMPT = `Ты — AI-помощник крипто-трейдера. Ты управляешь автоматической торговлей фьючерсами на Bybit.

Контекст системы:
- 12 пар: BTC, ETH, SOL, XRP, DOGE, AVAX, LINK, ADA, DOT, MATIC, ARB, OP (USDT linear)
- Мониторинг каждые 5 мин через cron
- Confluence scoring (-100..+100) по 6 модулям: тренд, моментум, объём, структура, orderflow, режим
- LLM (Claude) принимает финальные решения ENTER/SKIP/WAIT
- Риск: 2% на сделку, max 3 позиции, max $500 дневной убыток, SL обязателен
- Partial close at 1R (50%), trailing SL at 1.5R

Ты отвечаешь на вопросы о рынке, позициях, стратегии. Отвечай кратко и по делу, на русском.`;

export async function chatWithLLM(userPrompt: string): Promise<string> {
  // Загружаем актуальное состояние
  state.load();

  const s = state.get();
  const d = s.daily;
  const contextBlock = `\n\nТекущее состояние:
- Баланс: $${s.balance.total.toFixed(0)} (доступно: $${s.balance.available.toFixed(0)})
- Позиции: ${s.positions.length}/3${s.positions.length > 0 ? '\n' + s.positions.map((p) => `  ${p.symbol} ${p.side} size=${p.size} entry=${p.entryPrice} mark=${p.markPrice} PnL=${p.unrealisedPnl} SL=${p.stopLoss ?? 'нет'} TP=${p.takeProfit ?? 'нет'}`).join('\n') : ''}
- Сегодня: ${d.trades} сделок, P&L $${d.totalPnl.toFixed(2)}, wins=${d.wins}, losses=${d.losses}
- Kill switch: ${state.isKillSwitchActive() ? 'АКТИВЕН' : 'выкл'}`;

  const prompt = `${SYSTEM_PROMPT}${contextBlock}

Вопрос пользователя: ${userPrompt}`;

  try {
    const content = await runClaudeCli(prompt, {
      maxOutput: 4000,
      timeoutMs: 300_000,
    });

    const promptTokens = estimateTokens(prompt);
    const completionTokens = estimateTokens(content);
    const costEntry = recordLLMCall('chat', promptTokens, completionTokens, 'chat');
    log.info('LLM chat response', {
      promptLen: userPrompt.length,
      responseLen: content.length,
      costUSD: costEntry.costUSD,
    });

    return content || 'LLM вернул пустой ответ';
  } catch (err: unknown) {
    log.error('LLM chat failed', { error: (err as Error).message });
    return `Ошибка: ${(err as Error).message}`;
  }
}
