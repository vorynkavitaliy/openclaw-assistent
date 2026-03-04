import {
  calculateMACD,
  calculateRsi,
  calculateRsiSeries,
  calculateStochRSI,
} from './indicators.js';
import { analyzeOrderflow } from './orderflow.js';
import { getRegimeThreshold } from './regime.js';
import type {
  ConfluenceConfig,
  ConfluenceScore,
  ConfluenceSignal,
  FundingDataPoint,
  MarketAnalysis,
  MarketInfo,
  MarketRegime,
  OIDataPoint,
  OHLC,
  OrderbookData,
  VolumeProfile,
} from './types.js';

export const DEFAULT_CONFLUENCE_CONFIG: ConfluenceConfig = {
  trendWeight: 0.25,
  momentumWeight: 0.15,
  volumeWeight: 0.15,
  structureWeight: 0.15,
  orderflowWeight: 0.15,
  regimeWeight: 0.15,
  entryThreshold: 60,
  strongThreshold: 75,
};

export interface ConfluenceInput {
  trendTF: MarketAnalysis | null; // D1 or H4
  zonesTF: MarketAnalysis | null; // H1
  entryTF: MarketAnalysis; // M15
  precisionTF: MarketAnalysis | null; // M5
  entryCandles: OHLC[]; // M15 candles for momentum calc
  orderbook: OrderbookData;
  oiHistory: OIDataPoint[];
  fundingHistory: FundingDataPoint[];
  volumeProfile: VolumeProfile;
  regime: MarketRegime;
  market: MarketInfo;
  config?: ConfluenceConfig;
}

/**
 * Confluence Scoring Engine.
 * Оценивает качество торгового сигнала по 6 модулям: -10..+10 каждый.
 * Итоговый score: -100..+100.
 */
export function calculateConfluenceScore(input: ConfluenceInput): ConfluenceScore {
  const cfg = input.config ?? DEFAULT_CONFLUENCE_CONFIG;
  const details: string[] = [];

  const trend = scoreTrend(input.trendTF, input.zonesTF, input.entryTF, details);
  // Передаём направление тренда чтобы RSI-зоны оценивались симметрично
  const trendDirection: 'long' | 'short' | 'neutral' =
    trend > 0 ? 'long' : trend < 0 ? 'short' : 'neutral';
  const momentum = scoreMomentum(input.entryCandles, trendDirection, details);
  const volume = scoreVolume(input.volumeProfile, details);
  const structure = scoreStructure(input.entryTF, input.volumeProfile, input.market, details);
  const orderflow = scoreOrderflow(
    input.orderbook,
    input.oiHistory,
    input.fundingHistory,
    input.market.lastPrice,
    details,
  );
  const regime = scoreRegime(input.regime, details);

  const raw =
    trend * cfg.trendWeight +
    momentum * cfg.momentumWeight +
    volume * cfg.volumeWeight +
    structure * cfg.structureWeight +
    orderflow * cfg.orderflowWeight +
    regime * cfg.regimeWeight;

  // Conflict filter: тренд и моментум прямо противоположны — снижаем score
  // Например: trend=+8 (bullish) но momentum=-7 (bearish momentum) — сигнал ненадёжен
  let conflictPenalty = 0;
  if (trend > 5 && momentum < -5) {
    conflictPenalty = -15;
    details.push('Conflict: тренд bullish, но momentum bearish — снижен score');
  } else if (trend < -5 && momentum > 5) {
    conflictPenalty = 15;
    details.push('Conflict: тренд bearish, но momentum bullish — снижен score');
  }

  // Normalize to -100..+100
  const total = Math.round(raw * 10) + conflictPenalty;
  const clamped = Math.max(-100, Math.min(100, total));

  const signal = getSignal(clamped);
  const threshold = getRegimeThreshold(input.regime);
  const confidence = Math.max(0, Math.min(100, Math.round((Math.abs(clamped) / threshold) * 100)));

  return {
    total: clamped,
    trend,
    momentum,
    volume,
    structure,
    orderflow,
    regime,
    signal,
    confidence,
    details,
  };
}

