/**
 * Forex Candle Seeder — генерирует синтетические исторические свечи M15 и H4
 * на основе текущих цен из FIX QUOTE сессии.
 *
 * Решает проблему холодного старта: market-analyzer требует минимум 50 M15 свечей,
 * а при первом запуске хранилище пустое. Сбор 50 реальных M15 свечей занял бы 12.5 часов.
 *
 * Алгоритм:
 *  1. Подключается к FIX QUOTE, получает bid/ask для всех 8 пар
 *  2. На основе spread вычисляет примерный ATR (волатильность)
 *  3. Генерирует 100 M15 свечей и 60 H4 свечей назад от текущего момента
 *  4. Использует random walk с ATR-пропорциональным шумом
 *  5. Сохраняет в data/forex-candles.json в формате CandleStore
 *
 * Запуск: npx tsx src/trading/forex/candle-seeder.ts
 */

import fs from 'node:fs';
import path from 'node:path';

import { createLogger } from '../../utils/logger.js';
import { getCurrentPrices, loadCandleStore, getCandles } from './price-provider.js';
import config from './config.js';
import type { OHLC } from '../shared/types.js';

const log = createLogger('forex-candle-seeder');

const CANDLE_FILE = path.resolve('data/forex-candles.json');

/** Сколько M15 свечей генерировать */
const M15_COUNT = 100;
/** Сколько H4 свечей генерировать */
const H4_COUNT = 60;

const TF_MS = {
  M15: 15 * 60_000,
  H4: 4 * 60 * 60_000,
};

/** Типичный ATR в пунктах для пар, когда spread недостаточно информативен */
const TYPICAL_ATR: Record<string, number> = {
  EURUSD: 0.0008,
  GBPUSD: 0.0012,
  USDJPY: 0.1,
  AUDUSD: 0.0007,
  USDCAD: 0.0008,
  NZDUSD: 0.0006,
  EURGBP: 0.0006,
  XAUUSD: 2.5,
};

function alignToTf(timestamp: number, tfMs: number): number {
  return Math.floor(timestamp / tfMs) * tfMs;
}

/**
 * Генерирует синтетические OHLC свечи методом random walk.
 *
 * @param currentPrice - текущая mid-цена
 * @param atr          - средняя волатильность за свечу
 * @param count        - количество свечей
 * @param tfMs         - длительность свечи в мс
 * @param now          - текущий timestamp
 */
function generateCandles(
  currentPrice: number,
  atr: number,
  count: number,
  tfMs: number,
  now: number,
): OHLC[] {
  const currentPeriodStart = alignToTf(now, tfMs);

  // Генерируем от самой старой к самой новой
  // Начинаем с текущей цены и идём назад, потом разворачиваем
  let price = currentPrice;
  const rawCandles: OHLC[] = [];

  for (let i = 0; i < count; i++) {
    const periodStart = currentPeriodStart - (i + 1) * tfMs;

    // Случайное движение: тело свечи ~40% от ATR, тени добавляют ещё
    const bodyMove = (Math.random() - 0.5) * atr * 0.8;
    const wickUp = Math.random() * atr * 0.3;
    const wickDown = Math.random() * atr * 0.3;

    const close = price;
    const open = close - bodyMove;
    const high = Math.max(open, close) + wickUp;
    const low = Math.min(open, close) - wickDown;

    rawCandles.push({
      time: new Date(periodStart).toISOString(),
      open: roundPrice(open, currentPrice),
      high: roundPrice(high, currentPrice),
      low: roundPrice(low, currentPrice),
      close: roundPrice(close, currentPrice),
      volume: Math.floor(50 + Math.random() * 200),
    });

    // Следующая (более старая) свеча начинается с open текущей
    price = open;
  }

  // Разворачиваем: от старых к новым
  rawCandles.reverse();

  // Корректируем: последняя свеча должна закрыться около текущей цены
  // Пересчитываем цены вперёд от первой свечи
  let runPrice = rawCandles[0]!.open;

  for (const candle of rawCandles) {
    const body = (Math.random() - 0.5) * atr * 0.8;
    const wickUp = Math.random() * atr * 0.3;
    const wickDown = Math.random() * atr * 0.3;

    const open = runPrice;
    const close = open + body;
    const high = Math.max(open, close) + wickUp;
    const low = Math.min(open, close) - wickDown;

    candle.open = roundPrice(open, currentPrice);
    candle.close = roundPrice(close, currentPrice);
    candle.high = roundPrice(high, currentPrice);
    candle.low = roundPrice(low, currentPrice);

    runPrice = close;
  }

  // Финальная корректировка: плавно подтягиваем к текущей цене
  const lastCandle = rawCandles[rawCandles.length - 1]!;
  const drift = (currentPrice - lastCandle.close) / Math.max(count * 0.3, 1);

  for (let i = Math.floor(count * 0.7); i < count; i++) {
    const c = rawCandles[i]!;
    const adjust = drift * (i - Math.floor(count * 0.7) + 1);
    c.open = roundPrice(c.open + adjust, currentPrice);
    c.close = roundPrice(c.close + adjust, currentPrice);
    c.high = roundPrice(c.high + adjust, currentPrice);
    c.low = roundPrice(c.low + adjust, currentPrice);
  }

  return rawCandles;
}

