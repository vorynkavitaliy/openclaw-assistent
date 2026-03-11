import {
  calculateBollingerBands,
  calculateMACD,
  calculateOBV,
  calculateRsi,
  calculateRsiSeries,
  calculateStochRSI,
} from './indicators.js';
import { analyzeOrderflow } from './orderflow.js';
import { detectCandlestickPatterns, scoreCandlestickPatterns } from './candlestick-patterns.js';
import type {
  CandlestickPattern,
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
  SmcAnalysis,
  VolumeProfile,
} from './types.js';

export const DEFAULT_CONFLUENCE_CONFIG: ConfluenceConfig = {
  trendWeight: 0.2,
  momentumWeight: 0.12,
  volumeWeight: 0.12,
  structureWeight: 0.12,
  orderflowWeight: 0.12,
  regimeWeight: 0.12,
  candlePatternsWeight: 0.1,
  smcWeight: 0.1,
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
  volumeProfile: VolumeProfile | null;
  regime: MarketRegime;
  market: MarketInfo;
  smcAnalysis?: SmcAnalysis | null;
  config?: ConfluenceConfig;
}

/**
 * Confluence Scoring Engine.
 * Оценивает качество торгового сигнала по 7 модулям: -10..+10 каждый.
 * Итоговый score: -100..+100.
 *
 * Модули: Trend(22%) + Momentum(13%) + Volume(13%) + Structure(13%)
 *       + Orderflow(13%) + Regime(13%) + CandlePatterns(13%) = 100%
 */
export function calculateConfluenceScore(input: ConfluenceInput): ConfluenceScore {
  const cfg = input.config ?? DEFAULT_CONFLUENCE_CONFIG;
  const details: string[] = [];

  const rawTrend = scoreTrend(input.trendTF, input.zonesTF, input.entryTF, details);
  const trend = applyIntradayBias(rawTrend, input.market.price24hPct, details);
  // Передаём направление тренда чтобы RSI-зоны оценивались симметрично
  const trendDirection: 'long' | 'short' | 'neutral' =
    trend > 0 ? 'long' : trend < 0 ? 'short' : 'neutral';
  const momentum = scoreMomentumEnhanced(
    input.entryCandles,
    trendDirection,
    input.entryTF,
    details,
  );
  const volume = scoreVolumeEnhanced(
    input.volumeProfile,
    input.entryCandles,
    trendDirection,
    details,
  );
  const structure = scoreStructureEnhanced(
    input.entryTF,
    input.volumeProfile,
    input.market,
    trendDirection,
    details,
  );
  const orderflow = scoreOrderflow(
    input.orderbook,
    input.oiHistory,
    input.fundingHistory,
    input.market.lastPrice,
    trendDirection,
    details,
  );
  const entryRsi = input.entryTF.indicators.rsi14;
  const regime = scoreRegime(input.regime, entryRsi, trendDirection, details);

  // Module 7: Candlestick Patterns
  const candlePatterns = scoreCandlePatterns(input.entryCandles, trendDirection, details);

  // Module 8: Smart Money Concepts
  const smc = input.smcAnalysis
    ? scoreSmcModule(input.smcAnalysis, input.market.lastPrice, trendDirection, details)
    : 0;

  const raw =
    trend * cfg.trendWeight +
    momentum * cfg.momentumWeight +
    volume * cfg.volumeWeight +
    structure * cfg.structureWeight +
    orderflow * cfg.orderflowWeight +
    regime * cfg.regimeWeight +
    candlePatterns * cfg.candlePatternsWeight +
    smc * cfg.smcWeight;

  // Conflict filter: тренд и моментум прямо противоположны — уменьшаем abs(score)
  // Penalty всегда двигает score к нулю (снижает уверенность в направлении)
  let conflictPenalty = 0;
  if (trend > 5 && momentum < -5) {
    conflictPenalty = -15; // bullish score → уменьшаем
    details.push('Conflict: тренд bullish, но momentum bearish — снижен score');
  } else if (trend < -5 && momentum > 5) {
    conflictPenalty = +15; // bearish (negative) score → двигаем к нулю (увеличиваем)
    details.push('Conflict: тренд bearish, но momentum bullish — снижен score');
  }

  // Normalize to -100..+100
  const total = Math.round(raw * 10) + conflictPenalty;
  const clamped = Math.max(-100, Math.min(100, total));

  const signal = getSignal(clamped);
  // Adaptive confidence ceiling: в сильном тренде легче набрать confidence
  const ceiling = getConfidenceCeiling(input.regime);
  const confidence = Math.max(0, Math.min(100, Math.round((Math.abs(clamped) / ceiling) * 100)));

  return {
    total: clamped,
    trend,
    momentum,
    volume,
    structure,
    orderflow,
    regime,
    candlePatterns,
    smc,
    smcAnalysis: input.smcAnalysis ?? undefined,
    signal,
    confidence,
    details,
  };
}

