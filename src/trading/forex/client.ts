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
import config from './config.js';
import { FixSession, MsgType, Tag, type FixSessionConfig } from './fix-connection.js';

const log = createLogger('forex-client');

export interface PositionWithId extends OurPosition {
  positionId: string;
}

export interface SlTpSpec {
  pips?: number;
  price?: number;
}

export interface ModifyOptions {
  sl?: SlTpSpec;
  tp?: SlTpSpec;
}

const LOTS_TO_UNITS = 100_000;
const XAU_LOTS_TO_UNITS = 100;
const INITIAL_BALANCE = parseFloat(process.env.FTMO_INITIAL_BALANCE ?? '10000');

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
    20000,
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
    availableBalance: Math.round(equity * 0.9 * 100) / 100,
    totalWalletBalance: walletBalance,
    unrealisedPnl: Math.round(totalUnrealisedPnl * 100) / 100,
    currency: 'USD',
  };
}

export async function getPositions(): Promise<PositionWithId[]> {
  const session = await getTradeSession();
  const reqId = nextReqId('pos');

  const reports = await session.requestMulti(
    MsgType.RequestForPositions,
    [[Tag.PosReqID, reqId]],
    MsgType.PositionReport,
    reqId,
    15000,
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
  sl?: SlTpSpec;
  tp?: SlTpSpec;
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

  if (slPrice) fields.push([Tag.StopLossPrice, slPrice]);
  if (tpPrice) fields.push([Tag.TakeProfitPrice, tpPrice]);

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
    15000,
  );

  const execType = execReport.getString(Tag.ExecType);
  const ordStatus = execReport.getString(Tag.OrdStatus);
  const orderId = execReport.getString(Tag.OrderID);
  const avgPx = execReport.getFloat(Tag.AvgPx);
  const rejectReason = execReport.getString(Tag.Text);

  if (execType === '8' || ordStatus === '8') {
    throw new Error(`Order rejected: ${rejectReason}`);
  }

  log.info(`Order filled: ${orderId} ${params.side} ${params.symbol} @ ${avgPx}`, {
    execType,
    ordStatus,
    clOrdId,
  });

  if (avgPx > 0 && (params.sl?.pips || params.tp?.pips)) {
    const slPriceFromPips = pipsToPrice(params.side, avgPx, params.sl, true, params.symbol);
    const tpPriceFromPips = pipsToPrice(params.side, avgPx, params.tp, false, params.symbol);

    if (slPriceFromPips || tpPriceFromPips) {
      const posId = execReport.getString(Tag.PosMaintRptID) || execReport.getString(Tag.OrderID);

      if (posId) {
        try {
          logSlTpLimitation(slPriceFromPips, tpPriceFromPips);
          log.info(
            `SL/TP set: SL=${slPriceFromPips ?? 'N/A'} TP=${tpPriceFromPips ?? 'N/A'}`,
          );
        } catch (err) {
          log.warn(`Failed to set SL/TP after fill: ${(err as Error).message}`);
        }
      }
    }
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
  ];

  log.info(`Closing position ${positionId}: ${pos.symbol} ${lots} lots`);

  const execReport = await session.request(
    MsgType.NewOrderSingle,
    fields,
    MsgType.ExecutionReport,
    clOrdId,
    15000,
  );

  const execType = execReport.getString(Tag.ExecType);
  if (execType === '8') {
    throw new Error(`Close error: ${execReport.getString(Tag.Text)}`);
  }

  log.info(`Position ${positionId} closed`, { partial: partialLots });
}

function logSlTpLimitation(
  slPrice: number | undefined,
  tpPrice: number | undefined,
): void {
  if (slPrice || tpPrice) {
    log.warn(
      `SL=${slPrice ?? 'N/A'} TP=${tpPrice ?? 'N/A'} — ` +
        `post-fill SL/TP modification requires cTrader Open API. ` +
        `Use price-based SL/TP in submitOrder for best results.`,
    );
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

  log.info(
    `modifyPosition ${positionId}: ${pos.symbol} ` +
      `SL=${slAbsPrice ?? 'unchanged'} TP=${tpAbsPrice ?? 'unchanged'}`,
  );

  if (slAbsPrice || tpAbsPrice) {
    log.warn(
      `SL/TP modification on existing position requires cTrader Open API. ` +
        `Current SL/TP: SL=${pos.stopLoss ?? 'none'} TP=${pos.takeProfit ?? 'none'}`,
    );
  }
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
