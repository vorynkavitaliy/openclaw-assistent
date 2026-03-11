import type {
  FairValueGap,
  LiquiditySweep,
  OHLC,
  OrderBlock,
  SmcAnalysis,
  StructureBreak,
} from './types.js';
import { calculateAtr } from './indicators.js';

// ─── Order Blocks ─────────────────────────────────────────────────

/**
 * Детектирует Order Blocks — свечи перед сильным импульсным движением.
 * Bullish OB: bearish-свеча перед сильным bullish-движением (> 0.8 * ATR).
 * Bearish OB: bullish-свеча перед сильным bearish-движением (> 0.8 * ATR).
 * Возвращает только немитигированные OB, отсортированные от новейшего.
 */
export function detectOrderBlocks(candles: OHLC[], lookback: number = 50): OrderBlock[] {
  if (candles.length < 30) return [];

  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const closes = candles.map((c) => c.close);

  const atr = calculateAtr(highs, lows, closes, 14);
  if (atr === 0) return [];

  const impulseThreshold = 0.8 * atr;

  // Средний объём последних 20 свечей для расчёта strength
  const avgVolumePeriod = 20;

  const result: OrderBlock[] = [];
  const startIdx = Math.max(1, candles.length - lookback);

  for (let i = startIdx; i < candles.length - 1; i++) {
    const current = candles[i]!;
    const next = candles[i + 1]!;

    const nextBullishBody = next.close - next.open;
    const nextBearishBody = next.open - next.close;

    // Вычисляем средний объём на момент свечи i
    const volStart = Math.max(0, i - avgVolumePeriod);
    let volSum = 0;
    let volCount = 0;
    for (let v = volStart; v < i; v++) {
      volSum += candles[v]!.volume;
      volCount++;
    }
    const avgVol = volCount > 0 ? volSum / volCount : current.volume;
    const strength = avgVol > 0 ? current.volume / avgVol : 1;

    let obType: 'BULLISH' | 'BEARISH' | null = null;

    // Bullish OB: свеча i — bearish, следующая — сильная bullish
    if (nextBullishBody > impulseThreshold && current.close < current.open) {
      obType = 'BULLISH';
    }
    // Bearish OB: свеча i — bullish, следующая — сильная bearish
    else if (nextBearishBody > impulseThreshold && current.close > current.open) {
      obType = 'BEARISH';
    }

    if (obType === null) continue;

    // Проверяем митигацию: любая последующая свеча (после i+1) нарушила уровень
    let mitigated = false;
    for (let j = i + 2; j < candles.length; j++) {
      const c = candles[j]!;
      if (obType === 'BULLISH' && c.low < current.low) {
        mitigated = true;
        break;
      }
      if (obType === 'BEARISH' && c.high > current.high) {
        mitigated = true;
        break;
      }
    }

    result.push({
      type: obType,
      high: current.high,
      low: current.low,
      origin: obType === 'BULLISH' ? current.low : current.high,
      index: i,
      timeISO: current.time,
      mitigated,
      strength: Math.round(strength * 100) / 100,
    });
  }

  // Только немитигированные, от новейшего к старейшему
  return result.filter((ob) => !ob.mitigated).sort((a, b) => b.index - a.index);
}

// ─── Fair Value Gaps ──────────────────────────────────────────────

/**
 * Детектирует Fair Value Gaps (FVG) — ценовые разрывы между тремя свечами.
 * Bullish FVG: low[i] > high[i-2] (нет перекрытия снизу вверх).
 * Bearish FVG: high[i] < low[i-2] (нет перекрытия сверху вниз).
 * Возвращает только незакрытые FVG.
 */
