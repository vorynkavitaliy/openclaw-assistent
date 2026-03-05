import { calculateADX, calculateAtr, calculateBBWidth, calculateEma } from './indicators.js';
import type { MarketRegime, OHLC } from './types.js';

/**
 * Market Regime Detector.
 * Определяет текущий рыночный режим на основе ADX, ATR ratio, BB width, EMA alignment.
 */
export function detectMarketRegime(candles: OHLC[]): MarketRegime {
  if (candles.length < 50) return 'RANGING';

  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  const adx = calculateADX(highs, lows, closes, 14);
  const bbWidth = calculateBBWidth(closes, 20, 2);
  const atrRatio = calculateAtrRatio(highs, lows, closes);
  const emaAlignment = getEmaAlignment(closes);

  // Score-based detection
  let trendScore = 0;
  let volatilityScore = 0;

  // ADX contribution
  if (adx > 40) trendScore += 3;
  else if (adx > 25) trendScore += 2;
  else if (adx > 20) trendScore += 1;

  // EMA alignment contribution
  if (emaAlignment === 'ALIGNED') trendScore += 3;
  else if (emaAlignment === 'PARTIAL') trendScore += 1;
  else if (emaAlignment === 'CROSSING') trendScore -= 1;

  // ATR ratio contribution (volatility)
  if (atrRatio > 2.0) volatilityScore += 3;
  else if (atrRatio > 1.5) volatilityScore += 2;
  else if (atrRatio > 1.2) volatilityScore += 1;
  else if (atrRatio < 0.6) volatilityScore -= 2;
  else if (atrRatio < 0.8) volatilityScore -= 1;

  // BB width contribution
  if (bbWidth > 6) volatilityScore += 2;
  else if (bbWidth > 4) volatilityScore += 1;
  else if (bbWidth < 1.5) volatilityScore -= 2;
  else if (bbWidth < 2.5) volatilityScore -= 1;

  // EMA crosses detection (choppiness)
  const crossCount = countEmaCrosses(closes, 20, 50);

  // Decision
  if (volatilityScore >= 4) return 'VOLATILE';
  if (crossCount >= 4 && trendScore <= 1) return 'CHOPPY';
  if (trendScore >= 5) return 'STRONG_TREND';
  if (trendScore >= 3) return 'WEAK_TREND';
  return 'RANGING';
}

/**
 * ATR ratio: текущий ATR / средний ATR за 50 периодов.
 * > 1.5 = повышенная волатильность, < 0.7 = пониженная.
 */
function calculateAtrRatio(highs: number[], lows: number[], closes: number[]): number {
  const currentAtr = calculateAtr(highs, lows, closes, 14);

  // ATR за более длинный период для среднего
  const longAtr = calculateAtr(highs, lows, closes, 50);

  if (longAtr === 0) return 1;
  return currentAtr / longAtr;
}

type EmaAlignmentResult = 'ALIGNED' | 'PARTIAL' | 'MIXED' | 'CROSSING';

/**
 * EMA Fan: проверяем расположение EMA 20/50/200.
 * ALIGNED: все в одном направлении (20 > 50 > 200 или наоборот)
 * PARTIAL: 2 из 3 в одном направлении
 * CROSSING: частые пересечения
 */
function getEmaAlignment(closes: number[]): EmaAlignmentResult {
  const ema20 = calculateEma(closes, 20);
  const ema50 = calculateEma(closes, 50);
  const ema200 = calculateEma(closes, 200);

  if (ema200.length === 0) {
    // Не хватает данных для EMA200, используем только 20/50
    if (ema50.length === 0) return 'MIXED';
    const last20 = ema20[ema20.length - 1]!;
    const last50 = ema50[ema50.length - 1]!;
    return last20 !== last50 ? 'PARTIAL' : 'MIXED';
  }

  // Выравниваем по длине EMA200 (самый короткий)
  const offset20 = ema20.length - ema200.length;
  const offset50 = ema50.length - ema200.length;

  const last20 = ema20[ema20.length - 1]!;
  const last50 = ema50[ema50.length - 1]!;
  const last200 = ema200[ema200.length - 1]!;

  const bullish = last20 > last50 && last50 > last200;
  const bearish = last20 < last50 && last50 < last200;

  if (bullish || bearish) return 'ALIGNED';

  // Проверяем partial: хотя бы 2 EMA в одном направлении
  const partialBull = (last20 > last50 && last20 > last200) || last50 > last200;
  const partialBear = (last20 < last50 && last20 < last200) || last50 < last200;

  if (partialBull || partialBear) {
    // Проверяем на пересечения в последних 10 барах
    const recentCrosses = countRecentCrosses(ema20, ema50, offset20, offset50, 10);
    if (recentCrosses >= 2) return 'CROSSING';
    return 'PARTIAL';
  }

  return 'MIXED';
}

/**
 * Считает количество пересечений EMA20 и EMA50 за последние N баров.
 */
function countEmaCrosses(closes: number[], shortPeriod: number, longPeriod: number): number {
  const emaShort = calculateEma(closes, shortPeriod);
  const emaLong = calculateEma(closes, longPeriod);

  if (emaLong.length < 20) return 0;

  const offset = emaShort.length - emaLong.length;
  const lookback = Math.min(20, emaLong.length - 1);
  let crosses = 0;

  for (let i = emaLong.length - lookback; i < emaLong.length; i++) {
    const shortIdx = i + offset;
    if (shortIdx < 1) continue;

    const prevAbove = emaShort[shortIdx - 1]! > emaLong[i - 1]!;
    const currAbove = emaShort[shortIdx]! > emaLong[i]!;

    if (prevAbove !== currAbove) crosses++;
  }

  return crosses;
}

function countRecentCrosses(
  ema1: number[],
  ema2: number[],
  offset1: number,
  offset2: number,
  lookback: number,
): number {
  const len = Math.min(ema1.length - offset1, ema2.length - offset2, ema1.length, ema2.length);
  const start = Math.max(0, len - lookback);
  let crosses = 0;

  for (let i = start + 1; i < len; i++) {
    const idx1 = i + offset1;
    const idx2 = i + offset2;
    const idx1Prev = idx1 - 1;
    const idx2Prev = idx2 - 1;

    if (idx1Prev < 0 || idx2Prev < 0 || idx1 >= ema1.length || idx2 >= ema2.length) continue;

    const prevAbove = ema1[idx1Prev]! > ema2[idx2Prev]!;
    const currAbove = ema1[idx1]! > ema2[idx2]!;
    if (prevAbove !== currAbove) crosses++;
  }

  return crosses;
}

/**
 * Возвращает минимальный confluence score для входа в зависимости от режима.
 */
export function getRegimeThreshold(regime: MarketRegime): number {
  switch (regime) {
    case 'STRONG_TREND':
      return 22; // Тренд подтверждён — агрессивный вход, LLM решит остальное
    case 'WEAK_TREND':
      return 25;
    case 'RANGING':
      return 28; // В боковике — чуть строже, но LLM фильтрует дальше
    case 'VOLATILE':
      return 45; // Высокая волатильность — LLM оценит риски
    case 'CHOPPY':
      return 60; // Чоппи — жёстче, но не полный блок
  }
}