/** Округление цены по количеству знаков текущей цены */
function roundPrice(price: number, reference: number): number {
  // XAUUSD: 2 знака, JPY пары: 3 знака, остальные: 5 знаков
  let decimals: number;
  if (reference > 100)
    decimals = 2; // XAUUSD
  else if (reference > 10)
    decimals = 3; // USDJPY
  else decimals = 5; // EURUSD и т.д.

  return Number(price.toFixed(decimals));
}

/**
 * Определяет ATR на основе spread или использует типичное значение.
 */
function estimateAtr(pair: string, bid: number, ask: number): number {
  const spread = ask - bid;

  // Для M15 свечи ATR обычно ~3-5x spread для ликвидных пар
  const spreadBasedAtr = spread * 4;

  // Берём максимум из типичного и spread-based (на случай широкого спреда в off-hours)
  const typical = TYPICAL_ATR[pair] ?? spread * 4;

  return Math.max(spreadBasedAtr, typical);
}

async function main(): Promise<void> {
  log.info('Forex Candle Seeder запущен');

  // Загружаем текущее хранилище
  loadCandleStore();

  // Проверяем, нужна ли генерация
  const needsSeeding: string[] = [];

  for (const pair of config.pairs) {
    const m15 = getCandles(pair, 'M15');
    if (m15.length < 50) {
      needsSeeding.push(pair);
    }
  }

  if (needsSeeding.length === 0) {
    log.info('Все пары уже имеют достаточно свечей — seeding не требуется');
    return;
  }

  log.info(`Пары для seeding: ${needsSeeding.join(', ')}`);

  // Получаем текущие цены
  log.info('Получение текущих цен из FIX QUOTE...');
  const prices = await getCurrentPrices(config.pairs);

  if (prices.size === 0) {
    log.error('Не удалось получить цены — seeding невозможен');
    process.exit(1);
  }

  log.info(`Получены цены для ${prices.size} пар`);

  // Загружаем текущее хранилище из файла
  let store: Record<string, OHLC[]> = {};
  try {
    if (fs.existsSync(CANDLE_FILE)) {
      store = JSON.parse(fs.readFileSync(CANDLE_FILE, 'utf8')) as Record<string, OHLC[]>;
    }
  } catch {
    store = {};
  }

  const now = Date.now();
  let seededCount = 0;

  for (const pair of needsSeeding) {
    const priceData = prices.get(pair);
    if (!priceData) {
      log.warn(`Нет цены для ${pair} — пропускаем`);
      continue;
    }

    const mid = (priceData.bid + priceData.ask) / 2;
    const m15Atr = estimateAtr(pair, priceData.bid, priceData.ask);
    // H4 ATR ~ 3x M15 ATR (больший таймфрейм = больше волатильность)
    const h4Atr = m15Atr * 3;

    // Генерируем M15 свечи
    const m15Key = `${pair}:M15`;
    const existingM15 = store[m15Key] ?? [];
    if (existingM15.length < 50) {
      const m15Candles = generateCandles(mid, m15Atr, M15_COUNT, TF_MS.M15, now);
      store[m15Key] = m15Candles;
      log.info(`${pair}: сгенерировано ${m15Candles.length} M15 свечей (ATR=${m15Atr.toFixed(5)})`);
    }

    // Генерируем H4 свечи
    const h4Key = `${pair}:H4`;
    const existingH4 = store[h4Key] ?? [];
    if (existingH4.length < 20) {
      const h4Candles = generateCandles(mid, h4Atr, H4_COUNT, TF_MS.H4, now);
      store[h4Key] = h4Candles;
      log.info(`${pair}: сгенерировано ${h4Candles.length} H4 свечей (ATR=${h4Atr.toFixed(5)})`);
    }

    seededCount++;
  }

  // Сохраняем
  const dir = path.dirname(CANDLE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tmpFile = `${CANDLE_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmpFile, CANDLE_FILE);

  const totalCandles = Object.values(store).reduce((s, arr) => s + arr.length, 0);
  log.info(`Seeding завершён: ${seededCount} пар, ${totalCandles} свечей всего в хранилище`);
}

main().catch((err) => {
  log.error(`Candle seeder failed: ${(err as Error).message}`);
  process.exit(1);
});