// ─── Module 1: Trend Score (weight 25%) ──────────────────────────

function scoreTrend(
  trendTF: MarketAnalysis | null,
  zonesTF: MarketAnalysis | null,
  entryTF: MarketAnalysis,
  details: string[],
): number {
  let score = 0;

  const trendBias = trendTF?.bias.emaTrend ?? 'UNKNOWN';
  const zonesBias = zonesTF?.bias.emaTrend ?? 'UNKNOWN';
  const entryBias = entryTF.bias.emaTrend;

  // Full alignment (all bullish or all bearish)
  if (trendBias === 'BULLISH' && zonesBias === 'BULLISH' && entryBias === 'BULLISH') {
    score = 10;
    details.push('Trend: полное bullish alignment (D1+H1+M15)');
  } else if (trendBias === 'BEARISH' && zonesBias === 'BEARISH' && entryBias === 'BEARISH') {
    score = -10;
    details.push('Trend: полное bearish alignment (D1+H1+M15)');
  }
  // Two aligned
  else if (trendBias === 'BULLISH' && zonesBias === 'BULLISH') {
    score = 7;
    details.push('Trend: bullish D1+H1');
  } else if (trendBias === 'BEARISH' && zonesBias === 'BEARISH') {
    score = -7;
    details.push('Trend: bearish D1+H1');
  }
  // Only trend TF
  else if (trendBias === 'BULLISH') {
    score = 4;
    details.push('Trend: bullish D1 only');
  } else if (trendBias === 'BEARISH') {
    score = -4;
    details.push('Trend: bearish D1 only');
  } else {
    details.push('Trend: нет ясного направления');
  }

  return score;
}

// ─── Module 2: Momentum Score (weight 15%) ───────────────────────

function scoreMomentum(
  entryCandles: OHLC[],
  direction: 'long' | 'short' | 'neutral',
  details: string[],
): number {
  if (entryCandles.length < 30) {
    details.push('Momentum: недостаточно данных');
    return 0;
  }

  const closes = entryCandles.map((c) => c.close);
  const rsi = calculateRsi(closes, 14);
  const stochRSI = calculateStochRSI(closes);
  const macd = calculateMACD(closes);

  let score = 0;

  // RSI: симметричная оценка по направлению тренда
  if (direction === 'long') {
    if (rsi >= 40 && rsi <= 55) {
      score += 4;
      details.push(`Momentum: RSI=${rsi} в зоне bullish momentum`);
    } else if (rsi > 55 && rsi <= 65) {
      score += 2;
    } else if (rsi < 30) {
      score += 3;
      details.push(`Momentum: RSI=${rsi} oversold (потенциальный long)`);
    } else if (rsi > 70) {
      score -= 4;
      details.push(`Momentum: RSI=${rsi} overbought — риск для long`);
    } else if (rsi > 65) {
      score -= 2;
    }
  } else if (direction === 'short') {
    if (rsi >= 45 && rsi <= 60) {
      score -= 4;
      details.push(`Momentum: RSI=${rsi} в зоне bearish momentum`);
    } else if (rsi >= 35 && rsi < 45) {
      score -= 2;
    } else if (rsi > 70) {
      score -= 3;
      details.push(`Momentum: RSI=${rsi} overbought (потенциальный short)`);
    } else if (rsi < 30) {
      score += 4;
      details.push(`Momentum: RSI=${rsi} oversold — риск для short`);
    } else if (rsi < 35) {
      score += 2;
    }
  } else {
    // neutral: старая логика
    if (rsi >= 40 && rsi <= 50) score += 4;
    else if (rsi > 70) score -= 4;
    else if (rsi < 30) score += 3;
  }

  // StochRSI confirmation
  if (stochRSI.k > stochRSI.d && stochRSI.k < 80) {
    score += 3; // Bullish cross, not overbought
  } else if (stochRSI.k < stochRSI.d && stochRSI.k > 20) {
    score -= 3; // Bearish cross, not oversold
  }

  // MACD confirmation
  if (macd.histogram > 0 && macd.macd > macd.signal) {
    score += 3;
    details.push('Momentum: MACD bullish');
  } else if (macd.histogram < 0 && macd.macd < macd.signal) {
    score -= 3;
    details.push('Momentum: MACD bearish');
  }

  // RSI Divergence (последние 20 свечей)
  const divergence = detectRsiDivergence(entryCandles, closes);
  if (divergence === 'BULLISH') {
    score += 4;
    details.push('Momentum: bullish RSI divergence (цена ↓, RSI ↑)');
  } else if (divergence === 'BEARISH') {
    score -= 4;
    details.push('Momentum: bearish RSI divergence (цена ↑, RSI ↓)');
  }

  return Math.max(-10, Math.min(10, score));
}

