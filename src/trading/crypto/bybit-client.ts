import {
  RestClientV5,
  type OrderParamsV5,
  type PositionInfoParamsV5,
  type SetTradingStopParamsV5,
} from 'bybit-api';
import { getBybitBaseUrl, getBybitCredentials } from '../../utils/config.js';
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
  MarketInfo,
  OHLC,
  OrderResult,
  Position,
} from '../shared/types.js';
import { TIMEFRAME_MAP as TF_MAP } from '../shared/types.js';

const log = createLogger('bybit-client');

const MAX_LEVERAGE = 5;
const CATEGORY = 'linear' as const;

interface BybitApiResponse {
  retCode: number;
  retMsg: string;
  result: Record<string, unknown>;
}

let _client: RestClientV5 | null = null;

function getClient(): RestClientV5 {
  if (_client) return _client;

  const creds = getBybitCredentials();

  if (!creds.apiKey || !creds.apiSecret) {
    throw new Error('API keys not configured. Check ~/.openclaw/credentials.json');
  }

  _client = new RestClientV5({
    key: creds.apiKey,
    secret: creds.apiSecret,
    testnet: creds.testnet,
    demoTrading: creds.demoTrading,
  });

  return _client;
}

async function apiGet(
  endpoint: string,
  params?: Record<string, string>,
): Promise<Record<string, unknown>> {
  const baseUrl = getBybitBaseUrl();
  let url = `${baseUrl}${endpoint}`;

  if (params) {
    const query = Object.entries(params)
      .filter(([_, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');
    url = `${url}?${query}`;
  }

  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'OpenClaw/1.0' },
      signal: AbortSignal.timeout(10000),
    });

    const data = (await resp.json()) as BybitApiResponse;

    if (data.retCode !== 0) {
      return { error: data.retMsg ?? 'Unknown API error', retCode: data.retCode };
    }

    return data.result ?? {};
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export async function getKlines(
  symbol: string,
  interval: string,
  limit: number = 100,
): Promise<OHLC[]> {
  const mappedInterval = TF_MAP[interval] ?? interval;

  const result = await apiGet('/v5/market/kline', {
    category: CATEGORY,
    symbol,
    interval: mappedInterval,
    limit: String(Math.min(limit, 1000)),
  });

  if ('error' in result) {
    log.error('Failed to fetch klines', { symbol, error: result.error as string });
    return [];
  }

  const list = (result.list ?? []) as string[][];
  const rows: OHLC[] = [];

  for (const item of [...list].reverse()) {
    try {
      rows.push({
        time: new Date(parseInt(item[0])).toISOString(),
        open: parseFloat(item[1]),
        high: parseFloat(item[2]),
        low: parseFloat(item[3]),
        close: parseFloat(item[4]),
        volume: parseFloat(item[5]),
        turnover: parseFloat(item[6]),
      });
    } catch {
      continue;
    }
  }

  return rows;
}

export async function getMarketInfo(symbol: string): Promise<MarketInfo | null> {
  const [ticker, funding, oi] = await Promise.all([
    apiGet('/v5/market/tickers', { category: CATEGORY, symbol }),
    apiGet('/v5/market/funding/history', { category: CATEGORY, symbol, limit: '1' }),
    apiGet('/v5/market/open-interest', {
      category: CATEGORY,
      symbol,
      intervalTime: '5min',
      limit: '1',
    }),
  ]);

  const tickerList = (ticker.list ?? []) as Record<string, string>[];
  if (tickerList.length === 0) return null;

  const t = tickerList[0];
  const info: MarketInfo = {
    lastPrice: parseFloat(t.lastPrice ?? '0'),
    price24hPct: parseFloat(t.price24hPcnt ?? '0') * 100,
    volume24h: parseFloat(t.volume24h ?? '0'),
    turnover24h: parseFloat(t.turnover24h ?? '0'),
    high24h: parseFloat(t.highPrice24h ?? '0'),
    low24h: parseFloat(t.lowPrice24h ?? '0'),
    fundingRate: parseFloat(t.fundingRate ?? '0'),
    nextFundingTime: t.nextFundingTime ?? '',
    bid1: parseFloat(t.bid1Price ?? '0'),
    ask1: parseFloat(t.ask1Price ?? '0'),
  };

  const fundingList = (funding.list ?? []) as Record<string, string>[];
  if (fundingList.length > 0) {
    info.lastFundingRate = parseFloat(fundingList[0].fundingRate ?? '0');
    info.lastFundingTime = fundingList[0].fundingRateTimestamp ?? '';
  }

  const oiList = (oi.list ?? []) as Record<string, string>[];
  if (oiList.length > 0) {
    info.openInterest = parseFloat(oiList[0].openInterest ?? '0');
    info.oiTimestamp = oiList[0].timestamp ?? '';
  }

  const fr = info.fundingRate;
  if (fr > 0.0003) {
    info.fundingSignal = 'LONGS_OVERHEATED';
  } else if (fr < -0.0003) {
    info.fundingSignal = 'SHORTS_OVERHEATED';
  } else {
    info.fundingSignal = 'NEUTRAL';
  }

  return info;
}

export async function getMarketAnalysis(
  symbol: string,
  timeframe: string,
  bars: number = 100,
): Promise<MarketAnalysis | null> {
  const rows = await getKlines(symbol, timeframe, bars);
  if (rows.length === 0) return null;

  const closes = rows.map((r) => r.close);
  const highs = rows.map((r) => r.high);
  const lows = rows.map((r) => r.low);

  const ema200 = calculateEma(closes, 200);
  const ema50 = calculateEma(closes, 50);
  const ema20 = calculateEma(closes, 20);
  const rsi14 = calculateRsi(closes, 14);
  const atr14 = calculateAtr(highs, lows, closes, 14);

  const currentPrice = closes[closes.length - 1];
  const ema200Val = ema200.length > 0 ? Math.round(ema200[ema200.length - 1] * 100) / 100 : null;
  const ema50Val = ema50.length > 0 ? Math.round(ema50[ema50.length - 1] * 100) / 100 : null;
  const ema20Val = ema20.length > 0 ? Math.round(ema20[ema20.length - 1] * 100) / 100 : null;

  const levels = calculateSupportResistance(highs, lows);

  const mappedInterval = TF_MAP[timeframe] ?? timeframe;

  return {
    pair: symbol,
    timeframe: mappedInterval,
    barsCount: rows.length,
    source: 'BYBIT_API_V5',
    currentPrice: Math.round(currentPrice * 100) / 100,
    lastBar: rows[rows.length - 1],
    indicators: {
      ema200: ema200Val,
      ema50: ema50Val,
      ema20: ema20Val,
      rsi14,
      atr14,
    },
    levels,
    bias: {
      emaTrend: getEmaTrend(ema50Val, ema200Val),
      priceVsEma200: getPriceVsEma(currentPrice, ema200Val),
      rsiZone: getRsiZone(rsi14),
    },
    timestamp: new Date().toISOString(),
  };
}

export async function getBalance(coin: string = 'USDT'): Promise<AccountInfo> {
  const client = getClient();
  const res = await client.getWalletBalance({ accountType: 'UNIFIED', coin });

  if (res.retCode !== 0) {
    throw new Error(`Failed to get balance: ${res.retMsg}`);
  }

  const account = (res.result as unknown as { list?: Array<Record<string, string>> })?.list?.[0];
  if (!account) throw new Error('Account not found');

  return {
    totalEquity: parseFloat(account.totalEquity || '0'),
    availableBalance: parseFloat(account.totalAvailableBalance || '0'),
    totalWalletBalance: parseFloat(account.totalWalletBalance || '0'),
    unrealisedPnl: parseFloat(account.totalPerpUPL || '0'),
    currency: coin,
  };
}

export async function getPositions(symbol?: string): Promise<Position[]> {
  const client = getClient();
  const params: PositionInfoParamsV5 = { category: CATEGORY, settleCoin: 'USDT' };
  if (symbol) params.symbol = symbol.toUpperCase();

  const res = await client.getPositionInfo(params);
  if (res.retCode !== 0) {
    throw new Error(`Failed to get positions: ${res.retMsg}`);
  }

  const list = ((res.result as { list?: unknown[] })?.list ?? []) as Array<Record<string, string>>;

  return list
    .filter((p) => parseFloat(p.size) > 0)
    .map((p) => ({
      symbol: p.symbol,
      side: p.side === 'Buy' ? 'long' : 'short',
      size: p.size,
      entryPrice: p.avgPrice,
      markPrice: p.markPrice,
      unrealisedPnl: p.unrealisedPnl,
      leverage: p.leverage,
      liqPrice: p.liqPrice,
      stopLoss: p.stopLoss,
      takeProfit: p.takeProfit,
    }));
}

export async function submitOrder(params: {
  symbol: string;
  side: 'Buy' | 'Sell';
  orderType: 'Market' | 'Limit';
  qty: string;
  price?: string;
  stopLoss?: string;
  takeProfit?: string;
}): Promise<OrderResult> {
  const client = getClient();

  const orderParams: OrderParamsV5 = {
    category: CATEGORY,
    symbol: params.symbol.toUpperCase(),
    side: params.side,
    orderType: params.orderType,
    qty: params.qty,
    timeInForce: 'GTC',
    ...(params.orderType === 'Limit' && params.price ? { price: params.price } : {}),
    ...(params.stopLoss ? { stopLoss: params.stopLoss, slTriggerBy: 'LastPrice' as const } : {}),
    ...(params.takeProfit
      ? { takeProfit: params.takeProfit, tpTriggerBy: 'LastPrice' as const }
      : {}),
  };

  const res = await client.submitOrder(orderParams);
  if (res.retCode !== 0) {
    throw new Error(`Failed to create order: ${res.retMsg}`);
  }

  const result = res.result as { orderId: string; orderLinkId?: string };

  return {
    orderId: result.orderId,
    symbol: params.symbol.toUpperCase(),
    side: params.side,
    orderType: params.orderType,
    qty: params.qty,
    price: params.price,
    status: 'EXECUTED',
  };
}

export async function closePosition(symbol: string): Promise<OrderResult> {
  const client = getClient();
  const posRes = await client.getPositionInfo({ category: CATEGORY, symbol: symbol.toUpperCase() });

  if (posRes.retCode !== 0) {
    throw new Error(`Failed to get position: ${posRes.retMsg}`);
  }

  const list = ((posRes.result as { list?: unknown[] })?.list ?? []) as Array<
    Record<string, string>
  >;
  const pos = list.find((p) => parseFloat(p.size) > 0);

  if (!pos) throw new Error(`No open position for ${symbol}`);

  const closeSide = pos.side === 'Buy' ? 'Sell' : 'Buy';

  const res = await client.submitOrder({
    category: CATEGORY,
    symbol: symbol.toUpperCase(),
    side: closeSide,
    orderType: 'Market',
    qty: pos.size,
    timeInForce: 'GTC',
    reduceOnly: true,
  });

  if (res.retCode !== 0) {
    throw new Error(`Failed to close position: ${res.retMsg}`);
  }

  return {
    orderId: res.result.orderId,
    symbol: symbol.toUpperCase(),
    side: closeSide,
    orderType: 'Market',
    qty: pos.size,
    status: 'CLOSED',
  };
}

export async function partialClosePosition(symbol: string, qty: string): Promise<OrderResult> {
  const client = getClient();
  const posRes = await client.getPositionInfo({ category: CATEGORY, symbol: symbol.toUpperCase() });

  if (posRes.retCode !== 0) {
    throw new Error(`Failed to get position: ${posRes.retMsg}`);
  }

  const list = ((posRes.result as { list?: unknown[] })?.list ?? []) as Array<
    Record<string, string>
  >;
  const pos = list.find((p) => parseFloat(p.size) > 0);

  if (!pos) throw new Error(`No open position for ${symbol}`);

  const closeSide = pos.side === 'Buy' ? 'Sell' : 'Buy';

  const res = await client.submitOrder({
    category: CATEGORY,
    symbol: symbol.toUpperCase(),
    side: closeSide,
    orderType: 'Market',
    qty,
    timeInForce: 'GTC',
    reduceOnly: true,
  });

  if (res.retCode !== 0) {
    throw new Error(`Failed to partial close: ${res.retMsg}`);
  }

  return {
    orderId: res.result.orderId,
    symbol: symbol.toUpperCase(),
    side: closeSide,
    orderType: 'Market',
    qty,
    status: 'PARTIAL_CLOSED',
  };
}

export async function modifyPosition(
  symbol: string,
  stopLoss?: string,
  takeProfit?: string,
): Promise<void> {
  const client = getClient();

  const params: SetTradingStopParamsV5 = {
    category: CATEGORY,
    symbol: symbol.toUpperCase(),
    positionIdx: 0,
    ...(stopLoss ? { stopLoss, slTriggerBy: 'LastPrice' as const } : {}),
    ...(takeProfit ? { takeProfit, tpTriggerBy: 'LastPrice' as const } : {}),
  };

  const res = await client.setTradingStop(params);

  if (res.retCode !== 0) {
    throw new Error(`Failed to modify SL/TP: ${res.retMsg}`);
  }
}

export async function closeAllPositions(): Promise<{
  closed: number;
  total: number;
  details: Array<{ symbol: string; qty: string; result: string }>;
}> {
  const client = getClient();
  const posRes = await client.getPositionInfo({ category: CATEGORY, settleCoin: 'USDT' });

  if (posRes.retCode !== 0) {
    throw new Error(`Failed to get positions: ${posRes.retMsg}`);
  }

  const list = ((posRes.result as { list?: unknown[] })?.list ?? []) as Array<
    Record<string, string>
  >;
  const openPositions = list.filter((p) => parseFloat(p.size) > 0);

  if (openPositions.length === 0) {
    return { closed: 0, total: 0, details: [] };
  }

  const details: Array<{ symbol: string; qty: string; result: string }> = [];

  for (const pos of openPositions) {
    const closeSide = pos.side === 'Buy' ? 'Sell' : 'Buy';
    try {
      const res = await client.submitOrder({
        category: CATEGORY,
        symbol: pos.symbol,
        side: closeSide,
        orderType: 'Market',
        qty: pos.size,
        timeInForce: 'GTC',
        reduceOnly: true,
      });
      details.push({
        symbol: pos.symbol,
        qty: pos.size,
        result: res.retCode === 0 ? 'OK' : res.retMsg,
      });
    } catch (err) {
      details.push({
        symbol: pos.symbol,
        qty: pos.size,
        result: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    closed: details.filter((r) => r.result === 'OK').length,
    total: openPositions.length,
    details,
  };
}

export async function setLeverage(symbol: string, leverage: number): Promise<void> {
  if (leverage > MAX_LEVERAGE) {
    throw new Error(`Leverage ${leverage}x exceeds maximum ${MAX_LEVERAGE}x`);
  }

  const client = getClient();
  const res = await client.setLeverage({
    category: CATEGORY,
    symbol: symbol.toUpperCase(),
    buyLeverage: String(leverage),
    sellLeverage: String(leverage),
  });

  if (res.retCode !== 0 && res.retCode !== 110043) {
    throw new Error(`Failed to set leverage: ${res.retMsg}`);
  }
}

export function resetClient(): void {
  _client = null;
}