export function detectFairValueGaps(candles: OHLC[], lookback: number = 30): FairValueGap[] {
  if (candles.length < 5) return [];

  const result: FairValueGap[] = [];
  const startIdx = Math.max(2, candles.length - lookback);

  for (let i = startIdx; i < candles.length; i++) {
    const prev2 = candles[i - 2]!;
    const candle = candles[i]!;

    let fvgType: 'BULLISH' | 'BEARISH' | null = null;
    let top = 0;
    let bottom = 0;

    // Bullish FVG: low текущей свечи выше high свечи i-2
    if (candle.low > prev2.high) {
      fvgType = 'BULLISH';
      top = candle.low;
      bottom = prev2.high;
    }
    // Bearish FVG: high текущей свечи ниже low свечи i-2
    else if (candle.high < prev2.low) {
      fvgType = 'BEARISH';
      top = prev2.low;
      bottom = candle.high;
    }

    if (fvgType === null) continue;

    const midpoint = (top + bottom) / 2;
    const size = midpoint > 0 ? ((top - bottom) / midpoint) * 100 : 0;

    // Пропускаем слишком маленькие гэпы (< 0.05%)
    if (size < 0.05) continue;

    // Проверяем заполнение: любая последующая свеча прошла через midpoint
    let filled = false;
    for (let j = i + 1; j < candles.length; j++) {
      const c = candles[j]!;
      if (fvgType === 'BULLISH' && c.low <= midpoint) {
        filled = true;
        break;
      }
      if (fvgType === 'BEARISH' && c.high >= midpoint) {
        filled = true;
        break;
      }
    }

    result.push({
      type: fvgType,
      top,
      bottom,
      midpoint: Math.round(midpoint * 1e8) / 1e8,
      index: i,
      timeISO: candle.time,
      filled,
      size: Math.round(size * 100) / 100,
    });
  }

  // Только незакрытые, от новейшего к старейшему
  return result.filter((fvg) => !fvg.filled).sort((a, b) => b.index - a.index);
}

// ─── Structure Breaks ─────────────────────────────────────────────

interface SwingPoint {
  index: number;
  price: number;
  type: 'HIGH' | 'LOW';
}

/**
 * Находит swing points (3-bar pivots).
 */
function findSwingPoints(candles: OHLC[], startIdx: number): SwingPoint[] {
  const points: SwingPoint[] = [];

  for (let i = startIdx + 1; i < candles.length - 1; i++) {
    const prev = candles[i - 1]!;
    const curr = candles[i]!;
    const next = candles[i + 1]!;

    if (curr.high > prev.high && curr.high > next.high) {
      points.push({ index: i, price: curr.high, type: 'HIGH' });
    }
    if (curr.low < prev.low && curr.low < next.low) {
      points.push({ index: i, price: curr.low, type: 'LOW' });
    }
  }

  return points;
}

/**
 * Детектирует Break of Structure (BOS) и Change of Character (CHoCH).
 * BOS: продолжение текущего тренда через последний swing.
 * CHoCH: разворот — нарушение структуры против тренда.
 * Возвращает последние 5 событий.
 */
