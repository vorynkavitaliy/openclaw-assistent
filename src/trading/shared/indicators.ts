import type { MarketAnalysis, OHLC } from './types.js';

export function calculateEma(prices: number[], period: number): number[] {
  if (prices.length < period) return [];

  const k = 2 / (period + 1);

  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += prices[i]!;
  }

  const ema: number[] = [sum / period];

  for (let i = period; i < prices.length; i++) {
    ema.push(prices[i]! * k + ema[ema.length - 1]! * (1 - k));
  }

  return ema;
}

export function calculateRsi(closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return 50.0;

  const deltas: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    deltas.push(closes[i]! - closes[i - 1]!);
  }

  const recentDeltas = deltas.slice(-period);
  const gains = recentDeltas.filter((d) => d > 0);
  const losses = recentDeltas.filter((d) => d < 0).map((d) => Math.abs(d));

  const avgGain = gains.length > 0 ? gains.reduce((a, b) => a + b, 0) / period : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / period : 0;

  if (avgLoss === 0) return 100.0;

  const rs = avgGain / avgLoss;

  return Math.round((100 - 100 / (1 + rs)) * 100) / 100;
}

export function calculateAtr(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number = 14,
): number {
  if (highs.length < period + 1) return 0.0;

  const trs: number[] = [];
  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(
      highs[i]! - lows[i]!,
      Math.abs(highs[i]! - closes[i - 1]!),
      Math.abs(lows[i]! - closes[i - 1]!),
    );
    trs.push(tr);
  }

  const recentTrs = trs.slice(-period);

  return Math.round((recentTrs.reduce((a, b) => a + b, 0) / period) * 100) / 100;
}

export function calculateSupportResistance(
  highs: number[],
  lows: number[],
  lookback: number = 20,
): { support: number; resistance: number } {
  const recent = Math.min(lookback, highs.length);
  const recentHighs = highs.slice(-recent);
  const recentLows = lows.slice(-recent);

  return {
    support: Math.round(Math.min(...recentLows) * 100) / 100,
    resistance: Math.round(Math.max(...recentHighs) * 100) / 100,
  };
}

export function getEmaTrend(
  ema50: number | null,
  ema200: number | null,
): 'BULLISH' | 'BEARISH' | 'UNKNOWN' {
  if (ema50 === null || ema200 === null) return 'UNKNOWN';

  return ema50 > ema200 ? 'BULLISH' : 'BEARISH';
}

export function getPriceVsEma(price: number, ema200: number | null): 'ABOVE' | 'BELOW' | 'UNKNOWN' {
  if (ema200 === null) return 'UNKNOWN';

  return price > ema200 ? 'ABOVE' : 'BELOW';
}

export function getRsiZone(rsi: number): 'OVERBOUGHT' | 'OVERSOLD' | 'NEUTRAL' {
  if (rsi > 70) return 'OVERBOUGHT';
  if (rsi < 30) return 'OVERSOLD';

  return 'NEUTRAL';
}

export function buildMarketAnalysis(
  candles: OHLC[],
  params: { pair: string; timeframe: string; source: string },
): MarketAnalysis | null {
  if (candles.length < 20) return null;

  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  const ema200 = calculateEma(closes, 200);
  const ema50 = calculateEma(closes, 50);
  const ema20 = calculateEma(closes, 20);
  const rsi14 = calculateRsi(closes, 14);
  const atr14 = calculateAtr(highs, lows, closes, 14);
  const levels = calculateSupportResistance(highs, lows);

  const currentPrice = closes[closes.length - 1]!;
  const lastBar = candles[candles.length - 1]!;

  const ema200Val = ema200.length > 0 ? Math.round(ema200[ema200.length - 1]! * 100) / 100 : null;
  const ema50Val = ema50.length > 0 ? Math.round(ema50[ema50.length - 1]! * 100) / 100 : null;
  const ema20Val = ema20.length > 0 ? Math.round(ema20[ema20.length - 1]! * 100) / 100 : null;

  return {
    pair: params.pair,
    timeframe: params.timeframe,
    barsCount: candles.length,
    source: params.source,
    currentPrice: Math.round(currentPrice * 100) / 100,
    lastBar,
    indicators: { ema200: ema200Val, ema50: ema50Val, ema20: ema20Val, rsi14, atr14 },
    levels,
    bias: {
      emaTrend: getEmaTrend(ema50Val, ema200Val),
      priceVsEma200: getPriceVsEma(currentPrice, ema200Val),
      rsiZone: getRsiZone(rsi14),
    },
    timestamp: new Date().toISOString(),
  };
}
