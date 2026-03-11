/**
 * Промпт для Claude — анализ крипто-новостей.
 */

import type { NewsItem } from './news-dedup.js';

/**
 * Формирует промпт для Claude с новостями для анализа.
 */
export function buildNewsAnalysisPrompt(
  items: NewsItem[],
  fearGreed: { value: number; classification: string } | null,
): string {
  const parts: string[] = [];

  parts.push(
    `Ты — крипто-аналитик. Проанализируй следующие новости и дай краткий дайджест для трейдера.`,
  );
  parts.push('');

  if (fearGreed) {
    parts.push(`Fear & Greed Index: ${fearGreed.value}/100 (${fearGreed.classification})`);
    parts.push('');
  }

  parts.push(`=== НОВОСТИ (${items.length} шт) ===`);
  parts.push('');

  // Группируем по источнику
  const bySource = new Map<string, NewsItem[]>();
  for (const item of items) {
    const group = bySource.get(item.source) ?? [];
    group.push(item);
    bySource.set(item.source, group);
  }

  for (const [source, sourceItems] of bySource) {
    parts.push(`--- ${source} (${sourceItems.length}) ---`);
    for (const item of sourceItems.slice(0, 10)) {
      const time = item.timestamp.slice(0, 16).replace('T', ' ');
      parts.push(`[${time}] ${item.title}`);
      if (item.summary) {
        parts.push(`  ${item.summary.slice(0, 200)}`);
      }
    }
    parts.push('');
  }

  parts.push(`=== ЗАДАЧА ===`);
  parts.push('');
  parts.push(`Ответь СТРОГО в формате JSON (без markdown, без \`\`\`json):
{
  "sentiment": "bullish" | "bearish" | "neutral" | "mixed",
  "summary": "2-3 предложения — главное за период",
  "keyEvents": [
    {
      "title": "Краткое название события",
      "impact": "HIGH/MEDIUM/LOW",
      "pairs": ["BTCUSDT", "ETHUSDT"]
    }
  ],
  "risks": "1-2 предложения о ключевых рисках (если есть)",
  "opportunities": "1-2 предложения о возможностях для входа (если есть)"
}`);

  return parts.join('\n');
}
