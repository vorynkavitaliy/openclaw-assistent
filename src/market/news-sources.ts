import { type NewsItem, hashNewsItem } from './news-dedup.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('news-sources');

const USER_AGENT =
  'openclaw-assistent/news-sources (+https://github.com/vorynkavitaliy/openclaw-assistent)';

// ─── RSS фиды ──────────────────────────────────────────────────────────────

const RSS_FEEDS: Array<[source: string, url: string]> = [
  ['CoinDesk', 'https://www.coindesk.com/arc/outboundfeeds/rss/'],
  ['Cointelegraph', 'https://cointelegraph.com/rss'],
  ['Decrypt', 'https://decrypt.co/feed'],
];

// ─── Nitter RSS (крипто-инфлюенсеры) ─────────────────────────────────────

const NITTER_FEEDS: Array<[source: string, url: string]> = [
  ['WatcherGuru', 'https://nitter.net/WatcherGuru/rss'],
  ['lookonchain', 'https://nitter.net/lookonchain/rss'],
  ['whale_alert', 'https://nitter.net/whale_alert/rss'],
  ['CryptoQuant_com', 'https://nitter.net/CryptoQuant_com/rss'],
];

// ─── Парсинг XML ──────────────────────────────────────────────────────────

/**
 * Извлекает текстовое содержимое тега из XML-блока.
 * Поддерживает CDATA: <tag><![CDATA[text]]></tag>
 */
function extractTag(xml: string, tag: string): string {
  const pattern = new RegExp(
    `<${tag}[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))<\\/${tag}>`,
    'i',
  );
  const m = xml.match(pattern);
  if (!m) return '';
  return ((m[1] ?? m[2]) || '').trim();
}

/**
 * Разбивает XML на блоки <item>...</item> и парсит каждый.
 */
function parseRssXml(xml: string, source: string): NewsItem[] {
  const items: NewsItem[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1] ?? '';

    const title = extractTag(block, 'title');
    const link = extractTag(block, 'link') || extractTag(block, 'guid');
    const pubDate = extractTag(block, 'pubDate') || extractTag(block, 'dc:date');
    const description = extractTag(block, 'description');

    if (!title) continue;

    // Нормализация timestamp → ISO
    let timestamp = new Date().toISOString();
    if (pubDate) {
      const parsed = new Date(pubDate);
      if (!isNaN(parsed.getTime())) {
        timestamp = parsed.toISOString();
      }
    }

    const item: Omit<NewsItem, 'id'> & { id?: string } = {
      title,
      source,
      timestamp,
    };
    if (link) item.url = link;
    if (description) item.summary = description.replace(/<[^>]+>/g, '').slice(0, 300);

    items.push({ ...item, id: hashNewsItem(item.title, item.source) });
  }

  return items;
}

// ─── HTTP helper ──────────────────────────────────────────────────────────

async function fetchText(url: string, timeoutMs = 15_000): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/xml,text/xml,application/rss+xml,*/*',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }

  return res.text();
}

// ─── Источник 1: RSS крипто-медиа ─────────────────────────────────────────

/**
 * Загружает новости из RSS фидов крипто-медиа (CoinDesk, Cointelegraph, Decrypt).
 * Парсит XML вручную через regex — без внешних зависимостей.
 */
export async function fetchRssNews(): Promise<NewsItem[]> {
  const results: NewsItem[] = [];

  await Promise.allSettled(
    RSS_FEEDS.map(async ([source, url]) => {
      try {
        const xml = await fetchText(url);
        const items = parseRssXml(xml, source);
        results.push(...items);
        log.info('RSS fetched', { source, count: items.length });
      } catch (error: unknown) {
        log.warn('RSS fetch failed', {
          source,
          url,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );

  return results;
}

// ─── Источник 2: Nitter (Twitter RSS) ────────────────────────────────────

/**
 * Загружает твиты крипто-инфлюенсеров через nitter.net RSS.
 * Нестабилен — каждый аккаунт в изолированном try/catch.
 * Таймаут 10 секунд на запрос.
 */
export async function fetchNitterNews(): Promise<NewsItem[]> {
  const results: NewsItem[] = [];

  await Promise.allSettled(
    NITTER_FEEDS.map(async ([source, url]) => {
      try {
        const xml = await fetchText(url, 10_000);
        const items = parseRssXml(xml, `@${source}`);
        results.push(...items);
        log.info('Nitter fetched', { source, count: items.length });
      } catch (error: unknown) {
        log.warn('Nitter fetch failed (нестабильный источник)', {
          source,
          url,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );

  return results;
}

// ─── Источник 3: Fear & Greed Index ──────────────────────────────────────

interface FearGreedResult {
  value: number;
  classification: string;
}

interface FearGreedApiResponse {
  data?: Array<{
    value?: string;
    value_classification?: string;
  }>;
}

/**
 * Получает индекс страха и жадности (alternative.me).
 * Бесплатный API, без ключей.
 */
export async function fetchFearGreed(): Promise<FearGreedResult> {
  const res = await fetch('https://api.alternative.me/fng/', {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`Fear & Greed API HTTP ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as FearGreedApiResponse;
  const entry = json.data?.[0];

  if (!entry) {
    throw new Error('Fear & Greed API: пустой ответ (data[0] отсутствует)');
  }

  const value = parseInt(entry.value ?? '', 10);
  if (isNaN(value)) {
    throw new Error(`Fear & Greed API: некорректное значение value="${entry.value}"`);
  }

  return {
    value,
    classification: entry.value_classification ?? 'Unknown',
  };
}

// ─── Агрегатор ────────────────────────────────────────────────────────────

interface AllNewsResult {
  items: NewsItem[];
  fearGreed: FearGreedResult | null;
}

/**
 * Запускает все источники параллельно (Promise.allSettled).
 * Каждый источник изолирован — ошибка одного не блокирует остальные.
 */
export async function fetchAllNews(): Promise<AllNewsResult> {
  log.info('Запуск сбора новостей из всех источников');

  const [rssResult, nitterResult, fearGreedResult] = await Promise.allSettled([
    fetchRssNews(),
    fetchNitterNews(),
    fetchFearGreed(),
  ]);

  const rssItems = rssResult.status === 'fulfilled' ? rssResult.value : [];
  const nitterItems = nitterResult.status === 'fulfilled' ? nitterResult.value : [];
  let fearGreed: FearGreedResult | null = null;
  if (fearGreedResult.status === 'fulfilled') {
    fearGreed = fearGreedResult.value;
  } else {
    const reason: unknown = fearGreedResult.reason;
    log.warn('Fear & Greed fetch failed', {
      error: reason instanceof Error ? reason.message : String(reason),
    });
  }

  const items = [...rssItems, ...nitterItems];

  log.info('Сбор новостей завершён', {
    rss: rssItems.length,
    nitter: nitterItems.length,
    total: items.length,
    fearGreed: fearGreed ? `${fearGreed.value} (${fearGreed.classification})` : 'недоступен',
  });

  return { items, fearGreed };
}
