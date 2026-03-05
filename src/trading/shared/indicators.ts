import type { MACDResult, MarketAnalysis, OHLC, StochRSIResult } from './types.js';

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

/**
 * RSI с Wilder smoothing (стандарт TradingView).
 * Первый avgGain/avgLoss — SMA, далее smoothed: prev*(period-1)+current / period.
 */
export function calculateRsi(closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return 50.0;

  const deltas: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    deltas.push(closes[i]! - closes[i - 1]!);
  }

  // Initial SMA for first period
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    const d = deltas[i]!;
    if (d > 0) avgGain += d;
    else avgLoss += Math.abs(d);
  }
  avgGain /= period;
  avgLoss /= period;

  // Wilder smoothing for remaining periods
  for (let i = period; i < deltas.length; i++) {
    const d = deltas[i]!;
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? Math.abs(d) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100.0;

  const rs = avgGain / avgLoss;
  return Math.round((100 - 100 / (1 + rs)) * 100) / 100;
}

/**
 * Рассчитывает массив RSI значений (для StochRSI).
 */
export function calculateRsiSeries(closes: number[], period: number = 14): number[] {
  if (closes.length < period + 1) return [];

  const deltas: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    deltas.push(closes[i]! - closes[i - 1]!);
  }

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    const d = deltas[i]!;
    if (d > 0) avgGain += d;
    else avgLoss += Math.abs(d);
  }
  avgGain /= period;
  avgLoss /= period;

  const rsiValues: number[] = [];
  const rs0 = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  rsiValues.push(Math.round(rs0 * 100) / 100);

  for (let i = period; i < deltas.length; i++) {
    const d = deltas[i]!;
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? Math.abs(d) : 0)) / period;
    const rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    rsiValues.push(Math.round(rsi * 100) / 100);
  }

  return rsiValues;
}

export function calculateMACD(
  closes: number[],
  fast: number = 12,
  slow: number = 26,
  signalPeriod: number = 9,
): MACDResult {
  if (closes.length < slow + signalPeriod) {
    return { macd: 0, signal: 0, histogram: 0 };
  }

  const emaFast = calculateEma(closes, fast);
  const emaSlow = calculateEma(closes, slow);

  // Align arrays: emaSlow starts later than emaFast
  const offset = slow - fast;
  const macdLine: number[] = [];
  for (let i = 0; i < emaSlow.length; i++) {
    macdLine.push(emaFast[i + offset]! - emaSlow[i]!);
  }

  if (macdLine.length < signalPeriod) {
    return { macd: 0, signal: 0, histogram: 0 };
  }

  const signalLine = calculateEma(macdLine, signalPeriod);
  const lastMacd = macdLine[macdLine.length - 1]!;
  const lastSignal = signalLine[signalLine.length - 1]!;

  return {
    macd: Math.round(lastMacd * 10000) / 10000,
    signal: Math.round(lastSignal * 10000) / 10000,
    histogram: Math.round((lastMacd - lastSignal) * 10000) / 10000,
  };
}

export function calculateStochRSI(
  closes: number[],
  rsiPeriod: number = 14,
  kPeriod: number = 3,
  dPeriod: number = 3,
  stochPeriod: number = 14,
): StochRSIResult {
  const rsiSeries = calculateRsiSeries(closes, rsiPeriod);
  if (rsiSeries.length < stochPeriod) {
    return { k: 50, d: 50 };
  }

  // Stochastic of RSI
  const stochK: number[] = [];
  for (let i = stochPeriod - 1; i < rsiSeries.length; i++) {
    const window = rsiSeries.slice(i - stochPeriod + 1, i + 1);
    const hi = Math.max(...window);
    const lo = Math.min(...window);
    const k = hi === lo ? 50 : ((rsiSeries[i]! - lo) / (hi - lo)) * 100;
    stochK.push(k);
  }

  // Smooth K with SMA(kPeriod)
  const smoothedK: number[] = [];
  for (let i = kPeriod - 1; i < stochK.length; i++) {
    let sum = 0;
    for (let j = 0; j < kPeriod; j++) sum += stochK[i - j]!;
    smoothedK.push(sum / kPeriod);
  }

  // D = SMA of smoothed K
  const dValues: number[] = [];
  for (let i = dPeriod - 1; i < smoothedK.length; i++) {
    let sum = 0;
    for (let j = 0; j < dPeriod; j++) sum += smoothedK[i - j]!;
    dValues.push(sum / dPeriod);
  }

  const lastK = smoothedK.length > 0 ? smoothedK[smoothedK.length - 1]! : 50;
  const lastD = dValues.length > 0 ? dValues[dValues.length - 1]! : 50;

  return {
    k: Math.round(lastK * 100) / 100,
    d: Math.round(lastD * 100) / 100,
  };
}