export function detectStructureBreaks(candles: OHLC[], lookback: number = 50): StructureBreak[] {
  if (candles.length < 10) return [];

  const startIdx = Math.max(1, candles.length - lookback);
  const swings = findSwingPoints(candles, startIdx);

  if (swings.length < 2) return [];

  const result: StructureBreak[] = [];

  // Определяем начальный тренд по первым двум swing points
  const highs = swings.filter((s) => s.type === 'HIGH');
  const lows = swings.filter((s) => s.type === 'LOW');

  if (highs.length < 2 || lows.length < 2) return [];

  // Тренд: HH + HL = BULLISH, LH + LL = BEARISH
  let currentTrend: 'BULLISH' | 'BEARISH' = 'BULLISH';
  {
    const lastTwoHighs = highs.slice(-2);
    const lastTwoLows = lows.slice(-2);
    const hh = lastTwoHighs[1]!.price > lastTwoHighs[0]!.price;
    const hl = lastTwoLows[1]!.price > lastTwoLows[0]!.price;
    const lh = lastTwoHighs[1]!.price < lastTwoHighs[0]!.price;
    const ll = lastTwoLows[1]!.price < lastTwoLows[0]!.price;

    if (hh && hl) currentTrend = 'BULLISH';
    else if (lh && ll) currentTrend = 'BEARISH';
  }

  // Последний swing high и swing low для сравнения
  let lastSwingHigh = highs[highs.length - 1]!;
  let lastSwingLow = lows[lows.length - 1]!;

  // Проходим по свечам после последних swing points
  const scanStart = Math.max(lastSwingHigh.index, lastSwingLow.index) + 1;

  for (let i = scanStart; i < candles.length; i++) {
    const candle = candles[i]!;

    if (currentTrend === 'BULLISH') {
      // BOS bullish: close выше последнего swing high
      if (candle.close > lastSwingHigh.price) {
        result.push({
          type: 'BOS',
          direction: 'BULLISH',
          level: lastSwingHigh.price,
          index: i,
          timeISO: candle.time,
          confirmed: true,
        });
        // Обновляем swing high
        lastSwingHigh = { index: i, price: candle.high, type: 'HIGH' };
      }
      // CHoCH bearish: close ниже последнего swing low — разворот
      else if (candle.close < lastSwingLow.price) {
        result.push({
          type: 'CHOCH',
          direction: 'BEARISH',
          level: lastSwingLow.price,
          index: i,
          timeISO: candle.time,
          confirmed: true,
        });
        currentTrend = 'BEARISH';
        lastSwingLow = { index: i, price: candle.low, type: 'LOW' };
      }
    } else {
      // BOS bearish: close ниже последнего swing low
      if (candle.close < lastSwingLow.price) {
        result.push({
          type: 'BOS',
          direction: 'BEARISH',
          level: lastSwingLow.price,
          index: i,
          timeISO: candle.time,
          confirmed: true,
        });
        lastSwingLow = { index: i, price: candle.low, type: 'LOW' };
      }
      // CHoCH bullish: close выше последнего swing high — разворот
      else if (candle.close > lastSwingHigh.price) {
        result.push({
          type: 'CHOCH',
          direction: 'BULLISH',
          level: lastSwingHigh.price,
          index: i,
          timeISO: candle.time,
          confirmed: true,
        });
        currentTrend = 'BULLISH';
        lastSwingHigh = { index: i, price: candle.high, type: 'HIGH' };
      }
    }
  }

  return result.slice(-5);
}

// ─── Liquidity Sweeps ─────────────────────────────────────────────

/**
 * Детектирует Liquidity Sweeps — ложные пробои swing уровней.
 * HIGH_SWEEP: свеча пробила swing high вверх, но закрылась ниже.
 * LOW_SWEEP: свеча пробила swing low вниз, но закрылась выше.
 * Выброс должен быть > 0.1% от уровня.
 * Возвращает последние 3 события.
 */
export function detectLiquiditySweeps(candles: OHLC[], lookback: number = 20): LiquiditySweep[] {
  if (candles.length < 10) return [];

  const startIdx = Math.max(1, candles.length - lookback);
  const swings = findSwingPoints(candles, startIdx);

  const swingHighs = swings.filter((s) => s.type === 'HIGH');
  const swingLows = swings.filter((s) => s.type === 'LOW');

  const result: LiquiditySweep[] = [];

  // Для каждого swing high ищем sweep в последующих свечах
  for (const sh of swingHighs) {
    for (let i = sh.index + 1; i < candles.length; i++) {
      const candle = candles[i]!;
      const sweepPct = (candle.high - sh.price) / sh.price;

      if (sweepPct > 0.001 && candle.close < sh.price) {
        result.push({
          type: 'HIGH_SWEEP',
          level: sh.price,
          sweepHigh: candle.high,
          sweepLow: candle.low,
          index: i,
          timeISO: candle.time,
          recovered: candle.close < sh.price, // уже за уровнем
        });
        break; // один sweep на каждый swing high
      }
    }
  }

  // Для каждого swing low ищем sweep в последующих свечах
  for (const sl of swingLows) {
    for (let i = sl.index + 1; i < candles.length; i++) {
      const candle = candles[i]!;
      const sweepPct = (sl.price - candle.low) / sl.price;

      if (sweepPct > 0.001 && candle.close > sl.price) {
        result.push({
          type: 'LOW_SWEEP',
          level: sl.price,
          sweepHigh: candle.high,
          sweepLow: candle.low,
          index: i,
          timeISO: candle.time,
          recovered: candle.close > sl.price, // уже за уровнем
        });
        break;
      }
    }
  }

  // Сортируем по индексу (новейшие первые) и берём последние 3
  return result.sort((a, b) => b.index - a.index).slice(0, 3);
}

