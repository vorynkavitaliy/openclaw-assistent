import { getCTraderCredentials } from '../../utils/config.js';
import { createLogger } from '../../utils/logger.js';
import { buildMarketAnalysis } from '../shared/indicators.js';
import type {
  AccountInfo,
  MarketAnalysis,
  OHLC,
  OrderResult,
  Position as OurPosition,
} from '../shared/types.js';
import config from './config.js';
import {
  FixSession,
  MsgType,
  Tag,
  type FixMessage,
  type FixSessionConfig,
} from './fix-connection.js';

const log = createLogger('forex-client');

export interface PositionWithId extends OurPosition {
  positionId: string;
}

export interface SlTpSpec {
  pips?: number | undefined;
  price?: number | undefined;
}

export interface ModifyOptions {
  sl?: SlTpSpec | undefined;
  tp?: SlTpSpec | undefined;
}

const LOTS_TO_UNITS = 100_000;
const XAU_LOTS_TO_UNITS = 100;
const INITIAL_BALANCE = parseFloat(process.env.FTMO_INITIAL_BALANCE ?? '10000');
const MARGIN_FACTOR = 0.9;
const REQUEST_TIMEOUT_MS = 15_000;

function pipSize(symbol: string): number {
  const s = symbol.toUpperCase();
  if (s.includes('JPY')) return 0.01;
  if (s.startsWith('XAU')) return 0.1;
  if (s.startsWith('XAG')) return 0.01;
  return 0.0001;
}

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

let reqCounter = 0;

function nextReqId(prefix: string): string {
  return `${prefix}-${++reqCounter}-${Date.now()}`;
}

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

function pipsToPrice(
  side: 'Buy' | 'Sell',
  entryPrice: number,
  spec: SlTpSpec | undefined,
  isStopLoss: boolean,
  symbol: string,
): number | undefined {
  if (!spec) return undefined;
  if (spec.price) return spec.price;
  if (!spec.pips || entryPrice <= 0) return undefined;

  const pip = pipSize(symbol);
  const distance = spec.pips * pip;

  if (isStopLoss) {
    return side === 'Buy' ? entryPrice - distance : entryPrice + distance;
  }

  return side === 'Buy' ? entryPrice + distance : entryPrice - distance;
}

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
    targetSubID: creds.fix.trade.senderSubID,
    username: creds.login,
    password: creds.fixPassword,
    heartbeatIntervalSec: 30,
  };
}

