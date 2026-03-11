/**
 * Форматирование результата анализа новостей для Telegram (HTML).
 */

import type { NewsAnalysisResult } from './news-dedup.js';

const SENTIMENT_EMOJI: Record<string, string> = {
  bullish: '🟢',
  bearish: '🔴',
  neutral: '⚪',
  mixed: '🟡',
};

/**
 * Форматирует результат анализа новостей в HTML для Telegram.
 */
export function formatNewsTelegram(result: NewsAnalysisResult): string {
  const emoji = SENTIMENT_EMOJI[result.sentiment] ?? '❓';
  const lines: string[] = [];

  lines.push(`<b>📰 Крипто-дайджест</b>`);
  lines.push(`${emoji} <b>Sentiment: ${result.sentiment.toUpperCase()}</b>`);

  if (result.fearGreedIndex != null) {
    const fgEmoji =
      result.fearGreedIndex <= 25
        ? '😱'
        : result.fearGreedIndex <= 45
          ? '😰'
          : result.fearGreedIndex <= 55
            ? '😐'
            : result.fearGreedIndex <= 75
              ? '😏'
              : '🤑';
    lines.push(`${fgEmoji} Fear &amp; Greed: ${result.fearGreedIndex}/100`);
  }

  lines.push('');
  lines.push(`<b>📋 Обзор</b>`);
  lines.push(escapeHtml(result.summary));

  if (result.keyEvents.length > 0) {
    lines.push('');
    lines.push(`<b>🔑 Ключевые события</b>`);
    for (const event of result.keyEvents.slice(0, 5)) {
      const impactIcon = event.impact === 'HIGH' ? '🔴' : event.impact === 'MEDIUM' ? '🟡' : '🟢';
      const pairs = event.pairs.length > 0 ? ` [${event.pairs.join(', ')}]` : '';
      lines.push(`${impactIcon} ${escapeHtml(event.title)}${pairs}`);
    }
  }

  lines.push('');
  lines.push(`<i>Новостей: ${result.itemsNew} новых из ${result.itemsTotal}</i>`);

  return lines.join('\n');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
