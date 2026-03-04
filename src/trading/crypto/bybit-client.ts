import {
  RestClientV5,
  type OrderParamsV5,
  type PositionInfoParamsV5,
  type SetTradingStopParamsV5,
} from 'bybit-api';
import { getBybitBaseUrl, getBybitCredentials } from '../../utils/config.js';
import { createLogger } from '../../utils/logger.js';
import { retryAsync } from '../../utils/retry.js';
import { buildMarketAnalysis } from '../shared/indicators.js';
import type {
  AccountInfo,
  FundingDataPoint,
  MarketAnalysis,
  MarketInfo,
  OIDataPoint,
  OHLC,
  OrderbookData,
  OrderResult,
  Position,
  RecentTrade,
} from '../shared/types.js';
import { TIMEFRAME_MAP as TF_MAP } from '../shared/types.js';

const log = createLogger('bybit-client');

const MAX_LEVERAGE = 5;
const CATEGORY = 'linear' as const;
const API_TIMEOUT_MS = 10_000;
const FUNDING_SIGNAL_THRESHOLD = 0.0003;

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
    const resp = await retryAsync(
      () =>
        fetch(url, {
          headers: { 'User-Agent': 'OpenClaw/1.0' },
          signal: AbortSignal.timeout(API_TIMEOUT_MS),
        }),
      { retries: 2, backoffMs: 500 },
    );

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
        time: new Date(parseInt(item[0] ?? '0')).toISOString(),
        open: parseFloat(item[1] ?? '0'),
        high: parseFloat(item[2] ?? '0'),
        low: parseFloat(item[3] ?? '0'),
        close: parseFloat(item[4] ?? '0'),
        volume: parseFloat(item[5] ?? '0'),
        turnover: parseFloat(item[6] ?? '0'),
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
  if (!t) return null;
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
    const f0 = fundingList[0]!;
    info.lastFundingRate = parseFloat(f0.fundingRate ?? '0');
    info.lastFundingTime = f0.fundingRateTimestamp ?? '';
  }

  const oiList = (oi.list ?? []) as Record<string, string>[];
  if (oiList.length > 0) {
    const o0 = oiList[0]!;
    info.openInterest = parseFloat(o0.openInterest ?? '0');
    info.oiTimestamp = o0.timestamp ?? '';
  }

  const fr = info.fundingRate;
  if (fr > FUNDING_SIGNAL_THRESHOLD) {
    info.fundingSignal = 'LONGS_OVERHEATED';
  } else if (fr < -FUNDING_SIGNAL_THRESHOLD) {
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
  const mappedInterval = TF_MAP[timeframe] ?? timeframe;
  return buildMarketAnalysis(rows, {
    pair: symbol,
    timeframe: mappedInterval,
    source: 'BYBIT_API_V5',
  });
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
    totalEquity: parseFloat(account.totalEquity ?? '0'),
    availableBalance: parseFloat(account.totalAvailableBalance ?? '0'),
    totalWalletBalance: parseFloat(account.totalWalletBalance ?? '0'),
    unrealisedPnl: parseFloat(account.totalPerpUPL ?? '0'),
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
    .filter((p) => parseFloat(p.size ?? '0') > 0)
    .map((p) => ({
      symbol: p.symbol ?? '',
      side: p.side === 'Buy' ? 'long' : 'short',
      size: p.size ?? '0',
      entryPrice: p.avgPrice ?? '0',
      markPrice: p.markPrice ?? '0',
      unrealisedPnl: p.unrealisedPnl ?? '0',
      leverage: p.leverage ?? '0',
      liqPrice: p.liqPrice ?? '0',
      stopLoss: p.stopLoss ?? '0',
      takeProfit: p.takeProfit ?? '0',
    }));
}