/**
 * Определяет RSI дивергенцию за последние N свечей.
 * BULLISH: цена делает новый лоу, RSI — нет (потенциальный разворот вверх).
 * BEARISH: цена делает новый хай, RSI — нет (потенциальный разворот вниз).
 */
function detectRsiDivergence(
  candles: OHLC[],
  closes: number[],
  lookback: number = 20,
): 'BULLISH' | 'BEARISH' | 'NONE' {
  if (candles.length < lookback + 14) return 'NONE';

  const rsiSeries = calculateRsiSeries(closes, 14);
  if (rsiSeries.length < lookback) return 'NONE';

  const recentCandles = candles.slice(-lookback);
  const recentRsi = rsiSeries.slice(-lookback);

  const firstHalf = Math.floor(lookback / 2);

  const priceHi1 = Math.max(...recentCandles.slice(0, firstHalf).map((c) => c.high));
  const priceHi2 = Math.max(...recentCandles.slice(firstHalf).map((c) => c.high));
  const priceLo1 = Math.min(...recentCandles.slice(0, firstHalf).map((c) => c.low));
  const priceLo2 = Math.min(...recentCandles.slice(firstHalf).map((c) => c.low));

  const rsiHi1 = Math.max(...recentRsi.slice(0, firstHalf));
  const rsiHi2 = Math.max(...recentRsi.slice(firstHalf));
  const rsiLo1 = Math.min(...recentRsi.slice(0, firstHalf));
  const rsiLo2 = Math.min(...recentRsi.slice(firstHalf));

  // Bearish: цена выше, RSI ниже
  if (priceHi2 > priceHi1 && rsiHi2 < rsiHi1 - 3) return 'BEARISH';

  // Bullish: цена ниже, RSI выше
  if (priceLo2 < priceLo1 && rsiLo2 > rsiLo1 + 3) return 'BULLISH';

  return 'NONE';
}

// ─── Module 3: Volume Score (weight 15%) ─────────────────────────

function scoreVolume(volumeProfile: VolumeProfile, details: string[]): number {
  let score = 0;

  const rv = volumeProfile.relativeVolume;
  const delta = volumeProfile.volumeDelta;

  // Relative volume
  if (rv > 2.0) {
    score += 5;
    details.push(`Volume: ${rv}x average (high activity)`);
  } else if (rv > 1.5) {
    score += 3;
  } else if (rv > 1.0) {
    score += 1;
  } else if (rv < 0.5) {
    score -= 5;
    details.push(`Volume: ${rv}x average (very low — weak signal)`);
  } else if (rv < 0.7) {
    score -= 3;
  }

  // Volume delta (buy vs sell pressure)
  if (delta > 0) {
    score += Math.min(5, Math.round(Math.abs(delta) / 10000));
    if (delta > 50000) details.push('Volume: strong buy pressure');
  } else if (delta < 0) {
    score -= Math.min(5, Math.round(Math.abs(delta) / 10000));
    if (delta < -50000) details.push('Volume: strong sell pressure');
  }

  return Math.max(-10, Math.min(10, score));
}

// ─── Module 4: Structure Score (weight 15%) ──────────────────────

