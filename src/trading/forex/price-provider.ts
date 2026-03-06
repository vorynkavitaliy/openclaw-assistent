/**
 * Forex Price Provider — получение рыночных данных через cTrader FIX QUOTE сессию.
 *
 * Алгоритм работы getCurrentPrices():
 *  1. Подключается к FIX QUOTE сессии
 *  2. Загружает символы через SecurityListRequest
 *  3. Для каждой пары запрашивает MarketDataRequest (35=V, снапшот bid/ask)
 *  4. Агрегирует mid-цену в текущие свечи M15 и H4
 *  5. Сохраняет хранилище свечей в файл, отключается
 */

import fs from 'node:fs';
import path from 'node:path';

import { getCTraderCredentials } from '../../utils/config.js';
import { createLogger } from '../../utils/logger.js';
import { buildMarketAnalysis } from '../shared/indicators.js';
import type { MarketAnalysis, OHLC } from '../shared/types.js';
import { FixSession, MsgType, Tag, type FixSessionConfig } from './fix-connection.js';

const log = createLogger('forex-price-provider');

// ─── Константы ────────────────────────────────────────────────────

const CANDLE_FILE = path.resolve('data/forex-candles.json');
const MAX_CANDLES_PER_KEY = 250;
const REQUEST_TIMEOUT_MS = 15_000;
const SNAPSHOT_TIMEOUT_MS = 5_000;

/** Таймфреймы для агрегации тиков — ключ: название, значение: длительность в мс */
const TF_MS: Record<string, number> = {
  M1: 60_000,
  M5: 5 * 60_000,
  M15: 15 * 60_000,
  H1: 60 * 60_000,
  H4: 4 * 60 * 60_000,
};

/** Таймфреймы, агрегируемые при каждом вызове getCurrentPrices() */
const AGGREGATED_TIMEFRAMES = ['M15', 'H4'] as const;

// ─── Типы ─────────────────────────────────────────────────────────

/** Хранилище свечей: ключ = "EURUSD:M15" */
type CandleStore = Record<string, OHLC[]>;

/** Незавершённая (текущая) свеча для агрегации */
interface CurrentCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Начало периода (unix ms, выровнено по границе TF) */
  openTime: number;
}

// ─── In-memory состояние ───────────────────────────────────────────

/** Завершённые свечи по ключу "PAIR:TF" */
let candleStore: CandleStore = {};

/** Незавершённые свечи текущего периода по ключу "PAIR:TF" */
const currentCandles = new Map<string, CurrentCandle>();

let storeLoaded = false;

// ─── Вспомогательные функции ──────────────────────────────────────

/**
 * Возвращает начало периода для timestamp с учётом размера TF.
 * Пример: M15 = 15 минут → выравниваем timestamp вниз до ближайших 15 мин.
 */
function alignToTf(timestamp: number, tfMs: number): number {
  return Math.floor(timestamp / tfMs) * tfMs;
}

function buildCandleKey(pair: string, timeframe: string): string {
  return `${pair.toUpperCase()}:${timeframe}`;
}

/** Превращает CurrentCandle в финальный OHLC (закрытую свечу) */
function finalizeCandle(current: CurrentCandle): OHLC {
  return {
    time: new Date(current.openTime).toISOString(),
    open: current.open,
    high: current.high,
    low: current.low,
    close: current.close,
    volume: current.volume,
  };
}

// ─── Управление хранилищем ────────────────────────────────────────

/**
 * Загружает хранилище свечей из файла.
 * Безопасна для многократного вызова — загружает только один раз.
 */