export function calculateVWAP(candles: OHLC[]): number {
  if (candles.length === 0) return 0;

  let cumulativeTPV = 0;
  let cumulativeVolume = 0;

  for (const c of candles) {
    const typicalPrice = (c.high + c.low + c.close) / 3;
    cumulativeTPV += typicalPrice * c.volume;
    cumulativeVolume += c.volume;
  }

  if (cumulativeVolume === 0) return candles[candles.length - 1]!.close;

  return Math.round((cumulativeTPV / cumulativeVolume) * 100) / 100;
}

/**
 * ADX (Average Directional Index) — определяет силу тренда.
 * > 25 = trending, < 20 = ranging, > 40 = strong trend.
 */
export function calculateADX(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number = 14,
): number {
  if (highs.length < period * 2 + 1) return 0;

  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const tr: number[] = [];

  for (let i = 1; i < highs.length; i++) {
    const upMove = highs[i]! - highs[i - 1]!;
    const downMove = lows[i - 1]! - lows[i]!;

    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(
      Math.max(
        highs[i]! - lows[i]!,
        Math.abs(highs[i]! - closes[i - 1]!),
        Math.abs(lows[i]! - closes[i - 1]!),
      ),
    );
  }

  // Wilder smoothing
  let smoothPlusDM = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothMinusDM = minusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothTR = tr.slice(0, period).reduce((a, b) => a + b, 0);

  const dx: number[] = [];

  for (let i = period; i < plusDM.length; i++) {
    smoothPlusDM = smoothPlusDM - smoothPlusDM / period + plusDM[i]!;
    smoothMinusDM = smoothMinusDM - smoothMinusDM / period + minusDM[i]!;
    smoothTR = smoothTR - smoothTR / period + tr[i]!;

    const plusDI = smoothTR > 0 ? (smoothPlusDM / smoothTR) * 100 : 0;
    const minusDI = smoothTR > 0 ? (smoothMinusDM / smoothTR) * 100 : 0;
    const diSum = plusDI + minusDI;
    dx.push(diSum > 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0);
  }

  if (dx.length < period) return 0;

  // First ADX = SMA of DX
  let adx = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;

  // Smooth ADX
  for (let i = period; i < dx.length; i++) {
    adx = (adx * (period - 1) + dx[i]!) / period;
  }

  return Math.round(adx * 100) / 100;
}

/**
 * Bollinger Bands width (normalized).
 * Low width = ranging/consolidation, high width = volatile.
 */
export function calculateBBWidth(closes: number[], period: number = 20, mult: number = 2): number {
  if (closes.length < period) return 0;

  const recentCloses = closes.slice(-period);
  const sma = recentCloses.reduce((a, b) => a + b, 0) / period;

  let variance = 0;
  for (const c of recentCloses) {
    variance += (c - sma) ** 2;
  }
  const stdDev = Math.sqrt(variance / period);
  const upper = sma + mult * stdDev;
  const lower = sma - mult * stdDev;

  // Normalized width: (upper - lower) / sma * 100
  return sma > 0 ? Math.round(((upper - lower) / sma) * 10000) / 100 : 0;
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

  // Wilder smoothing (как в RSI/ADX): первое значение = SMA, далее экспоненциальное
  let atr = 0;
  for (let i = 0; i < period; i++) {
    atr += trs[i] ?? 0;
  }
  atr /= period;

  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + (trs[i] ?? 0)) / period;
  }

  // Динамическое округление: 8 знаков для дешёвых активов, чтобы ATR не обнулялся
  return parseFloat(atr.toPrecision(8));
}

