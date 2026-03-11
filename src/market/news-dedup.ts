import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createLogger } from '../utils/logger.js';

const log = createLogger('news-dedup');

const HISTORY_TTL_MS = 48 * 60 * 60 * 1000; // 48 часов

export interface NewsItem {
  id: string; // hash от title+source
  title: string;
  source: string; // 'rss', 'nitter', 'fng'
  url?: string;
  timestamp: string; // ISO
  summary?: string; // краткое описание
}

export interface NewsAnalysisResult {
  timestamp: string;
  itemsTotal: number;
  itemsNew: number;
  sentiment: 'bullish' | 'bearish' | 'neutral' | 'mixed';
  summary: string;
  keyEvents: Array<{ title: string; impact: string; pairs: string[] }>;
  fearGreedIndex?: number;
}

/**
 * Вычисляет sha256 от title+source и возвращает первые 12 символов hex.
 */
export function hashNewsItem(title: string, source: string): string {
  return createHash('sha256').update(`${title}::${source}`).digest('hex').substring(0, 12);
}

/**
 * Читает JSONL файл истории и возвращает записи за последние 48 часов.
 */
export function loadHistory(filepath: string): NewsItem[] {
  if (!existsSync(filepath)) {
    log.debug('Файл истории не найден, возвращаем пустой список', { filepath });
    return [];
  }

  const cutoff = Date.now() - HISTORY_TTL_MS;
  const items: NewsItem[] = [];

  try {
    const content = readFileSync(filepath, 'utf-8');
    const lines = content.split('\n').filter((line) => line.trim().length > 0);

    for (const line of lines) {
      try {
        const item = JSON.parse(line) as NewsItem;
        if (new Date(item.timestamp).getTime() >= cutoff) {
          items.push(item);
        }
      } catch (error: unknown) {
        log.warn('Не удалось распарсить строку JSONL, пропускаем', {
          error: error instanceof Error ? error.message : String(error),
          line: line.substring(0, 100),
        });
      }
    }

    log.debug('История загружена', { total: lines.length, withinTtl: items.length, filepath });
  } catch (error: unknown) {
    log.error('Ошибка чтения файла истории', {
      filepath,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return items;
}

/**
 * Убирает из items те, которые уже есть в history (по полю id).
 */
export function filterNew(items: NewsItem[], history: NewsItem[]): NewsItem[] {
  const seen = new Set(history.map((h) => h.id));
  const newItems = items.filter((item) => !seen.has(item.id));

  log.debug('Фильтрация дублей', {
    input: items.length,
    existing: seen.size,
    new: newItems.length,
  });

  return newItems;
}

/**
 * Добавляет новые items в JSONL файл (дозапись).
 */
export function appendHistory(filepath: string, items: NewsItem[]): void {
  if (items.length === 0) {
    return;
  }

  try {
    const lines = items.map((item) => JSON.stringify(item)).join('\n') + '\n';
    appendFileSync(filepath, lines, 'utf-8');
    log.debug('Записи добавлены в историю', { count: items.length, filepath });
  } catch (error: unknown) {
    log.error('Ошибка записи в файл истории', {
      filepath,
      count: items.length,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Удаляет из JSONL файла записи старше 48 часов (перезаписывает файл).
 */
export function cleanupHistory(filepath: string): void {
  if (!existsSync(filepath)) {
    return;
  }

  const cutoff = Date.now() - HISTORY_TTL_MS;

  try {
    const content = readFileSync(filepath, 'utf-8');
    const lines = content.split('\n').filter((line) => line.trim().length > 0);

    let kept = 0;
    let removed = 0;
    const freshLines: string[] = [];

    for (const line of lines) {
      try {
        const item = JSON.parse(line) as NewsItem;
        if (new Date(item.timestamp).getTime() >= cutoff) {
          freshLines.push(line);
          kept++;
        } else {
          removed++;
        }
      } catch (error: unknown) {
        // Битые строки тоже удаляем при очистке
        removed++;
        log.warn('Удаляем битую строку при очистке', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    writeFileSync(filepath, freshLines.length > 0 ? freshLines.join('\n') + '\n' : '', 'utf-8');
    log.info('Очистка истории завершена', { kept, removed, filepath });
  } catch (error: unknown) {
    log.error('Ошибка очистки файла истории', {
      filepath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