// ─── SMC Analyzer ─────────────────────────────────────────────────

/**
 * Полный SMC-анализ на основе предоставленных свечей.
 * Требует минимум 30 свечей. При меньшем количестве возвращает пустой анализ.
 */
export function analyzeSMC(candles: OHLC[], currentPrice: number): SmcAnalysis {
  const empty: SmcAnalysis = {
    orderBlocks: [],
    fairValueGaps: [],
    structureBreaks: [],
    liquiditySweeps: [],
    trend: 'NEUTRAL',
    lastBos: null,
    lastChoch: null,
    nearestBullishOB: null,
    nearestBearishOB: null,
    nearestBullishFVG: null,
    nearestBearishFVG: null,
  };

  if (candles.length < 30) return empty;

  const orderBlocks = detectOrderBlocks(candles);
  const fairValueGaps = detectFairValueGaps(candles);
  const structureBreaks = detectStructureBreaks(candles);
  const liquiditySweeps = detectLiquiditySweeps(candles);

  // Определяем текущий тренд по структурным событиям
  // Последний CHoCH задаёт разворот, последний BOS подтверждает продолжение
  let trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
  let lastBos: StructureBreak | null = null;
  let lastChoch: StructureBreak | null = null;

  for (const sb of structureBreaks) {
    if (sb.type === 'BOS') lastBos = sb;
    if (sb.type === 'CHOCH') lastChoch = sb;
  }

  if (lastChoch !== null) {
    // CHoCH — самое значимое: показывает смену характера
    trend = lastChoch.direction;
  } else if (lastBos !== null) {
    // BOS без CHoCH — продолжение
    trend = lastBos.direction;
  }

  // Ближайший Bullish OB ниже текущей цены
  const nearestBullishOB =
    orderBlocks
      .filter((ob) => ob.type === 'BULLISH' && ob.high < currentPrice)
      .sort((a, b) => b.high - a.high)[0] ?? null;

  // Ближайший Bearish OB выше текущей цены
  const nearestBearishOB =
    orderBlocks
      .filter((ob) => ob.type === 'BEARISH' && ob.low > currentPrice)
      .sort((a, b) => a.low - b.low)[0] ?? null;

  // Ближайший Bullish FVG ниже текущей цены (midpoint ниже цены)
  const nearestBullishFVG =
    fairValueGaps
      .filter((fvg) => fvg.type === 'BULLISH' && fvg.top < currentPrice)
      .sort((a, b) => b.top - a.top)[0] ?? null;

  // Ближайший Bearish FVG выше текущей цены (midpoint выше цены)
  const nearestBearishFVG =
    fairValueGaps
      .filter((fvg) => fvg.type === 'BEARISH' && fvg.bottom > currentPrice)
      .sort((a, b) => a.bottom - b.bottom)[0] ?? null;

  return {
    orderBlocks,
    fairValueGaps,
    structureBreaks,
    liquiditySweeps,
    trend,
    lastBos,
    lastChoch,
    nearestBullishOB,
    nearestBearishOB,
    nearestBullishFVG,
    nearestBearishFVG,
  };
}
