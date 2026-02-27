/**
 * Forex Client — торговля через cTrader FIX 4.4 API.
 *
 * Предоставляет API совместимый с crypto bybit-client:
 *   getKlines, getMarketAnalysis, getBalance, getPositions,
 *   submitOrder, closePosition, modifyPosition.
 *
 * Подключение к cTrader через FIX протокол (TLS, порт 5212 TRADE).
 * Credentials из ~/.openclaw/credentials.json
 */

import { getCTraderCredentials } from '../../utils/config.js';
import { createLogger } from '../../utils/logger.js';
import {
  calculateAtr,
  calculateEma,
  calculateRsi,
  calculateSupportResistance,
  getEmaTrend,
  getPriceVsEma,
  getRsiZone,
} from '../shared/indicators.js';
import type {
  AccountInfo,
  MarketAnalysis,
  OHLC,
  OrderResult,
  Position as OurPosition,
} from '../shared/types.js';
import { FixSession, MsgType, Tag, type FixSessionConfig } from './fix-connection.js';

const log = createLogger('forex-client');

// ─── SL/TP Types (замена ctrader-ts SlTpSpec / ModifyOptions) ─

export interface SlTpSpec {
  pips?: number;
  price?: number;
}

export interface ModifyOptions {
  sl?: SlTpSpec;
  tp?: SlTpSpec;
}

// ─── Constants ───────────────────────────────────────────────

const LOTS_TO_UNITS = 100_000; // 1 lot = 100,000 units для forex
const XAU_LOTS_TO_UNITS = 100; // 1 lot = 100 oz для XAUUSD

function lotsToUnits(symbol: string, lots: number): number {
  if (symbol.toUpperCase().startsWith('XAU')) {
    return Math.round(lots * XAU_LOTS_TO_UNITS);
  }
  return Math.round(lots * LOTS_TO_UNITS);
}

function unitsToLots(symbol: string, units: number): number {
  if (symbol.toUpperCase().startsWith('XAU')) {
    return units / XAU_LOTS_TO_UNITS;
  }
  return units / LOTS_TO_UNITS;
}

// ─── Request ID counter ─────────────────────────────────────

let reqCounter = 0;
function nextReqId(prefix: string): string {
  return `${prefix}-${++reqCounter}-${Date.now()}`;
}

/** FIX TransactTime в формате YYYYMMDD-HH:MM:SS */
function fixTransactTime(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const mo = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const h = String(now.getUTCHours()).padStart(2, '0');
  const mi = String(now.getUTCMinutes()).padStart(2, '0');
  const s = String(now.getUTCSeconds()).padStart(2, '0');
  return `${y}${mo}${d}-${h}:${mi}:${s}`;
}

// ─── FIX Session Singleton ───────────────────────────────────

let tradeSession: FixSession | null = null;
let connectPromise: Promise<FixSession> | null = null;

function buildTradeConfig(): FixSessionConfig {
  const creds = getCTraderCredentials();

  return {
    host: creds.fix.host,
    port: creds.fix.trade.portSSL,
    senderCompID: creds.fix.senderCompID,
    targetCompID: creds.fix.targetCompID,
    senderSubID: creds.fix.trade.senderSubID,
    targetSubID: creds.fix.trade.senderSubID, // cTrader требует TargetSubID=TRADE
    username: creds.login,
    password: creds.fixPassword,
    heartbeatIntervalSec: 30,
  };
}

async function getTradeSession(): Promise<FixSession> {
  if (tradeSession?.isConnected) return tradeSession;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    const config = buildTradeConfig();
    tradeSession = new FixSession(config);

    log.info('Подключение к cTrader FIX TRADE...');
    await tradeSession.connect();
    log.info('✅ cTrader FIX TRADE: подключено');

    tradeSession.on('close', () => {
      log.warn('FIX TRADE: соединение закрыто');
      tradeSession = null;
    });

    return tradeSession;
  })();

  try {
    return await connectPromise;
  } finally {
    connectPromise = null;
  }
}

export function disconnect(): void {
  if (tradeSession) {
    tradeSession.disconnect();
    tradeSession = null;
    log.info('cTrader FIX: отключено');
  }
}

// ─── Symbol ID Mapping ──────────────────────────────────────
// cTrader FIX использует числовые ID инструментов (Symbol=1, 2, ...)
// Маппинг загружается через SecurityListRequest (x) при первом обращении.

const symbolNameToId = new Map<string, string>(); // EURUSD -> "1"
const symbolIdToName = new Map<string, string>(); // "1" -> EURUSD
let symbolsLoaded = false;