async function getTradeSession(): Promise<FixSession> {
  if (tradeSession?.isConnected) return tradeSession;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    const cfg = buildTradeConfig();
    tradeSession = new FixSession(cfg);

    log.info('Connecting to cTrader FIX TRADE...');
    await tradeSession.connect();
    log.info('cTrader FIX TRADE connected');

    tradeSession.on('close', () => {
      log.warn('FIX TRADE connection closed');
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
    log.info('cTrader FIX disconnected');
  }
}

const symbolNameToId = new Map<string, string>();
const symbolIdToName = new Map<string, string>();
let symbolsLoaded = false;

export async function loadSymbols(): Promise<void> {
  if (symbolsLoaded) return;

  const session = await getTradeSession();
  const reqId = nextReqId('sec');

  log.info('Loading symbol list (SecurityListRequest)...');

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
        symbolIdToName.set(symId, symName.toUpperCase());
      }
    }
  }

  symbolsLoaded = true;
  log.info(`Symbols loaded: ${symbolNameToId.size}`);

  if (symbolNameToId.size > 0) {
    const sample = [...symbolNameToId.entries()].slice(0, 5);
    log.debug(`Sample: ${sample.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
}

async function resolveSymbolId(name: string): Promise<string> {
  await loadSymbols();
  return symbolNameToId.get(name.toUpperCase()) ?? name;
}

function resolveSymbolName(id: string): string {
  return symbolIdToName.get(id) ?? id;
}

export function getKlines(
  _symbol: string,
  _timeframe: string,
  _count: number = 100,
): Promise<OHLC[]> {
  log.debug('getKlines: FIX API does not support historical bars');
  return Promise.resolve([]);
}

export async function getMarketAnalysis(
  symbol: string,
  timeframe: string,
  count: number = 100,
): Promise<MarketAnalysis | null> {
  try {
    const candles = await getKlines(symbol, timeframe, count);
    return buildMarketAnalysis(candles, { pair: symbol, timeframe, source: 'cTrader-FIX' });
  } catch (err) {
    log.warn(`Analysis error ${symbol} ${timeframe}`, { error: (err as Error).message });
    return null;
  }
}

export async function getBalance(): Promise<AccountInfo> {
  const positions = await getPositions();
  const totalUnrealisedPnl = positions.reduce(
    (sum, p) => sum + parseFloat(p.unrealisedPnl || '0'),
    0,
  );

  const walletBalance = INITIAL_BALANCE;
  const equity = walletBalance + totalUnrealisedPnl;

  return {
    totalEquity: Math.round(equity * 100) / 100,
    availableBalance: Math.round(equity * MARGIN_FACTOR * 100) / 100,
    totalWalletBalance: walletBalance,
    unrealisedPnl: Math.round(totalUnrealisedPnl * 100) / 100,
    currency: 'USD',
  };
}

export async function getPositions(): Promise<PositionWithId[]> {
  const session = await getTradeSession();
  await loadSymbols();
  const reqId = nextReqId('pos');

  const reports = await session.requestMulti(
    MsgType.RequestForPositions,
    [[Tag.PosReqID, reqId]],
    MsgType.PositionReport,
    reqId,
    REQUEST_TIMEOUT_MS,
  );

  if (reports.length === 0) {
    log.info('No open positions');
    return [];
  }

  const positions: PositionWithId[] = [];

  for (const rpt of reports) {
    const symId = rpt.getString(Tag.Symbol);
    const symName = rpt.getString(Tag.SymbolName) || resolveSymbolName(symId);
    const longQty = rpt.getFloat(Tag.LongQty);
    const shortQty = rpt.getFloat(Tag.ShortQty);
    const settlPrice = rpt.getFloat(Tag.SettlPrice);
    const positionId = rpt.getString(Tag.PosMaintRptID);
    const avgPx = rpt.getFloat(Tag.AvgPx) || settlPrice;
    const slPrice = rpt.getFloat(Tag.StopLossPrice);
    const tpPrice = rpt.getFloat(Tag.TakeProfitPrice);

    const isLong = longQty > 0;
    const volume = isLong ? longQty : shortQty;
    const lots = unitsToLots(symName, volume);

    if (volume === 0) continue;

    const direction = isLong ? 1 : -1;
    const priceDiff = settlPrice - avgPx;
    let unrealisedPnl = 0;

    if (settlPrice > 0 && avgPx > 0) {
      if (symName.toUpperCase().startsWith('XAU')) {
        unrealisedPnl = priceDiff * direction * volume;
      } else if (symName.toUpperCase().includes('JPY')) {
        unrealisedPnl = (priceDiff * direction * volume) / 100;
      } else {
        unrealisedPnl = priceDiff * direction * volume;
      }
    }

    positions.push({
      symbol: symName,
      side: isLong ? 'long' : 'short',
      size: String(lots),
      entryPrice: String(avgPx),
      markPrice: String(settlPrice),
      unrealisedPnl: String(Math.round(unrealisedPnl * 100) / 100),
      leverage: String(config.defaultLeverage),
      stopLoss: slPrice > 0 ? String(slPrice) : undefined,
      takeProfit: tpPrice > 0 ? String(tpPrice) : undefined,
      positionId,
    });
  }

  log.info(`Positions: ${positions.length}`);
  return positions;
}

export async function submitOrder(params: {
  symbol: string;
  side: 'Buy' | 'Sell';
  lots: number;
  sl?: SlTpSpec | undefined;
  tp?: SlTpSpec | undefined;
}): Promise<OrderResult> {
  const session = await getTradeSession();
  const clOrdId = nextReqId('ord');
  const units = lotsToUnits(params.symbol, params.lots);
  const fixSide = params.side === 'Buy' ? '1' : '2';
  const symbolId = await resolveSymbolId(params.symbol);

  const slPrice = params.sl?.price;
  const tpPrice = params.tp?.price;

  const fields: [number, string | number][] = [
    [Tag.ClOrdID, clOrdId],
    [Tag.Symbol, symbolId],
    [Tag.Side, fixSide],
    [Tag.OrderQty, units],
    [Tag.OrdType, '1'],
    [Tag.TimeInForce, '3'],
    [Tag.TransactTime, fixTransactTime()],
  ];

  log.info(
    `Submitting order: ${params.side} ${params.symbol} ${params.lots} lots (${units} units)` +
      (slPrice ? ` SL=${slPrice}` : '') +
      (tpPrice ? ` TP=${tpPrice}` : ''),
  );

  const execReport = await session.request(
    MsgType.NewOrderSingle,
    fields,
    MsgType.ExecutionReport,
    clOrdId,
    REQUEST_TIMEOUT_MS,
  );

  const execType = execReport.getString(Tag.ExecType);
  const ordStatus = execReport.getString(Tag.OrdStatus);
  const orderId = execReport.getString(Tag.OrderID);
  const avgPx = execReport.getFloat(Tag.AvgPx) || execReport.getFloat(Tag.LastPx);
  const rejectReason = execReport.getString(Tag.Text);

  if (execType === '8' || ordStatus === '8') {
    throw new Error(`Order rejected: ${rejectReason}`);
  }

  const posId = execReport.getString(Tag.PosMaintRptID) || orderId;

  log.info(`Order accepted: ${orderId} ${params.side} ${params.symbol} pos=${posId} @ ${avgPx}`, {
    execType,
    ordStatus,
    clOrdId,
  });

  // ── Set SL/TP as separate Stop/Limit orders linked via PosMaintRptID ──
  // cTrader FIX doesn't support custom tags 9025/9026 or OrderCancelReplaceRequest
  // for position-level SL/TP. Instead, we place separate protective orders.
  const entryPx = avgPx > 0 ? avgPx : slPrice ? slPrice + 0.01 : 0;
  const confirmedSl = slPrice ?? pipsToPrice(params.side, entryPx, params.sl, true, params.symbol);
  const confirmedTp = tpPrice ?? pipsToPrice(params.side, entryPx, params.tp, false, params.symbol);

  if ((confirmedSl || confirmedTp) && posId) {
    try {
      await placeProtectiveOrders(
        session,
        posId,
        symbolId,
        fixSide,
        units,
        confirmedSl,
        confirmedTp,
      );
      log.info(`SL/TP set: SL=${confirmedSl ?? 'N/A'} TP=${confirmedTp ?? 'N/A'}`);
    } catch (err) {
      log.error(
        `CRITICAL: SL/TP placement FAILED for ${params.symbol} pos=${posId}: ${(err as Error).message}. ` +
          `Position is UNPROTECTED. Closing position immediately.`,
      );
      try {
        await closePosition(posId);
        log.warn(`Unprotected position ${posId} closed as safety measure.`);
      } catch (closeErr) {
        log.error(`Failed to close unprotected position ${posId}: ${(closeErr as Error).message}`);
      }
      throw new Error(
        `Order filled but SL/TP failed — position closed for safety. ${(err as Error).message}`,
        { cause: err },
      );
    }
  }

  return {
    orderId: orderId || clOrdId,
    symbol: params.symbol,
    side: params.side,
    orderType: 'Market',
    qty: String(params.lots),
    price: avgPx > 0 ? String(avgPx) : undefined,
    sl: confirmedSl ? String(confirmedSl) : undefined,
    tp: confirmedTp ? String(confirmedTp) : undefined,
    status: ordStatus === '2' || execType === 'F' ? 'FILLED' : 'EXECUTED',
  };
}

export async function closePosition(
  positionId: number | string,
  partialLots?: number,
): Promise<void> {
  const positions = await getPositions();
  const pos = positions.find((p) => p.positionId === String(positionId));

  if (!pos) {
    throw new Error(`Position ${positionId} not found`);
  }

  const session = await getTradeSession();
  const clOrdId = nextReqId('close');
  const lots = partialLots ?? parseFloat(pos.size);
  const units = lotsToUnits(pos.symbol, lots);
  const closeSide = pos.side === 'long' ? '2' : '1';
  const symbolId = await resolveSymbolId(pos.symbol);

  const fields: [number, string | number][] = [
    [Tag.ClOrdID, clOrdId],
    [Tag.Symbol, symbolId],
    [Tag.Side, closeSide],
    [Tag.OrderQty, units],
    [Tag.OrdType, '1'],
    [Tag.TimeInForce, '3'],
    [Tag.TransactTime, fixTransactTime()],
    [Tag.PosMaintRptID, String(positionId)], // Close specific position in hedging mode
  ];

  log.info(`Closing position ${positionId}: ${pos.symbol} ${lots} lots`);

  const execReport = await session.request(
    MsgType.NewOrderSingle,
    fields,
    MsgType.ExecutionReport,
    clOrdId,
    REQUEST_TIMEOUT_MS,
  );

  const execType = execReport.getString(Tag.ExecType);
  if (execType === '8') {
    throw new Error(`Close error: ${execReport.getString(Tag.Text)}`);
  }

  log.info(`Position ${positionId} closed`, { partial: partialLots });
}

/**
 * Place protective Stop (SL) and Limit (TP) orders linked to a position.
 * cTrader FIX doesn't support custom SL/TP tags (9025/9026) or
 * OrderCancelReplaceRequest for positions. Instead, we place separate
 * NewOrderSingle orders with PosMaintRptID to link them.
 */
async function placeProtectiveOrders(
  session: FixSession,
  posId: string,
  symbolId: string,
  positionSide: string, // '1'=Buy, '2'=Sell — the POSITION side
  units: number,
  slPrice: number | undefined,
  tpPrice: number | undefined,
): Promise<void> {
  const closeSide = positionSide === '1' ? '2' : '1'; // opposite

  if (slPrice) {
    const slClOrdId = nextReqId('sl');
    const slFields: [number, string | number][] = [
      [Tag.ClOrdID, slClOrdId],
      [Tag.Symbol, symbolId],
      [Tag.Side, closeSide],
      [Tag.OrderQty, units],
      [Tag.OrdType, '3'], // Stop order
      [Tag.StopPx, slPrice],
      [Tag.TimeInForce, '1'], // GTC
      [Tag.TransactTime, fixTransactTime()],
      [Tag.PosMaintRptID, posId],
    ];

    log.info(`Placing SL Stop order: pos=${posId} StopPx=${slPrice}`);
    const resp = await session.request(
      MsgType.NewOrderSingle,
      slFields,
      MsgType.ExecutionReport,
      slClOrdId,
      REQUEST_TIMEOUT_MS,
    );
    const et = resp.getString(Tag.ExecType);
    if (et === '8') {
      throw new Error(`SL order rejected: ${resp.getString(Tag.Text)}`);
    }
    log.info(`SL order placed: ${resp.getString(Tag.OrderID)}`);
  }

  if (tpPrice) {
    const tpClOrdId = nextReqId('tp');
    const tpFields: [number, string | number][] = [
      [Tag.ClOrdID, tpClOrdId],
      [Tag.Symbol, symbolId],
      [Tag.Side, closeSide],
      [Tag.OrderQty, units],
      [Tag.OrdType, '2'], // Limit order
      [Tag.Price, tpPrice],
      [Tag.TimeInForce, '1'], // GTC
      [Tag.TransactTime, fixTransactTime()],
      [Tag.PosMaintRptID, posId],
    ];

    log.info(`Placing TP Limit order: pos=${posId} Price=${tpPrice}`);
    const resp = await session.request(
      MsgType.NewOrderSingle,
      tpFields,
      MsgType.ExecutionReport,
      tpClOrdId,
      REQUEST_TIMEOUT_MS,
    );
    const et = resp.getString(Tag.ExecType);
    if (et === '8') {
      throw new Error(`TP order rejected: ${resp.getString(Tag.Text)}`);
    }
    log.info(`TP order placed: ${resp.getString(Tag.OrderID)}`);
  }
}

export interface ActiveOrder {
  orderId: string;
  clOrdId: string;
  ordType: string; // '2'=Limit (TP), '3'=Stop (SL)
  positionId: string;
}

/**
 * Получить активные защитные ордера (SL/TP) для конкретной позиции.
 * Использует OrderMassStatusRequest (35=AF, MassStatusReqType=7 — все активные ордера).
 * Фильтрует по PosMaintRptID == positionId и OrdType 2 (Limit) или 3 (Stop).
 */
async function getOrdersForPosition(
  session: FixSession,
  positionId: string,
): Promise<ActiveOrder[]> {
  const massReqId = nextReqId('mass');

  let reports: FixMessage[];
  try {
    reports = await session.requestMassStatus(
      [
        [Tag.MassStatusReqID, massReqId],
        [Tag.MassStatusReqType, 7], // All orders
      ],
      massReqId,
      REQUEST_TIMEOUT_MS,
    );
  } catch (err) {
    log.warn(`getOrdersForPosition: mass status request failed: ${(err as Error).message}`);
    return [];
  }

  const result: ActiveOrder[] = [];

  for (const rpt of reports) {
    const rptPosId = rpt.getString(Tag.PosMaintRptID);
    if (rptPosId !== positionId) continue;

    const ordStatus = rpt.getString(Tag.OrdStatus);
    // Учитываем только активные (New=0, PartiallyFilled=1, PendingNew=A)
    if (ordStatus !== '0' && ordStatus !== '1' && ordStatus !== 'A') continue;

    const ordType = rpt.getString(Tag.OrdType);
    if (ordType !== '2' && ordType !== '3') continue;

    result.push({
      orderId: rpt.getString(Tag.OrderID),
      clOrdId: rpt.getString(Tag.ClOrdID),
      ordType,
      positionId: rptPosId,
    });
  }

  log.debug(
    `getOrdersForPosition pos=${positionId}: found ${result.length} protective order(s) from ${reports.length} total`,
  );
  return result;
}

/**
 * Отменить существующие защитные ордера (SL/TP) для позиции перед установкой новых.
 * Отправляет OrderCancelRequest (35=F) для каждого найденного ордера.
 * Ошибки отмены логируются, но не прерывают выполнение.
 */
async function cancelProtectiveOrders(session: FixSession, positionId: string): Promise<void> {
  const orders = await getOrdersForPosition(session, positionId);

  if (orders.length === 0) {
    log.debug(`cancelProtectiveOrders pos=${positionId}: no active orders to cancel`);
    return;
  }

  log.info(`cancelProtectiveOrders pos=${positionId}: cancelling ${orders.length} order(s)`);

  for (const order of orders) {
    const cancelClOrdId = nextReqId('cxl');
    try {
      const resp = await session.request(
        MsgType.OrderCancelRequest,
        [
          [Tag.OrigClOrdID, order.clOrdId],
          [Tag.ClOrdID, cancelClOrdId],
          [Tag.OrderID, order.orderId],
          [Tag.TransactTime, fixTransactTime()],
        ],
        MsgType.ExecutionReport,
        cancelClOrdId,
        REQUEST_TIMEOUT_MS,
      );
      const execType = resp.getString(Tag.ExecType);
      if (execType === '8') {
        log.warn(`Cancel order ${order.orderId} rejected: ${resp.getString(Tag.Text)}`);
      } else {
        log.info(`Cancelled protective order ${order.orderId} (type=${order.ordType})`);
      }
    } catch (err) {
      log.warn(
        `Failed to cancel order ${order.orderId} for pos=${positionId}: ${(err as Error).message}`,
      );
    }
  }
}

export async function modifyPosition(
  positionId: number | string,
  opts: ModifyOptions,
): Promise<void> {
  const positions = await getPositions();
  const pos = positions.find((p) => p.positionId === String(positionId));

  if (!pos) {
    log.warn(`modifyPosition: position ${positionId} not found`);
    return;
  }

  const entryPrice = parseFloat(pos.entryPrice);
  const side = pos.side === 'long' ? 'Buy' : 'Sell';
  const slAbsPrice = opts.sl?.price ?? pipsToPrice(side, entryPrice, opts.sl, true, pos.symbol);
  const tpAbsPrice = opts.tp?.price ?? pipsToPrice(side, entryPrice, opts.tp, false, pos.symbol);

  if (!slAbsPrice && !tpAbsPrice) {
    log.warn('modifyPosition: no SL or TP values provided');
    return;
  }

  const session = await getTradeSession();
  const symbolId = await resolveSymbolId(pos.symbol);
  const fixSide = pos.side === 'long' ? '1' : '2';
  const units = lotsToUnits(pos.symbol, parseFloat(pos.size));

  // Отменяем старые SL/TP ордера перед установкой новых, чтобы избежать дублей
  await cancelProtectiveOrders(session, String(positionId));

  await placeProtectiveOrders(
    session,
    String(positionId),
    symbolId,
    fixSide,
    units,
    slAbsPrice,
    tpAbsPrice,
  );

  log.info(
    `modifyPosition ${positionId}: ${pos.symbol} ` +
      `SL=${slAbsPrice ?? 'unchanged'} TP=${tpAbsPrice ?? 'unchanged'}`,
  );
}

export async function closeAll(): Promise<void> {
  const positions = await getPositions();

  for (const pos of positions) {
    try {
      await closePosition(pos.positionId);
    } catch (err) {
      log.error(`Error closing ${pos.symbol}: ${(err as Error).message}`);
    }
  }

  log.info('All positions closed');
}

export async function closeSymbol(symbol: string): Promise<void> {
  const positions = await getPositions();

  for (const pos of positions.filter((p) => p.symbol === symbol)) {
    try {
      await closePosition(pos.positionId);
    } catch (err) {
      log.error(`Error closing ${pos.symbol}: ${(err as Error).message}`);
    }
  }

  log.info(`Positions for ${symbol} closed`);
}

export function getDeals(_maxRows: number = 50): Promise<unknown[]> {
  log.debug('getDeals: FIX API does not support trade history');
  return Promise.resolve([]);
}

/** Raw FIX request — for testing/debugging only */
export async function rawRequest(
  msgType: string,
  fields: [number, string | number][],
  responseMsgType: string,
  correlationId: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Record<string, string>> {
  const session = await getTradeSession();
  const resp = await session.request(msgType, fields, responseMsgType, correlationId, timeoutMs);
  const result: Record<string, string> = {};
  for (const [tag, val] of resp.entries()) {
    result[String(tag)] = val;
  }
  return result;
}
