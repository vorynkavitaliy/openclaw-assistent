/**
 * Forex History Provider — загрузка исторических свечей для бэктестинга.
 *
 * Источник: Twelve Data API (бесплатно, 800 запросов/день).
 * Кеширование: data/forex-history/<PAIR>-<TF>.json
 *
 * ENV: TWELVE_DATA_API_KEY (бесплатный ключ с twelvedata.com)
 */

import fs from 'node:fs';
import path from 'node:path';

import { createLogger } from '../../utils/logger.js';
import type { OHLC } from '../shared/types.js';

const log = createLogger('forex-history');

const CACHE_DIR = path.resolve('data/forex-history');
const BASE_URL = 'https://api.twelvedata.com/time_series';

/** Маппинг наших таймфреймов на Twelve Data формат */
const TF_MAP: Record<string, string> = {
  M5: '5min',
  M15: '15min',
  H1: '1h',
  H4: '4h',
  D1: '1day',
};

/** Маппинг наших пар на Twelve Data символы (через /) */
const SYMBOL_MAP: Record<string, string> = {
  EURUSD: 'EUR/USD',
  GBPUSD: 'GBP/USD',
  USDJPY: 'USD/JPY',
  AUDUSD: 'AUD/USD',
  USDCAD: 'USD/CAD',
  NZDUSD: 'NZD/USD',
  EURGBP: 'EUR/GBP',
  XAUUSD: 'XAU/USD',
  EURJPY: 'EUR/JPY',
  GBPJPY: 'GBP/JPY',
  USDCHF: 'USD/CHF',
};

function getApiKey(): string {
  return process.env.TWELVE_DATA_API_KEY ?? '';
}

function getCacheFile(pair: string, tf: string): string {
  return path.join(CACHE_DIR, `${pair}-${tf}.json`);
}

interface CacheEntry {
  pair: string;
  timeframe: string;
  fetchedAt: string;
  candles: OHLC[];
}

interface TwelveDataResponse {
  status: string;
  meta?: { symbol: string; interval: string };
  values?: Array<{
    datetime: string;
    open: string;
    high: string;
    low: string;
    close: string;
    volume?: string;
  }>;
  message?: string;
}

/**
 * Загружает свечи из кеша. Возвращает null если кеша нет или он устарел.
 */
function loadFromCache(pair: string, tf: string, maxAgeHours: number = 24): OHLC[] | null {
  const file = getCacheFile(pair, tf);
  if (!fs.existsSync(file)) return null;

  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as CacheEntry;
    const age = (Date.now() - new Date(data.fetchedAt).getTime()) / 3600_000;

    if (age > maxAgeHours) {
      log.debug(`Cache expired for ${pair}:${tf} (${age.toFixed(1)}h old)`);
      return null;
    }

    log.debug(`Cache hit: ${pair}:${tf} — ${data.candles.length} candles (${age.toFixed(1)}h old)`);
    return data.candles;
  } catch {
    return null;
  }
}

function saveToCache(pair: string, tf: string, candles: OHLC[]): void {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }

  const entry: CacheEntry = {
    pair,
    timeframe: tf,
    fetchedAt: new Date().toISOString(),
    candles,
  };

  const file = getCacheFile(pair, tf);
  fs.writeFileSync(file, JSON.stringify(entry), 'utf8');
  log.debug(`Cached ${candles.length} candles: ${pair}:${tf}`);
}

/**
 * Один запрос к Twelve Data API.
 * Возвращает до 5000 свечей, отсортированных ASC (oldest → newest).
 */
async function fetchFromApi(
  pair: string,
  tf: string,
  outputSize: number,
  endDate?: string,
): Promise<OHLC[]> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('TWELVE_DATA_API_KEY не установлен в .env');

  const symbol = SYMBOL_MAP[pair] ?? pair;
  const interval = TF_MAP[tf] ?? tf;

  const params = new URLSearchParams({
    symbol,
    interval,
    outputsize: String(Math.min(outputSize, 5000)),
    apikey: apiKey,
    order: 'ASC',
  });

  if (endDate) {
    params.set('end_date', endDate);
  }

  const url = `${BASE_URL}?${params.toString()}`;

  log.debug(
    `API request: ${pair} ${tf} outputSize=${outputSize}${endDate ? ` end=${endDate}` : ''}`,
  );

  const resp = await fetch(url, {
    headers: { 'User-Agent': 'OpenClaw/1.0' },
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    throw new Error(`Twelve Data HTTP ${resp.status}: ${await resp.text()}`);
  }

  const data = (await resp.json()) as TwelveDataResponse;

  if (data.status === 'error') {
    throw new Error(`Twelve Data error: ${data.message ?? 'unknown'}`);
  }

  if (!data.values || data.values.length === 0) {
    log.warn(`No data returned for ${pair}:${tf}`);
    return [];
  }

  const candles: OHLC[] = data.values.map((v) => ({
    // Twelve Data возвращает "2026-03-07 05:45:00" — заменяем пробел на T
    time: new Date(v.datetime.replace(' ', 'T') + 'Z').toISOString(),
    open: parseFloat(v.open),
    high: parseFloat(v.high),
    low: parseFloat(v.low),
    close: parseFloat(v.close),
    volume: parseFloat(v.volume ?? '0') || 0,
  }));

  log.info(
    `Fetched ${candles.length} candles: ${pair}:${tf} [${candles[0]?.time.slice(0, 10)} — ${candles[candles.length - 1]?.time.slice(0, 10)}]`,
  );

  return candles;
}