/**
 * Кластерный расчёт S/R уровней.
 * Находит свинг-хаи и свинг-лоу (3-барные пивоты), группирует их в кластеры
 * по близости цены (± clusterPct%), возвращает наиболее значимые.
 * Fallback: min/max как раньше если нет достаточно данных.
 */
export function calculateSupportResistance(
  highs: number[],
  lows: number[],
  lookback: number = 50,
): { support: number; resistance: number } {
  const n = Math.min(lookback, highs.length);
  if (n < 5) {
    const recentHighs = highs.slice(-n);
    const recentLows = lows.slice(-n);
    return {
      support: Math.round(Math.min(...recentLows) * 100) / 100,
      resistance: Math.round(Math.max(...recentHighs) * 100) / 100,
    };
  }

  const startIdx = highs.length - n;
  const currentPrice = (highs[highs.length - 1]! + lows[lows.length - 1]!) / 2;
  const clusterPct = 0.5; // ±0.5% для группировки

  // Собираем свинг-хаи (pivot high: середина выше обоих соседей)
  const swingHighs: number[] = [];
  const swingLows: number[] = [];

  for (let i = startIdx + 1; i < highs.length - 1; i++) {
    if (highs[i]! > highs[i - 1]! && highs[i]! > highs[i + 1]!) {
      swingHighs.push(highs[i]!);
    }
    if (lows[i]! < lows[i - 1]! && lows[i]! < lows[i + 1]!) {
      swingLows.push(lows[i]!);
    }
  }

  // Группируем уровни в кластеры, берём среднее кластера
  function cluster(levels: number[]): number[] {
    if (levels.length === 0) return [];
    const sorted = [...levels].sort((a, b) => a - b);
    const clusters: number[][] = [[sorted[0]!]];

    for (let i = 1; i < sorted.length; i++) {
      const last = clusters[clusters.length - 1]!;
      const avg = last.reduce((s, v) => s + v, 0) / last.length;
      if (Math.abs(sorted[i]! - avg) / avg < clusterPct / 100) {
        last.push(sorted[i]!);
      } else {
        clusters.push([sorted[i]!]);
      }
    }

    return clusters.map((c) => c.reduce((s, v) => s + v, 0) / c.length);
  }

  const resistanceLevels = cluster(swingHighs).filter((r) => r > currentPrice);
  const supportLevels = cluster(swingLows).filter((s) => s < currentPrice);

  // Ближайший resistance сверху, ближайший support снизу
  const resistance =
    resistanceLevels.length > 0
      ? Math.min(...resistanceLevels)
      : Math.round(Math.max(...highs.slice(-n)) * 100) / 100;

  const support =
    supportLevels.length > 0
      ? Math.max(...supportLevels)
      : Math.round(Math.min(...lows.slice(-n)) * 100) / 100;

  return {
    support: Math.round(support * 100) / 100,
    resistance: Math.round(resistance * 100) / 100,
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

  // Динамическое округление: toPrecision(8) сохраняет точность для любых ценовых уровней
  const roundSig = (v: number): number => parseFloat(v.toPrecision(8));
  const ema200Val = ema200.length > 0 ? roundSig(ema200[ema200.length - 1]!) : null;
  const ema50Val = ema50.length > 0 ? roundSig(ema50[ema50.length - 1]!) : null;
  const ema20Val = ema20.length > 0 ? roundSig(ema20[ema20.length - 1]!) : null;

  return {
    pair: params.pair,
    timeframe: params.timeframe,
    barsCount: candles.length,
    source: params.source,
    currentPrice: roundSig(currentPrice),
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
