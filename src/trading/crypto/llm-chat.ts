import { createLogger } from '../../utils/logger.js';
import { recordLLMCall } from './llm-cost-tracker.js';
import * as state from './state.js';

const log = createLogger('llm-chat');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'anthropic/claude-sonnet-4';

const SYSTEM_PROMPT = `Ты — AI-помощник крипто-трейдера. Ты управляешь автоматической торговлей фьючерсами на Bybit.

Контекст системы:
- 12 пар: BTC, ETH, SOL, XRP, DOGE, AVAX, LINK, ADA, DOT, MATIC, ARB, OP (USDT linear)
- Мониторинг каждые 5 мин через cron
- Confluence scoring (-100..+100) по 6 модулям: тренд, моментум, объём, структура, orderflow, режим
- LLM (Claude Sonnet) принимает финальные решения ENTER/SKIP/WAIT
- Риск: 2% на сделку, max 3 позиции, max $500 дневной убыток, SL обязателен
- Partial close at 1R (50%), trailing SL at 1.5R

Ты отвечаешь на вопросы о рынке, позициях, стратегии. Отвечай кратко и по делу, на русском.`;

interface OpenRouterResponse {
  choices: Array<{ message: { content: string } }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export async function chatWithLLM(userPrompt: string): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY ?? '';
  if (!apiKey) return 'Ошибка: OPENROUTER_API_KEY не настроен';

  // Загружаем актуальное состояние
  state.load();

  const s = state.get();
  const d = s.daily;
  const contextBlock = `\n\nТекущее состояние:
- Баланс: $${s.balance.total.toFixed(0)} (доступно: $${s.balance.available.toFixed(0)})
- Позиции: ${s.positions.length}/3${s.positions.length > 0 ? '\n' + s.positions.map((p) => `  ${p.symbol} ${p.side} size=${p.size} entry=${p.entryPrice} mark=${p.markPrice} PnL=${p.unrealisedPnl} SL=${p.stopLoss ?? 'нет'} TP=${p.takeProfit ?? 'нет'}`).join('\n') : ''}
- Сегодня: ${d.trades} сделок, P&L $${d.totalPnl.toFixed(2)}, wins=${d.wins}, losses=${d.losses}
- Kill switch: ${state.isKillSwitchActive() ? 'АКТИВЕН' : 'выкл'}`;

  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/openclaw/crypto-trader',
        'X-Title': 'OpenClaw Crypto Trader',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT + contextBlock },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 2048,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const text = await res.text();
      log.error('LLM chat error', { status: res.status, body: text.slice(0, 200) });
      return `Ошибка API: ${res.status}`;
    }

    const data = (await res.json()) as OpenRouterResponse;
    const content = data.choices[0]?.message?.content ?? '';

    if (data.usage) {
      const costEntry = recordLLMCall(
        'chat',
        data.usage.prompt_tokens,
        data.usage.completion_tokens,
        'chat',
      );
      log.info('LLM chat response', {
        promptLen: userPrompt.length,
        responseLen: content.length,
        costUSD: costEntry.costUSD,
      });
    } else {
      log.info('LLM chat response', {
        promptLen: userPrompt.length,
        responseLen: content.length,
      });
    }

    return content || 'LLM вернул пустой ответ';
  } catch (err: unknown) {
    log.error('LLM chat failed', { error: (err as Error).message });
    return `Ошибка: ${(err as Error).message}`;
  }
}