/**
 * Загрузить список инструментов через SecurityListRequest.
 * cTrader возвращает все инструменты в одном SecurityList (y) сообщении
 * с repeating group: 55=<id>|1007=<name>|... для каждого символа.
 */
export async function loadSymbols(): Promise<void> {
  if (symbolsLoaded) return;

  const session = await getTradeSession();
  const reqId = nextReqId('sec');

  log.info('Загрузка списка инструментов (SecurityListRequest)...');

  const reports = await session.requestMulti(
    MsgType.SecurityListRequest,
    [
      [Tag.SecurityReqID, reqId],
      [Tag.SecurityListRequestType, 0], // 0 = All securities
    ],
    MsgType.SecurityList,
    reqId,
    20000,
  );

  for (const rpt of reports) {
    // cTrader отправляет все символы в одном сообщении как repeating group
    // Delimiter: 55 (Symbol = numeric ID), Fields: 1007 (LegSymbol = name)
    const groups = rpt.getRepeatingGroup(Tag.Symbol, [Tag.LegSymbol]);
    for (const group of groups) {
      const symId = group.get(Tag.Symbol) ?? '';
      const symName = group.get(Tag.LegSymbol) ?? '';
      if (symId && symName) {
        symbolNameToId.set(symName.toUpperCase(), symId);
        symbolIdToName.set(symId, symName.toUpperCase());
      }
    }
  }

  symbolsLoaded = true;
  log.info(`Инструментов загружено: ${symbolNameToId.size}`);
  if (symbolNameToId.size > 0) {
    const sample = [...symbolNameToId.entries()].slice(0, 5);
    log.debug(`Примеры: ${sample.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
}

/**
 * Преобразовать имя символа в числовой ID.
 * Если маппинг не загружен — загрузит автоматически.
 * Если символ не найден — вернёт оригинальное имя (fallback).
 */
async function resolveSymbolId(name: string): Promise<string> {
  await loadSymbols();
  return symbolNameToId.get(name.toUpperCase()) ?? name;
}

/**
 * Преобразовать числовой ID в имя символа.
 */
function resolveSymbolName(id: string): string {
  return symbolIdToName.get(id) ?? id;
}

// ─── Market Data (ограниченная поддержка через FIX) ─────────

/**
 * Получить OHLC свечи.
 * FIX API не поддерживает исторические бары — возвращает пустой массив.
 * Автоматический трейдинг заработает после подключения источника данных.
 */
export function getKlines(
  _symbol: string,
  _timeframe: string,
  _count: number = 100,
): Promise<OHLC[]> {
  log.debug('getKlines: FIX API не поддерживает исторические бары');
  return Promise.resolve([]);
}

/**
 * Получить анализ рынка. Возвращает null если нет данных.
 */
export async function getMarketAnalysis(
  symbol: string,
  timeframe: string,
  count: number = 100,
): Promise<MarketAnalysis | null> {
  try {
    const candles = await getKlines(symbol, timeframe, count);
    if (candles.length < 20) return null;

    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);

    const ema200 = calculateEma(closes, 200);
    const ema50 = calculateEma(closes, 50);
    const ema20 = calculateEma(closes, 20);
    const rsi14 = calculateRsi(closes, 14);
    const atr14 = calculateAtr(highs, lows, closes, 14);
    const levels = calculateSupportResistance(highs, lows, 20);
    const currentPrice = closes[closes.length - 1];
    const lastCandle = candles[candles.length - 1];

    return {
      pair: symbol,
      timeframe,
      barsCount: candles.length,
      source: 'cTrader-FIX',
      currentPrice,
      lastBar: lastCandle,
      indicators: {
        ema200: ema200[ema200.length - 1] ?? 0,
        ema50: ema50[ema50.length - 1] ?? 0,
        ema20: ema20[ema20.length - 1] ?? 0,
        rsi14,
        atr14,
      },
      levels,
      bias: {
        emaTrend: getEmaTrend(ema50[ema50.length - 1] ?? null, ema200[ema200.length - 1] ?? null),
        priceVsEma200: getPriceVsEma(currentPrice, ema200[ema200.length - 1] ?? null),
        rsiZone: getRsiZone(rsi14),
      },
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    log.warn(`Ошибка анализа ${symbol} ${timeframe}`, { error: (err as Error).message });
    return null;
  }
}

// ─── Account ─────────────────────────────────────────────────

/**
 * Получить баланс аккаунта.
 *
 * ⚠️ cTrader FIX НЕ поддерживает CollateralInquiry (BB) — возвращает "Invalid MsgType".
 * Баланс рассчитывается из открытых позиций (unrealised PnL).
 * Для точного баланса нужен cTrader Open API (Protobuf) или ручной ввод начального баланса.
 */
export async function getBalance(): Promise<AccountInfo> {
  // cTrader FIX не имеет способа получить баланс напрямую.
  // Получаем позиции и суммируем unrealised PnL как приближение.
  const positions = await getPositions();
  const totalUnrealisedPnl = positions.reduce(
    (sum, p) => sum + parseFloat(p.unrealisedPnl || '0'),
    0,
  );

  log.warn(
    'getBalance: cTrader FIX не поддерживает CollateralInquiry (BB). ' +
      'Баланс приблизительный. Используйте cTrader Open API для точных данных.',
  );

  // TODO: Подключить cTrader Open API (Protobuf, порт 5035) для точного баланса
  return {
    totalEquity: 0,
    availableBalance: 0,
    totalWalletBalance: 0,
    unrealisedPnl: totalUnrealisedPnl,
    currency: 'USD',
  };
}

/**
 * Получить открытые позиции через FIX Request For Positions (AN).
 */
export async function getPositions(): Promise<OurPosition[]> {
  const session = await getTradeSession();
  const reqId = nextReqId('pos');

  const reports = await session.requestMulti(
    MsgType.RequestForPositions,
    [
      [Tag.PosReqID, reqId],
      // cTrader FIX: аккаунт определяется из SenderCompID при Logon.
      // Теги Account, AccountType, Currency, TransactTime, PosReqType НЕ поддерживаются в AN.
    ],
    MsgType.PositionReport,
    reqId,
    15000,
  );

  if (reports.length === 0) {
    log.info('Нет открытых позиций');
    return [];
  }

  const positions: OurPosition[] = [];

  for (const rpt of reports) {
    const symId = rpt.getString(Tag.Symbol);
    const symName = rpt.getString(Tag.SymbolName) || resolveSymbolName(symId);
    const longQty = rpt.getFloat(Tag.LongQty);
    const shortQty = rpt.getFloat(Tag.ShortQty);
    const settlPrice = rpt.getFloat(Tag.SettlPrice);
    const positionId = rpt.getString(Tag.PosMaintRptID);
    const avgPx = rpt.getFloat(Tag.AvgPx) || settlPrice;

    const isLong = longQty > 0;
    const volume = isLong ? longQty : shortQty;
    const lots = unitsToLots(symName, volume);

    if (volume === 0) continue;

    positions.push({
      symbol: symName,
      side: isLong ? 'long' : 'short',
      size: String(lots),
      entryPrice: String(avgPx),
      markPrice: String(settlPrice),
      unrealisedPnl: '0',
      leverage: '30',
      stopLoss: '0',
      takeProfit: '0',
      positionId,
    } as OurPosition & { positionId: string });
  }

  log.info(`Позиций: ${positions.length}`);
  return positions;
}

// ─── Trading ─────────────────────────────────────────────────

/**
 * Открыть ордер через FIX New Order Single (D).
 */
export async function submitOrder(params: {
  symbol: string;
  side: 'Buy' | 'Sell';
  lots: number;
  sl?: SlTpSpec;
  tp?: SlTpSpec;
}): Promise<OrderResult> {
  const session = await getTradeSession();
  const creds = getCTraderCredentials();
  const clOrdId = nextReqId('ord');
  const units = lotsToUnits(params.symbol, params.lots);
  const fixSide = params.side === 'Buy' ? '1' : '2';
  const symbolId = await resolveSymbolId(params.symbol);

  const fields: [number, string | number][] = [
    [Tag.ClOrdID, clOrdId],
    [Tag.Account, creds.login],
    [Tag.Symbol, symbolId],
    [Tag.Side, fixSide],
    [Tag.OrderQty, units],
    [Tag.OrdType, '1'], // Market
    [Tag.TimeInForce, '3'], // IOC
    [Tag.TransactTime, fixTransactTime()],
  ];

  // SL/TP через cTrader custom tags (9025/9026) если заданы в абсолютных ценах
  if (params.sl?.price) {
    fields.push([Tag.StopLossPrice, params.sl.price]);
  }
  if (params.tp?.price) {
    fields.push([Tag.TakeProfitPrice, params.tp.price]);
  }

  log.info(`Отправка ордера: ${params.side} ${params.symbol} ${params.lots} lots (${units} units)`);

  const execReport = await session.request(
    MsgType.NewOrderSingle,
    fields,
    MsgType.ExecutionReport,
    clOrdId,
    15000,
  );

  const execType = execReport.getString(Tag.ExecType);
  const ordStatus = execReport.getString(Tag.OrdStatus);
  const orderId = execReport.getString(Tag.OrderID);
  const avgPx = execReport.getFloat(Tag.AvgPx);
  const rejectReason = execReport.getString(Tag.Text);

  if (execType === '8' || ordStatus === '8') {
    throw new Error(`Ордер отклонён: ${rejectReason}`);
  }

  log.info(`Ордер выполнен: ${orderId} ${params.side} ${params.symbol} @ ${avgPx}`, {
    execType,
    ordStatus,
    clOrdId,
  });

  if ((params.sl?.pips && !params.sl?.price) || (params.tp?.pips && !params.tp?.price)) {
    log.warn(
      `⚠️ SL/TP в пипсах требует расчёта абсолютной цены. ` +
        `SL=${JSON.stringify(params.sl)} TP=${JSON.stringify(params.tp)}`,
    );
  }

  return {
    orderId: orderId || clOrdId,
    symbol: params.symbol,
    side: params.side,
    orderType: 'Market',
    qty: String(params.lots),
    price: avgPx > 0 ? String(avgPx) : undefined,
    status: ordStatus === '2' || execType === 'F' ? 'FILLED' : 'EXECUTED',
  };
}

/**
 * Закрыть позицию — обратный ордер с PositionEffect=Close (тег 77=C).
 */
export async function closePosition(
  positionId: number | string,
  partialLots?: number,
): Promise<void> {
  const positions = await getPositions();
  const pos = positions.find(
    (p) => (p as unknown as Record<string, unknown>).positionId === String(positionId),
  );

  if (!pos) {
    throw new Error(`Позиция ${positionId} не найдена`);
  }

  const session = await getTradeSession();
  const creds = getCTraderCredentials();
  const clOrdId = nextReqId('close');
  const lots = partialLots ?? parseFloat(pos.size);
  const units = lotsToUnits(pos.symbol, lots);
  const closeSide = pos.side === 'long' ? '2' : '1';
  const symbolId = await resolveSymbolId(pos.symbol);

  const fields: [number, string | number][] = [
    [Tag.ClOrdID, clOrdId],
    [Tag.Account, creds.login],
    [Tag.Symbol, symbolId],
    [Tag.Side, closeSide],
    [Tag.OrderQty, units],
    [Tag.OrdType, '1'], // Market
    [Tag.TimeInForce, '3'], // IOC
    [Tag.TransactTime, fixTransactTime()],
    [Tag.PositionEffect, 'C'], // Close (hedged accounts)
  ];

  log.info(`Закрытие позиции ${positionId}: ${pos.symbol} ${lots} lots`);

  const execReport = await session.request(
    MsgType.NewOrderSingle,
    fields,
    MsgType.ExecutionReport,
    clOrdId,
    15000,
  );

  const execType = execReport.getString(Tag.ExecType);
  if (execType === '8') {
    throw new Error(`Ошибка закрытия: ${execReport.getString(Tag.Text)}`);
  }

  log.info(`Позиция ${positionId} закрыта`, { partial: partialLots });
}

/**
 * Модифицировать SL/TP позиции.
 * ⚠️ FIX 4.4 ограничен — SL/TP через отдельные protection orders.
 */
export function modifyPosition(positionId: number | string, opts: ModifyOptions): Promise<void> {
  log.warn(
    `modifyPosition ${positionId}: SL/TP через FIX ограничен. Opts: ${JSON.stringify(opts)}`,
  );
  // TODO: Реализовать через отдельные protection orders
  return Promise.resolve();
}

/**
 * Закрыть все позиции.
 */
export async function closeAll(): Promise<void> {
  const positions = await getPositions();
  for (const pos of positions) {
    const posId = (pos as unknown as Record<string, unknown>).positionId as string;
    try {
      await closePosition(posId);
    } catch (err) {
      log.error(`Ошибка закрытия ${pos.symbol}: ${(err as Error).message}`);
    }
  }
  log.info('Все позиции закрыты');
}

/**
 * Закрыть позиции по символу.
 */
export async function closeSymbol(symbol: string): Promise<void> {
  const positions = await getPositions();
  for (const pos of positions.filter((p) => p.symbol === symbol)) {
    const posId = (pos as unknown as Record<string, unknown>).positionId as string;
    try {
      await closePosition(posId);
    } catch (err) {
      log.error(`Ошибка закрытия ${pos.symbol}: ${(err as Error).message}`);
    }
  }
  log.info(`Позиции по ${symbol} закрыты`);
}

/**
 * Получить историю сделок — FIX не поддерживает напрямую.
 */
export function getDeals(_maxRows: number = 50): Promise<unknown[]> {
  log.debug('getDeals: FIX API не поддерживает историю сделок');
  return Promise.resolve([]);
}