export function loadCandleStore(): void {
  if (storeLoaded) return;

  try {
    if (fs.existsSync(CANDLE_FILE)) {
      const raw = fs.readFileSync(CANDLE_FILE, 'utf8');
      candleStore = JSON.parse(raw) as CandleStore;
      const totalKeys = Object.keys(candleStore).length;
      const totalCandles = Object.values(candleStore).reduce((s, arr) => s + arr.length, 0);
      log.info(`Candle store loaded: ${totalKeys} keys, ${totalCandles} candles`);
    } else {
      log.info('Candle store file not found — starting empty');
      candleStore = {};
    }
  } catch (error: unknown) {
    log.warn(`Failed to load candle store, starting empty: ${(error as Error).message}`);
    candleStore = {};
  }

  storeLoaded = true;
}

/**
 * Сохраняет хранилище свечей атомарно (через tmp-файл) во избежание повреждения.
 */
export function saveCandleStore(): void {
  try {
    const dir = path.dirname(CANDLE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tmpFile = `${CANDLE_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(candleStore, null, 2), 'utf8');
    fs.renameSync(tmpFile, CANDLE_FILE);

    const totalCandles = Object.values(candleStore).reduce((s, arr) => s + arr.length, 0);
    log.debug(`Candle store saved: ${totalCandles} candles`);
  } catch (error: unknown) {
    log.error(`Failed to save candle store: ${(error as Error).message}`);
  }
}

// ─── Агрегация тиков ──────────────────────────────────────────────

/**
 * Добавляет ценовой тик в текущую свечу для указанной пары и таймфрейма.
 * Если время перешло границу TF — текущая свеча финализируется и начинается новая.
 *
 * @param pair      - символ пары, например "EURUSD"
 * @param price     - mid-цена (bid+ask)/2
 * @param timestamp - unix timestamp в мс
 * @param timeframe - таймфрейм из TF_MS: "M15", "H4" и т.д.
 */
export function aggregateTick(
  pair: string,
  price: number,
  timestamp: number,
  timeframe: string,
): void {
  const tfMs = TF_MS[timeframe];
  if (tfMs === undefined) {
    log.warn(`Unknown timeframe: ${timeframe}`);
    return;
  }

  const periodStart = alignToTf(timestamp, tfMs);
  const key = buildCandleKey(pair, timeframe);
  const existing = currentCandles.get(key);

  if (existing?.openTime === periodStart) {
    // Обновляем текущую свечу
    existing.high = Math.max(existing.high, price);
    existing.low = Math.min(existing.low, price);
    existing.close = price;
    existing.volume += 1;
    return;
  }

  // Период сменился — финализируем предыдущую свечу (если была)
  if (existing) {
    const completed = finalizeCandle(existing);
    candleStore[key] ??= [];
    const keyCandles = candleStore[key];
    keyCandles.push(completed);

    // Обрезаем до MAX_CANDLES_PER_KEY
    if (keyCandles.length > MAX_CANDLES_PER_KEY) {
      candleStore[key] = keyCandles.slice(-MAX_CANDLES_PER_KEY);
    }

    log.debug(
      `Candle closed ${key}: O=${completed.open} H=${completed.high} L=${completed.low} C=${completed.close}`,
    );
  }

  // Начинаем новую свечу
  currentCandles.set(key, {
    open: price,
    high: price,
    low: price,
    close: price,
    volume: 1,
    openTime: periodStart,
  });
}

// ─── Получение свечей ─────────────────────────────────────────────

/**
 * Возвращает завершённые свечи из хранилища.
 * Незавершённая текущая свеча не включается.
 *
 * @param pair      - символ пары, например "EURUSD"
 * @param timeframe - таймфрейм: "M15", "H4" и т.д.
 * @param count     - сколько последних свечей вернуть (по умолчанию — все)
 */
export function getCandles(pair: string, timeframe: string, count?: number): OHLC[] {
  loadCandleStore();

  const key = buildCandleKey(pair, timeframe);
  const candles = candleStore[key] ?? [];

  if (count !== undefined && candles.length > count) {
    return candles.slice(-count);
  }

  return [...candles];
}

// ─── FIX QUOTE сессия ─────────────────────────────────────────────

let reqCounter = 0;

function nextReqId(prefix: string): string {
  return `${prefix}-${++reqCounter}-${Date.now()}`;
}

function buildQuoteConfig(): FixSessionConfig {
  const creds = getCTraderCredentials();

  return {
    host: creds.fix.host,
    port: creds.fix.quote.portSSL,
    senderCompID: creds.fix.senderCompID,
    targetCompID: creds.fix.targetCompID,
    senderSubID: creds.fix.quote.senderSubID,
    targetSubID: 'QUOTE',
    username: creds.login,
    password: creds.fixPassword,
    heartbeatIntervalSec: 30,
  };
}

/**
 * Загружает символы через SecurityListRequest на уже подключённую сессию.
 * Возвращает Map<имя_символа_upper, symbolId>.
 */
async function loadSymbolsFromSession(session: FixSession): Promise<Map<string, string>> {
  const symbolNameToId = new Map<string, string>();
  const reqId = nextReqId('sec');

  log.info('Loading symbols via SecurityListRequest (QUOTE session)...');

  const reports = await session.requestMulti(
    MsgType.SecurityListRequest,
    [
      [Tag.SecurityReqID, reqId],
      [Tag.SecurityListRequestType, 0],
    ],
    MsgType.SecurityList,
    reqId,
    REQUEST_TIMEOUT_MS * 2,
  );

  for (const rpt of reports) {
    const groups = rpt.getRepeatingGroup(Tag.Symbol, [Tag.LegSymbol]);
    for (const group of groups) {
      const symId = group.get(Tag.Symbol) ?? '';
      const symName = group.get(Tag.LegSymbol) ?? '';
      if (symId && symName) {
        symbolNameToId.set(symName.toUpperCase(), symId);
      }
    }
  }

  log.info(`Symbols loaded: ${symbolNameToId.size}`);
  return symbolNameToId;
}

/**
 * Запрашивает MarketDataSnapshot (35=V → 35=W) для одного символа.
 * Возвращает { bid, ask } или null если данные недоступны.
 */
async function fetchBidAsk(
  session: FixSession,
  symbolId: string,
  pairName: string,
): Promise<{ bid: number; ask: number } | null> {
  const mdReqId = nextReqId('mdr');

  // cTrader не поддерживает SubscriptionRequestType=0 (snapshot only).
  // Используем =1 (subscribe), получаем первый snapshot, затем отписываемся.
  const fields: [number, string | number][] = [
    [Tag.MDReqID, mdReqId],
    [Tag.SubscriptionRequestType, '1'], // 1 = Subscribe (snapshot + updates)
    [Tag.MarketDepth, '1'], // Top of book
    [Tag.NoMDEntryTypes, '2'], // Запрашиваем 2 типа
    [Tag.MDEntryType, '0'], // Bid
    [Tag.MDEntryType, '1'], // Offer
    [Tag.NoRelatedSym, '1'], // 1 символ
    [Tag.Symbol, symbolId],
  ];

  try {
    const snapshot = await session.request(
      MsgType.MarketDataRequest,
      fields,
      MsgType.MarketDataSnapshot,
      mdReqId,
      SNAPSHOT_TIMEOUT_MS,
    );

    // Отписываемся после получения snapshot
    try {
      session.sendRaw(MsgType.MarketDataRequest, [
        [Tag.MDReqID, mdReqId],
        [Tag.SubscriptionRequestType, '2'], // 2 = Unsubscribe
        [Tag.MarketDepth, '1'],
        [Tag.NoMDEntryTypes, '2'],
        [Tag.MDEntryType, '0'],
        [Tag.MDEntryType, '1'],
        [Tag.NoRelatedSym, '1'],
        [Tag.Symbol, symbolId],
      ]);
    } catch {
      /* отписка best-effort */
    }

    // Парсим повторяющиеся группы MDEntry (268=NoMDEntries, 269=MDEntryType, 270=MDEntryPx)
    const entries = snapshot.getRepeatingGroup(Tag.MDEntryType, [Tag.MDEntryPx, Tag.MDEntrySize]);

    let bid = 0;
    let ask = 0;

    for (const entry of entries) {
      const entryType = entry.get(Tag.MDEntryType) ?? '';
      const price = parseFloat(entry.get(Tag.MDEntryPx) ?? '0');

      if (entryType === '0' && price > 0) bid = price;
      else if (entryType === '1' && price > 0) ask = price;
    }

    if (bid === 0 || ask === 0) {
      log.warn(`Incomplete bid/ask for ${pairName}: bid=${bid} ask=${ask}`);
      return null;
    }

    return { bid, ask };
  } catch (error: unknown) {
    log.warn(`Failed to get snapshot for ${pairName}: ${(error as Error).message}`);
    return null;
  }
}

// ─── Основная публичная функция ───────────────────────────────────

/**
 * Подключается к FIX QUOTE сессии, получает текущие bid/ask для каждой пары,
 * агрегирует mid-цену в свечи M15 и H4, сохраняет хранилище и отключается.
 *
 * @param pairs - список символов, например ["EURUSD", "GBPUSD"]
 * @returns Map<символ, { bid, ask }> для пар, по которым получены данные
 */
export async function getCurrentPrices(
  pairs: string[],
): Promise<Map<string, { bid: number; ask: number }>> {
  loadCandleStore();

  const result = new Map<string, { bid: number; ask: number }>();
  const now = Date.now();

  const cfg = buildQuoteConfig();
  const session = new FixSession(cfg);

  log.info(`Connecting to cTrader FIX QUOTE for ${pairs.length} pairs...`);

  try {
    await session.connect();
    log.info('cTrader FIX QUOTE connected');

    const symbolMap = await loadSymbolsFromSession(session);

    for (const pair of pairs) {
      const pairUpper = pair.toUpperCase();
      const symbolId = symbolMap.get(pairUpper);

      if (!symbolId) {
        log.warn(`Symbol not found in list: ${pairUpper}`);
        continue;
      }

      const prices = await fetchBidAsk(session, symbolId, pairUpper);

      if (!prices) continue;

      result.set(pairUpper, prices);

      const mid = (prices.bid + prices.ask) / 2;

      // Агрегируем тик в M15 и H4
      for (const tf of AGGREGATED_TIMEFRAMES) {
        aggregateTick(pairUpper, mid, now, tf);
      }

      log.debug(`${pairUpper}: bid=${prices.bid} ask=${prices.ask} mid=${mid.toFixed(5)}`);
    }

    saveCandleStore();
    log.info(`Prices fetched: ${result.size}/${pairs.length} pairs`);
  } catch (error: unknown) {
    log.error(`getCurrentPrices failed: ${(error as Error).message}`);
  } finally {
    try {
      session.disconnect();
      log.debug('cTrader FIX QUOTE disconnected');
    } catch {
      /* игнорируем ошибки при отключении */
    }
  }

  return result;
}

// ─── Анализ на основе накопленных свечей ─────────────────────────

/**
 * Строит MarketAnalysis из накопленных свечей для указанной пары и таймфрейма.
 * Требует минимум 20 завершённых свечей, возвращает null если данных недостаточно.
 *
 * @param pair      - символ пары, например "EURUSD"
 * @param timeframe - таймфрейм: "M15" или "H4"
 * @param count     - сколько последних свечей использовать (по умолчанию 200)
 */
export function buildAnalysisFromCandles(
  pair: string,
  timeframe: string,
  count: number = 200,
): MarketAnalysis | null {
  const candles = getCandles(pair, timeframe, count);

  if (candles.length < 20) {
    log.debug(
      `Not enough candles for analysis: ${pair} ${timeframe} (${candles.length}/20 minimum)`,
    );
    return null;
  }

  return buildMarketAnalysis(candles, {
    pair,
    timeframe,
    source: 'cTrader-FIX-QUOTE',
  });
}
