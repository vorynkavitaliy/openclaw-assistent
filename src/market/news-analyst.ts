/**
 * Новостной бот-аналитик.
 *
 * Каждые 4 часа (cron): собирает новости → дедупликация → Claude анализ → Telegram дайджест.
 *
 * Запуск: npm run market:news-analysis
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../utils/env.js';
import { createLogger } from '../utils/logger.js';
import { runMain } from '../utils/process.js';

loadEnv();
import { runClaudeCli } from '../utils/claude-cli.js';
import { sendTelegram } from '../utils/telegram.js';
import { fetchAllNews } from './news-sources.js';
import {
  type NewsAnalysisResult,
  loadHistory,
  filterNew,
  appendHistory,
  cleanupHistory,
} from './news-dedup.js';
import { buildNewsAnalysisPrompt } from './news-prompt.js';
import { formatNewsTelegram } from './news-formatter.js';

const log = createLogger('news-analyst');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const HISTORY_FILE = path.join(PROJECT_ROOT, 'data', 'news-history.jsonl');
const RUNS_FILE = path.join(PROJECT_ROOT, 'data', 'news-analysis-runs.jsonl');

const NEWS_SYSTEM_PROMPT =
  'Ты — крипто-аналитик. Анализируешь новости и определяешь их влияние на рынок. ' +
  'Отвечай ТОЛЬКО JSON без markdown обёрток. Язык ответа: русский.';

/**
 * Парсит JSON из ответа Claude (может содержать markdown обёртки).
 */
function parseClaudeResponse(text: string): NewsAnalysisResult | null {
  // Пробуем найти JSON блок
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    log.error('Claude не вернул JSON', { text: text.slice(0, 500) });
    return null;
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    return {
      timestamp: new Date().toISOString(),
      itemsTotal: 0,
      itemsNew: 0,
      sentiment: (parsed.sentiment as NewsAnalysisResult['sentiment']) ?? 'neutral',
      summary: (parsed.summary as string) ?? '',
      keyEvents: (parsed.keyEvents as NewsAnalysisResult['keyEvents']) ?? [],
      fearGreedIndex: 0,
    };
  } catch (err) {
    log.error('Ошибка парсинга JSON от Claude', {
      error: (err as Error).message,
      text: jsonMatch[0].slice(0, 500),
    });
    return null;
  }
}

async function main(): Promise<void> {
  log.info('Запуск новостного анализа');

  // 1. Очистка старых записей
  cleanupHistory(HISTORY_FILE);

  // 2. Сбор новостей из всех источников
  const { items, fearGreed } = await fetchAllNews();

  if (items.length === 0) {
    log.warn('Не удалось собрать новости ни из одного источника');
    return;
  }

  // 3. Дедупликация
  const history = loadHistory(HISTORY_FILE);
  const newItems = filterNew(items, history);

  log.info('Дедупликация', { total: items.length, new: newItems.length, history: history.length });

  if (newItems.length === 0) {
    log.info('Нет новых новостей, пропускаем анализ');
    return;
  }

  // 4. Сохраняем новые в историю
  appendHistory(HISTORY_FILE, newItems);

  // 5. Формируем промпт и отправляем Claude
  const prompt = buildNewsAnalysisPrompt(newItems, fearGreed);
  log.info('Отправляем Claude для анализа', {
    newsCount: newItems.length,
    promptLength: prompt.length,
  });

  let claudeResponse: string;
  try {
    claudeResponse = await runClaudeCli(prompt, {
      stream: false,
      useSession: false,
      systemPrompt: NEWS_SYSTEM_PROMPT,
      timeoutMs: 120_000,
    });
  } catch (err) {
    log.error('Claude CLI ошибка', { error: (err as Error).message });
    await sendTelegram('⚠️ Новостной анализ: Claude не ответил').catch(() => {});
    return;
  }

  // 6. Парсим ответ
  const result = parseClaudeResponse(claudeResponse);
  if (!result) {
    log.error('Не удалось распарсить ответ Claude');
    return;
  }

  result.itemsTotal = items.length;
  result.itemsNew = newItems.length;
  if (fearGreed) {
    result.fearGreedIndex = fearGreed.value;
  }

  // 7. Сохраняем результат анализа
  try {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(RUNS_FILE, JSON.stringify(result) + '\n', 'utf-8');
    log.info('Результат анализа сохранён', { file: RUNS_FILE });
  } catch (err) {
    log.warn('Не удалось сохранить результат анализа', { error: (err as Error).message });
  }

  // 8. Отправляем в Telegram
  const telegramMsg = formatNewsTelegram(result);
  const sent = await sendTelegram(telegramMsg, 'HTML');
  if (sent) {
    log.info('Дайджест отправлен в Telegram');
  } else {
    log.warn('Не удалось отправить дайджест в Telegram');
  }

  log.info('Новостной анализ завершён', {
    sentiment: result.sentiment,
    keyEvents: result.keyEvents.length,
    newItems: newItems.length,
  });
}

runMain(main);
