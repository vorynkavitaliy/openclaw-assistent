/**
 * Forex Client — обёртка над ctrader-ts для работы через агентов OpenClaw.
 *
 * Предоставляет API совместимый с crypto bybit-client:
 *   getKlines, getMarketAnalysis, getBalance, getPositions,
 *   submitOrder, closePosition, modifyPosition.
 *
 * Использует ctrader-ts connect() + env-переменные или ~/.config/ctrader-ts/config.json
 */

import {
  connect,
  TrendbarPeriod,
  unitsToLots,
  type CTrader,
  type Position as CTraderPosition,
  type MarketOrderOptions,
  type ModifyOptions,
  type SlTpSpec,
  type Trendbar,
} from 'ctrader-ts';
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

const log = createLogger('forex-client');

// ─── cTrader connection singleton ─────────────────────────────

let client: CTrader | null = null;

async function getClient(): Promise<CTrader> {
  if (!client) {
    log.info('Подключение к cTrader...');
    client = await connect();
    log.info('cTrader: подключено');
  }
  return client;
}

export async function disconnect(): Promise<void> {
  if (client) {
    await client.disconnect();
    client = null;
    log.info('cTrader: отключено');
  }
}

// ─── Timeframe mapping ───────────────────────────────────────

const TIMEFRAME_MAP: Record<string, TrendbarPeriod> = {
  M1: TrendbarPeriod.M1,
  M5: TrendbarPeriod.M5,
  M15: TrendbarPeriod.M15,
  M30: TrendbarPeriod.M30,
  H1: TrendbarPeriod.H1,
  H4: TrendbarPeriod.H4,
  D1: TrendbarPeriod.D1,
  W1: TrendbarPeriod.W1,
  MN: TrendbarPeriod.MN1,
};

function toTrendbarPeriod(tf: string): TrendbarPeriod {
  const period = TIMEFRAME_MAP[tf.toUpperCase()];
  if (period === undefined) {
    throw new Error(
      `Неизвестный таймфрейм: ${tf}. Доступны: ${Object.keys(TIMEFRAME_MAP).join(', ')}`,
    );
  }
  return period;
}

// ─── Market Data ─────────────────────────────────────────────

/**
 * Получить OHLC свечи.
 */
export async function getKlines(
  symbol: string,
  timeframe: string,
  count: number = 100,
): Promise<OHLC[]> {
  const ct = await getClient();
  const period = toTrendbarPeriod(timeframe);

  const { trendbars } = await ct.getTrendbars(symbol, { period, count });

  // cTrader Trendbar uses delta format: low is base, deltas are offsets
  return trendbars.map((bar: Trendbar) => {
    const low = bar.low ?? 0;
    const open = low + (bar.deltaOpen ?? 0);
    const high = low + (bar.deltaHigh ?? 0);
    const close = low + (bar.deltaClose ?? 0);
    const ts = (bar.utcTimestampInMinutes ?? 0) * 60 * 1000;

    return {
      timestamp: ts,
      time: new Date(ts).toISOString(),
      open,
      high,
      low,
      close,
      volume: bar.volume ?? 0,
    };
  });
}

/**
 * Получить полный анализ рынка по паре.
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
      source: 'cTrader',
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
 */
export async function getBalance(): Promise<AccountInfo> {
  const ct = await getClient();
  const state = await ct.getState();

  return {
    totalEquity: state.equity,
    availableBalance: state.freeMargin,
    totalWalletBalance: state.balance,
    unrealisedPnl: state.unrealizedPnl,
    currency: 'USD',
  };
}

/**
 * Получить открытые позиции.
 */
export async function getPositions(): Promise<OurPosition[]> {
  const ct = await getClient();
  const { positions } = await ct.getPositions();

  return positions.map((p: CTraderPosition) => {
    const td = p.tradeData;
    const lots = unitsToLots(td.volume);
    return {
      symbol: String(td.symbolId),
      side: (td.tradeSide === 1 ? 'long' : 'short') as 'long' | 'short',
      size: String(lots),
      entryPrice: String(p.price ?? 0),
      markPrice: '0',
      unrealisedPnl: '0',
      leverage: '30',
      stopLoss: String(p.stopLoss ?? 0),
      takeProfit: String(p.takeProfit ?? 0),
      positionId: String(p.positionId),
    };
  });
}

// ─── Trading ─────────────────────────────────────────────────

/**
 * Открыть ордер.
 */
export async function submitOrder(params: {
  symbol: string;
  side: 'Buy' | 'Sell';
  lots: number;
  sl?: SlTpSpec;
  tp?: SlTpSpec;
}): Promise<OrderResult> {
  const ct = await getClient();

  const opts: MarketOrderOptions = { lots: params.lots };
  if (params.sl) opts.sl = params.sl;
  if (params.tp) opts.tp = params.tp;

  const position =
    params.side === 'Buy' ? await ct.buy(params.symbol, opts) : await ct.sell(params.symbol, opts);

  log.info(`Ордер открыт: ${params.side} ${params.symbol} ${params.lots} lots`, {
    positionId: position.positionId,
  });

  return {
    orderId: String(position.positionId),
    symbol: params.symbol,
    side: params.side,
    orderType: 'Market',
    qty: String(params.lots),
    status: 'EXECUTED',
  };
}

/**
 * Закрыть позицию (полностью или частично).
 */
export async function closePosition(positionId: number, partialLots?: number): Promise<void> {
  const ct = await getClient();
  if (partialLots) {
    await ct.close(positionId, { lots: partialLots });
  } else {
    await ct.close(positionId);
  }
  log.info(`Позиция ${positionId} закрыта`, { partial: partialLots });
}

/**
 * Модифицировать SL/TP позиции.
 */
export async function modifyPosition(positionId: number, opts: ModifyOptions): Promise<void> {
  const ct = await getClient();
  await ct.modify(positionId, opts);
  log.info(`Позиция ${positionId} модифицирована`);
}

/**
 * Закрыть все позиции.
 */
export async function closeAll(): Promise<void> {
  const ct = await getClient();
  await ct.closeAll();
  log.info('Все позиции закрыты');
}

/**
 * Закрыть позиции по символу.
 */
export async function closeSymbol(symbol: string): Promise<void> {
  const ct = await getClient();
  await ct.closeSymbol(symbol);
  log.info(`Позиции по ${symbol} закрыты`);
}

/**
 * Получить историю сделок.
 */
export async function getDeals(maxRows: number = 50): Promise<unknown[]> {
  const ct = await getClient();
  const { deals } = await ct.getDeals(undefined, undefined, maxRows);
  return deals;
}
