export function calculateEma(prices: number[], period: number): number[] {
  if (prices.length < period) return [];

  const k = 2 / (period + 1);

  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += prices[i];
  }

  const ema: number[] = [sum / period];

  for (let i = period; i < prices.length; i++) {
    ema.push(prices[i] * k + ema[ema.length - 1] * (1 - k));
  }

  return ema;
}

export function calculateRsi(closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return 50.0;

  const deltas: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    deltas.push(closes[i] - closes[i - 1]);
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
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
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