export async function getOpenOrders(symbol?: string): Promise<string[]> {
  const result = await apiGet('/v5/order/realtime', {
    category: CATEGORY,
    ...(symbol ? { symbol: symbol.toUpperCase() } : { settleCoin: 'USDT' }),
  });

  if ('error' in result) {
    log.warn('Failed to fetch open orders', { error: result.error as string });
    return [];
  }

  const list = (result.list ?? []) as Array<Record<string, string>>;
  return list.map((o) => o.symbol ?? '').filter(Boolean);
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
    const msg = res.retMsg ?? 'Unknown error';
    // Extract base price from error for helpful debugging
    const priceMatch = msg.match(/base_price:(\d+)/);
    const hint = priceMatch?.[1]
      ? ` (current price ≈ ${(parseInt(priceMatch[1]) / 10000000).toFixed(2)})`
      : '';
    throw new Error(`Order REJECTED: ${msg}${hint}`);
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
  const pos = list.find((p) => parseFloat(p.size ?? '0') > 0);

  if (!pos) throw new Error(`No open position for ${symbol}`);

  const closeSide = pos.side === 'Buy' ? 'Sell' : 'Buy';

  const res = await client.submitOrder({
    category: CATEGORY,
    symbol: symbol.toUpperCase(),
    side: closeSide,
    orderType: 'Market',
    qty: pos.size ?? '0',
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
    qty: pos.size ?? '0',
    status: 'CLOSED',
  };
}

export async function partialClosePosition(symbol: string, qty: string): Promise<OrderResult> {
  const client = getClient();
  const posRes = await retryAsync(
    () => client.getPositionInfo({ category: CATEGORY, symbol: symbol.toUpperCase() }),
    { retries: 2, backoffMs: 500 },
  );

  if (posRes.retCode !== 0) {
    throw new Error(`Failed to get position: ${posRes.retMsg}`);
  }

  const list = ((posRes.result as { list?: unknown[] })?.list ?? []) as Array<
    Record<string, string>
  >;
  const pos = list.find((p) => parseFloat(p.size ?? '0') > 0);

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

  await retryAsync(
    async () => {
      const res = await client.setTradingStop(params);
      if (res.retCode !== 0) {
        throw new Error(`Failed to modify SL/TP: ${res.retMsg}`);
      }
    },
    { retries: 3, backoffMs: 1000 },
  );
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
  const openPositions = list.filter((p) => parseFloat(p.size ?? '0') > 0);

  if (openPositions.length === 0) {
    return { closed: 0, total: 0, details: [] };
  }

  const details: Array<{ symbol: string; qty: string; result: string }> = [];

  for (const pos of openPositions) {
    const closeSide = pos.side === 'Buy' ? 'Sell' : 'Buy';
    try {
      const res = await client.submitOrder({
        category: CATEGORY,
        symbol: pos.symbol ?? '',
        side: closeSide,
        orderType: 'Market',
        qty: pos.size ?? '0',
        timeInForce: 'GTC',
        reduceOnly: true,
      });
      details.push({
        symbol: pos.symbol ?? '',
        qty: pos.size ?? '0',
        result: res.retCode === 0 ? 'OK' : res.retMsg,
      });
    } catch (err) {
      details.push({
        symbol: pos.symbol ?? '',
        qty: pos.size ?? '0',
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

// ─── Extended Market Data (Confluence System) ────────────────────

export async function getOrderbook(symbol: string, limit: number = 25): Promise<OrderbookData> {
  const result = await apiGet('/v5/market/orderbook', {
    category: CATEGORY,
    symbol,
    limit: String(Math.min(limit, 200)),
  });

  const empty: OrderbookData = {
    bids: [],
    asks: [],
    bidWallPrice: 0,
    askWallPrice: 0,
    imbalance: 0,
    spread: 0,
    timestamp: new Date().toISOString(),
  };

  if ('error' in result) {
    log.error('Failed to fetch orderbook', { symbol, error: result.error as string });
    return empty;
  }

  const rawBids = (result.b ?? []) as string[][];
  const rawAsks = (result.a ?? []) as string[][];

  const bids = rawBids.map((b) => ({
    price: parseFloat(b[0] ?? '0'),
    qty: parseFloat(b[1] ?? '0'),
  }));
  const asks = rawAsks.map((a) => ({
    price: parseFloat(a[0] ?? '0'),
    qty: parseFloat(a[1] ?? '0'),
  }));

  let bidWall = bids[0] ?? { price: 0, qty: 0 };
  for (const b of bids) {
    if (b.qty > bidWall.qty) bidWall = b;
  }

  let askWall = asks[0] ?? { price: 0, qty: 0 };
  for (const a of asks) {
    if (a.qty > askWall.qty) askWall = a;
  }

  const totalBidQty = bids.reduce((s, b) => s + b.qty, 0);
  const totalAskQty = asks.reduce((s, a) => s + a.qty, 0);
  const totalQty = totalBidQty + totalAskQty;
  const imbalance = totalQty > 0 ? (totalBidQty - totalAskQty) / totalQty : 0;

  const bid1 = bids[0]?.price ?? 0;
  const ask1 = asks[0]?.price ?? 0;

  return {
    bids: bids.slice(0, limit),
    asks: asks.slice(0, limit),
    bidWallPrice: bidWall.price,
    askWallPrice: askWall.price,
    imbalance: Math.round(imbalance * 1000) / 1000,
    spread: Math.round((ask1 - bid1) * 100) / 100,
    timestamp: new Date().toISOString(),
  };
}

export async function getOIHistory(symbol: string, hours: number = 24): Promise<OIDataPoint[]> {
  const result = await apiGet('/v5/market/open-interest', {
    category: CATEGORY,
    symbol,
    intervalTime: '5min',
    limit: String(Math.min(Math.ceil((hours * 60) / 5), 200)),
  });

  if ('error' in result) {
    log.error('Failed to fetch OI history', { symbol, error: result.error as string });
    return [];
  }

  const list = (result.list ?? []) as Array<Record<string, string>>;
  const points: OIDataPoint[] = [];

  const reversed = [...list].reverse();
  for (let i = 0; i < reversed.length; i++) {
    const item = reversed[i]!;
    const oi = parseFloat(item.openInterest ?? '0');
    const prevOi = i > 0 ? parseFloat(reversed[i - 1]!.openInterest ?? '0') : oi;

    points.push({
      timestamp: item.timestamp
        ? new Date(parseInt(item.timestamp)).toISOString()
        : new Date().toISOString(),
      openInterest: oi,
      delta: Math.round((oi - prevOi) * 100) / 100,
    });
  }

  return points;
}

export async function getFundingHistory(
  symbol: string,
  limit: number = 20,
): Promise<FundingDataPoint[]> {
  const result = await apiGet('/v5/market/funding/history', {
    category: CATEGORY,
    symbol,
    limit: String(Math.min(limit, 200)),
  });

  if ('error' in result) {
    log.error('Failed to fetch funding history', { symbol, error: result.error as string });
    return [];
  }

  const list = (result.list ?? []) as Array<Record<string, string>>;

  return [...list].reverse().map((item) => ({
    timestamp: item.fundingRateTimestamp
      ? new Date(parseInt(item.fundingRateTimestamp)).toISOString()
      : new Date().toISOString(),
    rate: parseFloat(item.fundingRate ?? '0'),
  }));
}

export async function getRecentTrades(
  symbol: string,
  limit: number = 1000,
): Promise<RecentTrade[]> {
  const result = await apiGet('/v5/market/recent-trade', {
    category: CATEGORY,
    symbol,
    limit: String(Math.min(limit, 1000)),
  });

  if ('error' in result) {
    log.error('Failed to fetch recent trades', { symbol, error: result.error as string });
    return [];
  }

  const list = (result.list ?? []) as Array<Record<string, string>>;

  return list.map((t) => ({
    price: parseFloat(t.price ?? '0'),
    qty: parseFloat(t.size ?? '0'),
    side: (t.side ?? 'Buy') as 'Buy' | 'Sell',
    time: t.time ? new Date(parseInt(t.time)).toISOString() : new Date().toISOString(),
  }));
}

export function resetClient(): void {
  _client = null;
}