/**
 * Adaptive confidence ceiling по режиму рынка.
 * В сильном тренде набрать высокий score проще → ceiling ниже → confidence выше.
 * В choppy набрать score сложно → ceiling выше → confidence консервативнее.
 */
function getConfidenceCeiling(regime: MarketRegime): number {
  switch (regime) {
    case 'STRONG_TREND':
      return 65; // Было 55 — убрана инфляция confidence
    case 'WEAK_TREND':
      return 70;
    case 'VOLATILE':
      return 65;
    case 'RANGING':
      return 70;
    case 'CHOPPY':
      return 80; // Очень консервативный
  }
}

// ─── Intraday Bias Correction ────────────────────────────────────

/**
 * Корректирует EMA-based trend score на основе 24h price change.
 * Решает проблему: EMA50/200 реагируют на дневные/недельные движения,
 * но рынок может развернуться внутри дня (+5% rally при bearish EMA).
 *
 * Логика:
 * - price24h и trend в одну сторону → без изменений (EMA подтверждён)
 * - price24h противоречит trend при |change| >= 2% → гасим стейл сигнал
 * - |change| >= 4% → сильная коррекция, может перевернуть тренд
 */
function applyIntradayBias(trendScore: number, price24hPct: number, details: string[]): number {
  const absPct = Math.abs(price24hPct);

  // Незначительное движение — не корректируем
  if (absPct < 2) return trendScore;

  // Тренд и 24h движение совпадают — без коррекции
  if ((trendScore > 0 && price24hPct > 0) || (trendScore < 0 && price24hPct < 0)) {
    return trendScore;
  }

  // Тренд нейтральный (0) — дадим intraday направление
  if (trendScore === 0) {
    const bias = absPct >= 4 ? 4 : 2;
    const adjusted = price24hPct > 0 ? bias : -bias;
    details.push(
      `IntradayBias: нет EMA-тренда, 24h ${price24hPct > 0 ? '+' : ''}${price24hPct.toFixed(1)}% → bias ${adjusted > 0 ? '+' : ''}${adjusted}`,
    );
    return adjusted;
  }

  // Конфликт: EMA и 24h движение в разные стороны
  // Мягкая коррекция (2-4%): гасим trend на 50-70%
  // Сильная коррекция (4%+): гасим полностью + небольшой bias в сторону 24h
  let adjusted: number;
  if (absPct >= 4) {
    // Сильное внутридневное движение — EMA стейл, перевешиваем
    adjusted = price24hPct > 0 ? Math.max(trendScore + 6, 2) : Math.min(trendScore - 6, -2);
    details.push(
      `IntradayBias: сильный ${price24hPct > 0 ? '+' : ''}${price24hPct.toFixed(1)}% vs EMA(${trendScore}) → скорректирован до ${adjusted}`,
    );
  } else {
    // Умеренное движение (2-4%) — гасим EMA сигнал на ~60%
    const dampFactor = 0.4;
    adjusted = Math.round(trendScore * dampFactor);
    details.push(
      `IntradayBias: ${price24hPct > 0 ? '+' : ''}${price24hPct.toFixed(1)}% против EMA(${trendScore}) → ослаблен до ${adjusted}`,
    );
  }

  return Math.max(-10, Math.min(10, adjusted));
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

  // Fast EMA (9/21) — ранний сигнал разворота (до того как EMA50/200 выровняются)
  const ema9 = entryTF.indicators.ema9;
  const ema21 = entryTF.indicators.ema21;
  if (ema9 != null && ema21 != null && ema21 !== 0) {
    if (ema9 > ema21) {
      score += 3;
      details.push(
        `FastEMA: bullish (EMA9=${ema9.toPrecision(5)} > EMA21=${ema21.toPrecision(5)})`,
      );
    } else if (ema9 < ema21) {
      score -= 3;
      details.push(
        `FastEMA: bearish (EMA9=${ema9.toPrecision(5)} < EMA21=${ema21.toPrecision(5)})`,
      );
    }
  }

  // ROC2 — быстрый импульс за 30 мин (2 M15 свечи) — самая быстрая реакция
  const roc2 = entryTF.indicators.roc2;
  if (roc2 > 0.5) {
    score += 3;
    details.push(`ROC2: bullish импульс +${roc2.toFixed(2)}% за 30мин`);
  } else if (roc2 < -0.5) {
    score -= 3;
    details.push(`ROC2: bearish импульс ${roc2.toFixed(2)}% за 30мин`);
  }

  // Impulse detector — текущая свеча с большим телом + объём
  const imp = entryTF.indicators.impulse;
  if (imp > 1.5) {
    score += 4;
    details.push(`IMPULSE: сильный bullish (${imp.toFixed(1)}) — большое тело + объём`);
  } else if (imp < -1.5) {
    score -= 4;
    details.push(`IMPULSE: сильный bearish (${imp.toFixed(1)}) — большое тело + объём`);
  } else if (imp > 0.5) {
    score += 2;
    details.push(`IMPULSE: умеренный bullish (${imp.toFixed(1)})`);
  } else if (imp < -0.5) {
    score -= 2;
    details.push(`IMPULSE: умеренный bearish (${imp.toFixed(1)})`);
  }

  // Clamp trend score to -20..+20 (расширен для fast EMA + ROC2 + impulse)
  return Math.max(-20, Math.min(20, score));
}