/**
 * Загружает исторические свечи с пагинацией (если нужно > 5000).
 * Кеширует результат локально.
 *
 * @param pair  - символ: "EURUSD", "XAUUSD" и т.д.
 * @param tf    - таймфрейм: "M15", "H4", "D1"
 * @param count - количество свечей (может быть > 5000)
 * @param options - настройки кеша
 */
export async function getHistoricalCandles(
  pair: string,
  tf: string,
  count: number,
  options: { cacheMaxAgeHours?: number; forceRefresh?: boolean } = {},
): Promise<OHLC[]> {
  const { cacheMaxAgeHours = 24, forceRefresh = false } = options;

  // Пробуем кеш
  if (!forceRefresh) {
    const cached = loadFromCache(pair, tf, cacheMaxAgeHours);
    if (cached && cached.length >= count * 0.9) {
      return cached.slice(-count);
    }
  }

  // Загружаем с API
  if (count <= 5000) {
    const candles = await fetchFromApi(pair, tf, count);
    if (candles.length > 0) {
      saveToCache(pair, tf, candles);
    }
    return candles;
  }

  // Пагинация для > 5000 свечей
  const allCandles: OHLC[] = [];
  let remaining = count;
  let endDate: string | undefined;

  while (remaining > 0) {
    const batchSize = Math.min(remaining, 5000);
    const batch = await fetchFromApi(pair, tf, batchSize, endDate);

    if (batch.length === 0) break;

    // batch уже отсортирован ASC
    allCandles.unshift(...batch);

    // Следующий запрос до самой старой свечи
    const oldestTime = batch[0]!.time;
    const oldestMs = new Date(oldestTime).getTime() - 1;
    endDate = new Date(oldestMs).toISOString().slice(0, 19);

    remaining -= batch.length;

    if (batch.length < batchSize) break;

    log.info(`Pagination: loaded ${allCandles.length}/${count}, remaining ${remaining}`);

    // Rate limit: 8 req/min на бесплатном плане
    await new Promise((r) => setTimeout(r, 8_000));
  }

  // Дедупликация по time
  const seen = new Set<string>();
  const deduped = allCandles.filter((c) => {
    if (seen.has(c.time)) return false;
    seen.add(c.time);
    return true;
  });

  // Сортировка ASC
  deduped.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

  if (deduped.length > 0) {
    saveToCache(pair, tf, deduped);
  }

  log.info(`Total loaded: ${pair}:${tf} — ${deduped.length} candles`);
  return deduped.slice(-count);
}

/**
 * Предзагрузка данных для бэктеста — загружает все нужные TF для пары.
 */
export async function prefetchForBacktest(
  pair: string,
  m15Bars: number,
): Promise<{
  m15: OHLC[];
  h4: OHLC[];
  d1: OHLC[];
}> {
  const h4Bars = Math.min(Math.ceil(m15Bars / 16), 5000);
  const d1Bars = Math.min(Math.ceil(m15Bars / 96), 1000);

  log.info(`Prefetching ${pair}: M15=${m15Bars}, H4=${h4Bars}, D1=${d1Bars}`);

  // Последовательно чтобы не превысить rate limit
  const m15 = await getHistoricalCandles(pair, 'M15', m15Bars);
  await new Promise((r) => setTimeout(r, 8_000));

  const h4 = await getHistoricalCandles(pair, 'H4', h4Bars);
  await new Promise((r) => setTimeout(r, 8_000));

  const d1 = await getHistoricalCandles(pair, 'D1', d1Bars);

  return { m15, h4, d1 };
}
