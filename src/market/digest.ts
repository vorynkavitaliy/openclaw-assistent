/**
 * Market Digest — создаёт JSON-дайджест без web_search/web_fetch.
 *
 * Источники:
 *   - Macro: ForexFactory calendar XML (публичные зеркала)
 *   - Crypto news: RSS feeds (CoinDesk, Cointelegraph) через rss-parser
 *
 * Использование:
 *   tsx src/market/digest.ts --hours=48 --max-news=20
 *
 * Мигрировано из scripts/market_digest.py
 */

import Parser from 'rss-parser';

// ─── Конфиг ───────────────────────────────────────────────────

const FF_XML_URLS = [
  'https://nfs.faireconomy.media/ff_calendar_thisweek.xml',
  'https://nfs.faireconomy.media/ff_calendar_today.xml',
];

const RSS_FEEDS: Array<[string, string]> = [
  ['CoinDesk', 'https://www.coindesk.com/arc/outboundfeeds/rss/'],
  ['Cointelegraph', 'https://cointelegraph.com/rss'],
];

const USER_AGENT =
  'openclaw-assistent/market-digest (+https://github.com/vorynkavitaliy/openclaw-assistent)';

// ─── Типы ─────────────────────────────────────────────────────

interface MacroEvent {
  title: string;
  country: string;
  currency: string;
  impact: string;
  forecast: string;
  previous: string;
  actual: string;
  date: string;
  time: string;
  timestamp: number | null;
}

interface NewsItem {
  source: string;
  title: string;
  link: string;
  pubDate: string;
  timestamp: number | null;
}

interface DigestOutput {
  status: string;
  generatedAt: string;
  windowHours: number;
  macro: { upcoming: MacroEvent[]; sample: MacroEvent[]; errors: string[] };
  news: { recent: NewsItem[]; errors: string[] };
}

// ─── CLI args ─────────────────────────────────────────────────

function getNumArg(name: string, defaultVal: number): number {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? parseInt(found.slice(prefix.length), 10) || defaultVal : defaultVal;
}

// ─── HTTP ─────────────────────────────────────────────────────

async function httpGet(url: string, timeoutMs = 20_000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/xml,text/xml,text/html,*/*' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ─── ForexFactory XML ─────────────────────────────────────────

function parseFFCalendar(xmlText: string): MacroEvent[] {
  // Minimal XML parsing via regex — no heavy dependency needed for simple structure
  const events: MacroEvent[] = [];
  const eventRegex = /<event>([\s\S]*?)<\/event>/g;
  let match: RegExpExecArray | null;

  while ((match = eventRegex.exec(xmlText)) !== null) {
    const block = match[1];

    const tag = (name: string): string => {
      const m = block.match(new RegExp(`<${name}>([^<]*)</${name}>`));
      return m ? m[1].trim() : '';
    };

    const dateS = tag('date');
    const timeS = tag('time');
    let ts: number | null = null;

    if (dateS && timeS && !['all day', 'tentative'].includes(timeS.toLowerCase())) {
      const tsRaw = tag('timestamp');
      if (tsRaw && /^\d+$/.test(tsRaw)) {
        ts = parseInt(tsRaw, 10);
      } else {
        // Parse MM-DD-YYYY HH:MM as UTC
        const parsed = Date.parse(`${dateS} ${timeS} UTC`);
        if (!isNaN(parsed)) ts = Math.floor(parsed / 1000);
      }
    }

    events.push({
      title: tag('title'),
      country: tag('country'),
      currency: tag('currency') || tag('country'),
      impact: tag('impact'),
      forecast: tag('forecast'),
      previous: tag('previous'),
      actual: tag('actual'),
      date: dateS,
      time: timeS,
      timestamp: ts,
    });
  }

  return events;
}

// ─── RSS ──────────────────────────────────────────────────────

async function fetchRSS(source: string, url: string): Promise<NewsItem[]> {
  const parser = new Parser({
    headers: { 'User-Agent': USER_AGENT },
    timeout: 20_000,
  });

  const feed = await parser.parseURL(url);
  return (feed.items ?? []).map((item) => {
    let ts: number | null = null;
    if (item.pubDate) {
      const d = new Date(item.pubDate);
      if (!isNaN(d.getTime())) ts = Math.floor(d.getTime() / 1000);
    }

    return {
      source,
      title: (item.title ?? '').trim(),
      link: (item.link ?? '').trim(),
      pubDate: item.pubDate ?? '',
      timestamp: ts,
    };
  });
}

// ─── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const hours = getNumArg('hours', 48);
  const maxNews = getNumArg('max-news', 20);
  const maxEvents = getNumArg('max-events', 50);

  const now = new Date();
  const nowTs = Math.floor(now.getTime() / 1000);
  const sinceTs = nowTs - hours * 3600;
  const untilTs = nowTs + hours * 3600;

  // --- Macro ---
  const macroEvents: MacroEvent[] = [];
  const macroErrors: string[] = [];

  for (const url of FF_XML_URLS) {
    try {
      const xml = await httpGet(url);
      macroEvents.push(...parseFFCalendar(xml));
    } catch (err) {
      macroErrors.push(`${url}: ${(err as Error).message}`);
    }
  }

  // Upcoming events (now → now + hours)
  let upcoming = macroEvents
    .filter((e) => e.timestamp !== null && e.timestamp >= nowTs && e.timestamp <= untilTs)
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
    .slice(0, maxEvents);

  // Raw sample for visibility even if timestamps are missing
  const rawSample = macroEvents.filter((e) => e.title).slice(0, maxEvents);

  // --- News ---
  const newsItems: NewsItem[] = [];
  const newsErrors: string[] = [];

  for (const [source, url] of RSS_FEEDS) {
    try {
      const items = await fetchRSS(source, url);
      newsItems.push(...items);
    } catch (err) {
      newsErrors.push(`${source} ${url}: ${(err as Error).message}`);
    }
  }

  const recentNews = newsItems
    .filter((n) => n.timestamp !== null && n.timestamp >= sinceTs)
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
    .slice(0, maxNews);

  // --- Output ---
  const output: DigestOutput = {
    status: 'OK',
    generatedAt: now.toISOString(),
    windowHours: hours,
    macro: { upcoming, sample: rawSample, errors: macroErrors },
    news: { recent: recentNews, errors: newsErrors },
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error(`Ошибка: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