// ─── Module 2: Momentum Score (weight 13%) — enhanced with BB squeeze ───

function scoreMomentumEnhanced(
  entryCandles: OHLC[],
  direction: 'long' | 'short' | 'neutral',
  entryTF: MarketAnalysis,
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

  // BB Squeeze: Bollinger Bands сжатие → ожидаем сильное движение
  const bb = entryTF.indicators.bb ?? calculateBollingerBands(closes);
  if (bb) {
    if (bb.squeeze) {
      // Squeeze → слабый bias в сторону тренда (ожидаем breakout)
      const squeezeBias = direction === 'long' ? 2 : direction === 'short' ? -2 : 0;
      score += squeezeBias;
      details.push(`Momentum: BB squeeze (width=${bb.width.toFixed(1)}%) → ожидаем breakout`);
    }
    // %B показывает где цена внутри полос (0=lower, 100=upper)
    if (bb.percentB > 90 && direction === 'long') {
      score -= 2; // Цена у верхней полосы — опасно для long
      details.push(`Momentum: BB %B=${bb.percentB.toFixed(0)} (у верхней полосы)`);
    } else if (bb.percentB < 10 && direction === 'short') {
      score += 2; // Цена у нижней полосы — опасно для short
      details.push(`Momentum: BB %B=${bb.percentB.toFixed(0)} (у нижней полосы)`);
    }
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

// ─── Module 3: Volume Score (weight 13%) — enhanced with OBV ────

function scoreVolumeEnhanced(
  volumeProfile: VolumeProfile | null,
  entryCandles: OHLC[],
  direction: 'long' | 'short' | 'neutral',
  details: string[],
): number {
  if (!volumeProfile) {
    details.push('Volume: нет данных (neutral)');
    return 0;
  }

  let score = 0;

  const rv = volumeProfile.relativeVolume;
  const delta = volumeProfile.volumeDelta;

  // Relative volume (direction-independent — высокий объём хорош для любого входа)
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

  // Volume delta — оценка по направлению тренда
  const avgVol = volumeProfile.avgCandleVolumeUsd;
  const deltaPct = avgVol > 0 ? (Math.abs(delta) / avgVol) * 100 : 0;
  const deltaPoints = Math.min(5, Math.round(deltaPct / 5));

  if (direction === 'long') {
    score += delta > 0 ? deltaPoints : -deltaPoints;
    if (deltaPct > 30) {
      details.push(
        `Volume: ${delta > 0 ? 'buy' : 'sell'} pressure (${deltaPct.toFixed(0)}% avg) — ${delta > 0 ? 'confirms' : 'against'} long`,
      );
    }
  } else if (direction === 'short') {
    score -= delta < 0 ? deltaPoints : -deltaPoints;
    if (deltaPct > 30) {
      details.push(
        `Volume: ${delta < 0 ? 'sell' : 'buy'} pressure (${deltaPct.toFixed(0)}% avg) — ${delta < 0 ? 'confirms' : 'against'} short`,
      );
    }
  } else {
    if (delta > 0) {
      score += deltaPoints;
    } else if (delta < 0) {
      score -= deltaPoints;
    }
  }

  // OBV: подтверждение тренда объёмом
  // Растущий OBV при long → подтверждение, падающий OBV → предупреждение
  if (entryCandles.length >= 20) {
    const obv = calculateOBV(entryCandles);
    if (direction === 'long') {
      if (obv > 0.5) {
        score += 2;
        details.push(`Volume: OBV растёт (+${obv.toFixed(1)}%) — подтверждает long`);
      } else if (obv < -0.5) {
        score -= 2;
        details.push(`Volume: OBV падает (${obv.toFixed(1)}%) — против long`);
      }
    } else if (direction === 'short') {
      if (obv < -0.5) {
        score -= 2; // Negative = bearish подтверждение
        details.push(`Volume: OBV падает (${obv.toFixed(1)}%) — подтверждает short`);
      } else if (obv > 0.5) {
        score += 2;
        details.push(`Volume: OBV растёт (+${obv.toFixed(1)}%) — против short`);
      }
    }
  }

  return Math.max(-10, Math.min(10, score));
}

// ─── Module 4: Structure Score (weight 13%) — enhanced with Ichimoku ─

function scoreStructureEnhanced(
  entryTF: MarketAnalysis,
  volumeProfile: VolumeProfile | null,
  market: MarketInfo,
  direction: 'long' | 'short' | 'neutral',
  details: string[],
): number {
  let score = 0;
  const price = market.lastPrice;
  const support = entryTF.levels.support;
  const resistance = entryTF.levels.resistance;

  if (price === 0) return 0;

  const distToSupport = ((price - support) / price) * 100;
  const distToResistance = ((resistance - price) / price) * 100;

  if (direction === 'short') {
    if (distToResistance < 1.0) {
      score -= 5;
      details.push(
        `Structure: цена у resistance (${distToResistance.toFixed(1)}%) — хорошо для short`,
      );
    } else if (distToResistance < 2.0) {
      score -= 3;
    }
    if (distToSupport < 1.0) {
      score += 5;
      details.push(`Structure: цена у support (${distToSupport.toFixed(1)}%) — плохо для short`);
    } else if (distToSupport < 2.0) {
      score += 3;
    }
  } else {
    if (distToSupport < 1.0) {
      score += 5;
      details.push(`Structure: цена у support (${distToSupport.toFixed(1)}%)`);
    } else if (distToSupport < 2.0) {
      score += 3;
    }
    if (distToResistance < 1.0) {
      score -= 5;
      details.push(`Structure: цена у resistance (${distToResistance.toFixed(1)}%)`);
    } else if (distToResistance < 2.0) {
      score -= 3;
    }
  }

  // VWAP confluence
  if (volumeProfile) {
    const distToVwap = (Math.abs(price - volumeProfile.vwap) / price) * 100;
    if (distToVwap < 0.3) {
      score += 2;
      details.push('Structure: цена у VWAP');
    }

    for (const node of volumeProfile.highVolumeNodes) {
      const dist = (Math.abs(price - node) / price) * 100;
      if (dist < 0.5) {
        score += 2;
        details.push(`Structure: high volume node at ${node}`);
        break;
      }
    }
  }

  // Ichimoku Cloud: мощный trend/structure фильтр
  const ichimoku = entryTF.indicators.ichimoku;
  if (ichimoku) {
    if (direction === 'long') {
      if (ichimoku.priceAboveCloud) {
        score += 3;
        details.push('Structure: Ichimoku — цена над облаком (bullish)');
      } else if (ichimoku.priceBelowCloud) {
        score -= 3;
        details.push('Structure: Ichimoku — цена под облаком (bearish for long)');
      }
    } else if (direction === 'short') {
      if (ichimoku.priceBelowCloud) {
        score -= 3;
        details.push('Structure: Ichimoku — цена под облаком (bearish)');
      } else if (ichimoku.priceAboveCloud) {
        score += 3;
        details.push('Structure: Ichimoku — цена над облаком (bullish for short = risky)');
      }
    }
    // TK Cross: быстрый сигнал подтверждения
    if (ichimoku.tkCross === 'BULLISH' && direction === 'long') {
      score += 2;
      details.push('Structure: Ichimoku TK bullish cross');
    } else if (ichimoku.tkCross === 'BEARISH' && direction === 'short') {
      score -= 2;
      details.push('Structure: Ichimoku TK bearish cross');
    }
  }

  // Расширяем clamp: S/R(±5) + VWAP(+2) + node(+2) + Ichimoku(±5) = потенциал ±14
  return Math.max(-15, Math.min(15, score));
}

// ─── Module 5: Orderflow Score (weight 15%) ──────────────────────

function scoreOrderflow(
  orderbook: OrderbookData,
  oiHistory: OIDataPoint[],
  fundingHistory: FundingDataPoint[],
  currentPrice: number,
  trendBias: 'long' | 'short' | 'neutral',
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

  // OI trend — direction-aware:
  // Rising OI подтверждает текущий тренд (новые позиции в сторону движения)
  // Falling OI = позиции закрываются, тренд слабеет (→ 0)
  if (analysis.oiTrend === 'RISING') {
    if (trendBias === 'long') {
      score += 3; // Новые лонги подтверждают bullish тренд
      details.push(`Orderflow: OI rising (${analysis.oiDelta24h}%/24h) — confirms long`);
    } else if (trendBias === 'short') {
      score -= 3; // Новые шорты подтверждают bearish тренд
      details.push(`Orderflow: OI rising (${analysis.oiDelta24h}%/24h) — confirms short`);
    } else {
      score += 1; // Нейтральный тренд: слабый позитив (активность растёт)
      details.push(`Orderflow: OI rising (${analysis.oiDelta24h}%/24h)`);
    }
  } else if (analysis.oiTrend === 'FALLING') {
    // Позиции закрываются — тренд теряет силу независимо от направления
    // Небольшой штраф к нулю (для long = -1, для short = +1, для neutral = 0)
    if (trendBias === 'long') {
      score -= 1;
    } else if (trendBias === 'short') {
      score += 1;
    }
    details.push(`Orderflow: OI falling (${analysis.oiDelta24h}%/24h) — тренд слабеет`);
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

function scoreRegime(
  regime: MarketRegime,
  rsi: number,
  direction: 'long' | 'short' | 'neutral',
  details: string[],
): number {
  let score: number;
  switch (regime) {
    case 'STRONG_TREND':
      score = 8;
      break;
    case 'WEAK_TREND':
      score = 4;
      break;
    case 'RANGING':
      score = 2;
      break;
    case 'VOLATILE':
      score = -5;
      break;
    case 'CHOPPY':
      score = -10;
      break;
  }

  // RSI exhaustion: тренд на исходе — снижаем бонус режима
  // Short при RSI < 35 или Long при RSI > 65 = тренд перегрет, меньше потенциала
  if (regime === 'STRONG_TREND' || regime === 'WEAK_TREND') {
    const exhausted = (direction === 'short' && rsi < 35) || (direction === 'long' && rsi > 65);
    if (exhausted) {
      const penalty = regime === 'STRONG_TREND' ? -6 : -3;
      score += penalty;
      details.push(`Regime: ${regime} но RSI=${rsi.toFixed(0)} экстремум (тренд устал) → ${score}`);
      return Math.max(-10, Math.min(10, score));
    }
  }

  const labels: Record<MarketRegime, string> = {
    STRONG_TREND: 'STRONG_TREND (favorable)',
    WEAK_TREND: 'WEAK_TREND',
    RANGING: 'RANGING (S/R bounce only)',
    VOLATILE: 'VOLATILE (caution)',
    CHOPPY: 'CHOPPY (avoid trading)',
  };
  details.push(`Regime: ${labels[regime]}`);
  return score;
}

// ─── Module 7: Candlestick Patterns Score (weight 13%) ──────────

function scoreCandlePatterns(
  entryCandles: OHLC[],
  direction: 'long' | 'short' | 'neutral',
  details: string[],
): number {
  if (entryCandles.length < 5) return 0;

  const patterns: CandlestickPattern[] = detectCandlestickPatterns(entryCandles);
  if (patterns.length === 0) return 0;

  const result = scoreCandlestickPatterns(patterns, direction);
  details.push(...result.details);
  return result.score;
}

// ─── Module 8: Smart Money Concepts Score (weight 10%) ──────────

function scoreSmcModule(
  smc: SmcAnalysis,
  currentPrice: number,
  direction: 'long' | 'short' | 'neutral',
  details: string[],
): number {
  let score = 0;

  // Order Blocks (±4 max)
  if (smc.nearestBullishOB && currentPrice > 0) {
    const distPct = ((currentPrice - smc.nearestBullishOB.high) / currentPrice) * 100;
    if (distPct >= 0 && distPct < 0.5) {
      score += direction === 'long' ? 4 : -2;
      details.push(
        `SMC: у Bullish OB (${distPct.toFixed(2)}%) — ${direction === 'long' ? 'поддержка' : 'ловушка для short'}`,
      );
    } else if (distPct >= 0 && distPct < 1.5) {
      score += direction === 'long' ? 2 : 0;
    }
  }
  if (smc.nearestBearishOB && currentPrice > 0) {
    const distPct = ((smc.nearestBearishOB.low - currentPrice) / currentPrice) * 100;
    if (distPct >= 0 && distPct < 0.5) {
      score += direction === 'short' ? -4 : 2;
      details.push(
        `SMC: у Bearish OB (${distPct.toFixed(2)}%) — ${direction === 'short' ? 'сопротивление' : 'ловушка для long'}`,
      );
    } else if (distPct >= 0 && distPct < 1.5) {
      score += direction === 'short' ? -2 : 0;
    }
  }

  // FVG (±3 max)
  if (smc.nearestBullishFVG && currentPrice > 0) {
    const distPct = ((currentPrice - smc.nearestBullishFVG.top) / currentPrice) * 100;
    if (distPct >= 0 && distPct < 1.0) {
      score += direction === 'long' ? 3 : -1;
      details.push(`SMC: Bullish FVG рядом (${distPct.toFixed(2)}%)`);
    }
  }
  if (smc.nearestBearishFVG && currentPrice > 0) {
    const distPct = ((smc.nearestBearishFVG.bottom - currentPrice) / currentPrice) * 100;
    if (distPct >= 0 && distPct < 1.0) {
      score += direction === 'short' ? -3 : 1;
      details.push(`SMC: Bearish FVG рядом (${distPct.toFixed(2)}%)`);
    }
  }

  // BOS/CHoCH (±4 max)
  if (smc.lastChoch) {
    const recency = smc.lastChoch.index;
    const isRecent = recency >= (smc.structureBreaks[0]?.index ?? 0) - 10;
    if (isRecent) {
      if (smc.lastChoch.direction === 'BULLISH') {
        score += direction === 'long' ? 4 : -2;
        details.push('SMC: CHoCH Bullish (разворот вверх)');
      } else {
        score += direction === 'short' ? -4 : 2;
        details.push('SMC: CHoCH Bearish (разворот вниз)');
      }
    }
  } else if (smc.lastBos) {
    if (smc.lastBos.direction === 'BULLISH') {
      score += direction === 'long' ? 3 : -1;
      details.push('SMC: BOS Bullish (продолжение)');
    } else {
      score += direction === 'short' ? -3 : 1;
      details.push('SMC: BOS Bearish (продолжение)');
    }
  }

  // Liquidity Sweeps (±2 max)
  for (const sweep of smc.liquiditySweeps.slice(0, 1)) {
    if (sweep.recovered) {
      if (sweep.type === 'LOW_SWEEP') {
        score += direction === 'long' ? 2 : -1;
        details.push('SMC: Low sweep recovered (институциональная покупка)');
      } else {
        score += direction === 'short' ? -2 : 1;
        details.push('SMC: High sweep recovered (институциональная продажа)');
      }
    }
  }

  // SMC Trend alignment (±1)
  if (smc.trend === 'BULLISH' && direction === 'long') score += 1;
  else if (smc.trend === 'BEARISH' && direction === 'short') score -= 1;

  return Math.max(-10, Math.min(10, score));
}

// ─── Helpers ─────────────────────────────────────────────────────

function getSignal(score: number): ConfluenceSignal {
  if (score >= 55) return 'STRONG_LONG';
  if (score >= 25) return 'LONG';
  if (score <= -55) return 'STRONG_SHORT';
  if (score <= -25) return 'SHORT';
  return 'NEUTRAL';
}