function scoreStructure(
  entryTF: MarketAnalysis,
  volumeProfile: VolumeProfile,
  market: MarketInfo,
  details: string[],
): number {
  let score = 0;
  const price = market.lastPrice;
  const support = entryTF.levels.support;
  const resistance = entryTF.levels.resistance;

  if (price === 0) return 0;

  const distToSupport = ((price - support) / price) * 100;
  const distToResistance = ((resistance - price) / price) * 100;

  // Near support (good for longs)
  if (distToSupport < 0.5) {
    score += 5;
    details.push(`Structure: цена у support (${distToSupport.toFixed(1)}%)`);
  } else if (distToSupport < 1.5) {
    score += 3;
  }

  // Near resistance (bad for longs)
  if (distToResistance < 0.5) {
    score -= 5;
    details.push(`Structure: цена у resistance (${distToResistance.toFixed(1)}%)`);
  } else if (distToResistance < 1.5) {
    score -= 3;
  }

  // VWAP confluence
  const distToVwap = (Math.abs(price - volumeProfile.vwap) / price) * 100;
  if (distToVwap < 0.3) {
    score += 2;
    details.push('Structure: цена у VWAP');
  }

  // High volume nodes nearby
  for (const node of volumeProfile.highVolumeNodes) {
    const dist = (Math.abs(price - node) / price) * 100;
    if (dist < 0.5) {
      score += 2;
      details.push(`Structure: high volume node at ${node}`);
      break;
    }
  }

  return Math.max(-10, Math.min(10, score));
}

// ─── Module 5: Orderflow Score (weight 15%) ──────────────────────

function scoreOrderflow(
  orderbook: OrderbookData,
  oiHistory: OIDataPoint[],
  fundingHistory: FundingDataPoint[],
  currentPrice: number,
  details: string[],
): number {
  const analysis = analyzeOrderflow(orderbook, oiHistory, fundingHistory, currentPrice);
  let score = 0;

  // Orderbook imbalance
  if (analysis.obImbalance > 0.3) {
    score += 3;
    details.push(`Orderflow: bid-heavy imbalance (${analysis.obImbalance})`);
  } else if (analysis.obImbalance < -0.3) {
    score -= 3;
    details.push(`Orderflow: ask-heavy imbalance (${analysis.obImbalance})`);
  }

  // OI trend
  if (analysis.oiTrend === 'RISING') {
    score += 3;
    details.push(`Orderflow: OI rising (${analysis.oiDelta24h}%/24h)`);
  } else if (analysis.oiTrend === 'FALLING') {
    score -= 2;
  }

  // Funding (contrarian: negative funding + bullish = good for longs)
  if (analysis.fundingTrend === 'SHORTS_PAYING') {
    score += 2; // Shorts paying = market expects upside
  } else if (analysis.fundingExtreme && analysis.fundingTrend === 'LONGS_PAYING') {
    score -= 4; // Extreme long funding = crowded trade
    details.push('Orderflow: extreme long funding (risky)');
  } else if (analysis.fundingTrend === 'LONGS_PAYING') {
    score -= 1;
  }

  return Math.max(-10, Math.min(10, score));
}

// ─── Module 6: Regime Score (weight 15%) ─────────────────────────

function scoreRegime(regime: MarketRegime, details: string[]): number {
  switch (regime) {
    case 'STRONG_TREND':
      details.push('Regime: STRONG_TREND (favorable)');
      return 8;
    case 'WEAK_TREND':
      details.push('Regime: WEAK_TREND');
      return 4;
    case 'RANGING':
      details.push('Regime: RANGING (S/R bounce only)');
      return 2;
    case 'VOLATILE':
      details.push('Regime: VOLATILE (caution)');
      return -5;
    case 'CHOPPY':
      details.push('Regime: CHOPPY (avoid trading)');
      return -10;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────

function getSignal(score: number): ConfluenceSignal {
  if (score >= 70) return 'STRONG_LONG';
  if (score >= 40) return 'LONG';
  if (score <= -70) return 'STRONG_SHORT';
  if (score <= -40) return 'SHORT';
  return 'NEUTRAL';
}
