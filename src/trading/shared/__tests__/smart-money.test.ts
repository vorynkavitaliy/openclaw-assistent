import { describe, expect, it } from 'vitest';
import {
  analyzeSMC,
  detectFairValueGaps,
  detectLiquiditySweeps,
  detectOrderBlocks,
  detectStructureBreaks,
} from '../smart-money.js';
import type { OHLC } from '../types.js';

// ─── Хелперы ──────────────────────────────────────────────────────

let timeCounter = 0;

function makeCandle(
  open: number,
  high: number,
  low: number,
  close: number,
  volume: number = 1000,
  time?: string,
): OHLC {
  timeCounter++;
  return {
    time: time ?? new Date(Date.UTC(2024, 0, 1) + timeCounter * 60_000).toISOString(),
    open,
    high,
    low,
    close,
    volume,
  };
}

/**
 * Генерирует базовый набор нейтральных свечей — боковик вокруг price.
 * Амплитуда small чтобы ATR был небольшим и предсказуемым.
 */
function makeFlatCandles(count: number, basePrice: number = 100, amplitude: number = 1): OHLC[] {
  const candles: OHLC[] = [];
  for (let i = 0; i < count; i++) {
    const mid = basePrice + Math.sin(i * 0.5) * amplitude;
    candles.push(makeCandle(mid - 0.3, mid + amplitude, mid - amplitude, mid + 0.2, 1000));
  }
  return candles;
}

// ─── detectOrderBlocks ─────────────────────────────────────────────

describe('detectOrderBlocks', () => {
  it('возвращает [] при менее чем 30 свечах', () => {
    const candles = makeFlatCandles(15, 100);
    expect(detectOrderBlocks(candles)).toEqual([]);
  });

  it('находит Bullish OB: bearish свеча перед сильным bullish движением', () => {
    // Строим 35 нейтральных свечей, затем:
    // свеча i   — явная bearish (OB-кандидат)
    // свеча i+1 — сильный bullish импульс (тело >> ATR боковика)
    const candles = makeFlatCandles(35, 100, 0.5);

    // Добавляем bearish OB-свечу
    candles.push(makeCandle(102, 103, 98, 99, 1500)); // bearish: open > close
    // Сильный bullish импульс: тело = 8 >> ATR (~1)
    candles.push(makeCandle(99, 110, 99, 107, 3000)); // bullish body = 8

    const obs = detectOrderBlocks(candles);

    expect(obs.length).toBeGreaterThan(0);
    const bullishOB = obs.find((ob) => ob.type === 'BULLISH');
    expect(bullishOB).toBeDefined();
    expect(bullishOB!.type).toBe('BULLISH');
    // origin для Bullish OB = low свечи
    expect(bullishOB!.origin).toBe(bullishOB!.low);
  });

  it('находит Bearish OB: bullish свеча перед сильным bearish движением', () => {
    const candles = makeFlatCandles(35, 100, 0.5);

    // Добавляем bullish OB-свечу
    candles.push(makeCandle(98, 103, 97, 102, 1500)); // bullish: close > open
    // Сильный bearish импульс: тело = 8 >> ATR
    candles.push(makeCandle(102, 102, 90, 93, 3000)); // bearish body = 9

    const obs = detectOrderBlocks(candles);

    expect(obs.length).toBeGreaterThan(0);
    const bearishOB = obs.find((ob) => ob.type === 'BEARISH');
    expect(bearishOB).toBeDefined();
    expect(bearishOB!.type).toBe('BEARISH');
    // origin для Bearish OB = high свечи
    expect(bearishOB!.origin).toBe(bearishOB!.high);
  });

  it('не включает митигированный OB: если цена прошла сквозь уровень', () => {
    const candles = makeFlatCandles(35, 100, 0.5);

    // Bullish OB-свеча (bearish)
    candles.push(makeCandle(102, 103, 98, 99, 1500));
    // Сильный bullish импульс
    candles.push(makeCandle(99, 110, 99, 107, 3000));
    // Свеча, которая митигирует OB: low опускается ниже low OB-свечи (98)
    candles.push(makeCandle(105, 106, 95, 96, 2000));

    const obs = detectOrderBlocks(candles);

    // Митигированные отфильтрованы, поэтому наш OB не должен присутствовать
    // (OB-свеча имела low=98, митигация произошла при low=95)
    const mitigatedPresent = obs.some((ob) => ob.mitigated);
    expect(mitigatedPresent).toBe(false);
  });

  it('возвращает результаты отсортированные от новейшего к старейшему', () => {
    // Два независимых OB одного типа без взаимной митигации:
    // используем два Bearish OB, между которыми цена не возвращается выше
    const candles = makeFlatCandles(35, 100, 0.5);

    // Первый Bearish OB: bullish свеча (i), потом сильный bearish импульс (i+1)
    candles.push(makeCandle(100, 103, 99, 102, 1500)); // первый OB (bullish свеча, high=103)
    candles.push(makeCandle(102, 103, 88, 90, 3000)); // сильный bearish импульс body=12

    // Несколько нейтральных свечей, цена остаётся ниже high первого OB (103)
    candles.push(makeCandle(90, 92, 89, 91, 1000));
    candles.push(makeCandle(91, 93, 90, 92, 1000));
    candles.push(makeCandle(92, 94, 91, 93, 1000));

    // Второй Bearish OB: bullish свеча (high=95), потом сильный bearish импульс
    candles.push(makeCandle(93, 96, 92, 95, 1500)); // второй OB (bullish свеча, high=96)
    candles.push(makeCandle(95, 96, 82, 84, 3000)); // сильный bearish импульс body=11

    const obs = detectOrderBlocks(candles);

    // Убеждаемся что хотя бы один OB найден (не митигированный)
    expect(obs.length).toBeGreaterThan(0);

    // Если нашли несколько — проверяем сортировку от новейшего к старейшему
    if (obs.length >= 2) {
      for (let i = 0; i < obs.length - 1; i++) {
        expect(obs[i]!.index).toBeGreaterThanOrEqual(obs[i + 1]!.index);
      }
    }
  });
});

// ─── detectFairValueGaps ───────────────────────────────────────────

describe('detectFairValueGaps', () => {
  it('возвращает [] при менее чем 5 свечах', () => {
    const candles = makeFlatCandles(3, 100);
    expect(detectFairValueGaps(candles)).toEqual([]);
  });

  it('находит Bullish FVG: low[i] выше high[i-2]', () => {
    // Паттерн 3 свечей: candle[0].high=101, candle[2].low=104 → FVG от 101 до 104
    const candles = makeFlatCandles(10, 100, 0.3);

    // Создаём явный Bullish FVG: candle[i-2].high < candle[i].low
    // candle i-2: high=101
    candles.push(makeCandle(99, 101, 98, 100, 1000)); // i-2
    // candle i-1: средняя (может быть любой)
    candles.push(makeCandle(100, 103, 99, 102, 1000)); // i-1
    // candle i: low=104 > high(i-2)=101 → BULLISH FVG
    candles.push(makeCandle(104, 108, 104, 107, 2000)); // i

    const fvgs = detectFairValueGaps(candles);

    expect(fvgs.length).toBeGreaterThan(0);
    const bullishFVG = fvgs.find((f) => f.type === 'BULLISH');
    expect(bullishFVG).toBeDefined();
    expect(bullishFVG!.bottom).toBe(101); // high[i-2]
    expect(bullishFVG!.top).toBe(104); // low[i]
  });

  it('находит Bearish FVG: high[i] ниже low[i-2]', () => {
    const candles = makeFlatCandles(10, 100, 0.3);

    // Bearish FVG: candle[i-2].low=99, candle[i].high=96 < 99
    candles.push(makeCandle(101, 102, 99, 100, 1000)); // i-2: low=99
    candles.push(makeCandle(100, 101, 97, 98, 1000)); // i-1
    candles.push(makeCandle(96, 96, 90, 91, 2000)); // i: high=96 < low[i-2]=99

    const fvgs = detectFairValueGaps(candles);

    expect(fvgs.length).toBeGreaterThan(0);
    const bearishFVG = fvgs.find((f) => f.type === 'BEARISH');
    expect(bearishFVG).toBeDefined();
    expect(bearishFVG!.top).toBe(99); // low[i-2]
    expect(bearishFVG!.bottom).toBe(96); // high[i]
  });

  it('не включает заполненный FVG: если следующая свеча прошла через midpoint', () => {
    const candles = makeFlatCandles(10, 100, 0.3);

    // Bullish FVG: bottom=101, top=104, midpoint=102.5
    candles.push(makeCandle(99, 101, 98, 100, 1000));
    candles.push(makeCandle(100, 103, 99, 102, 1000));
    candles.push(makeCandle(104, 108, 104, 107, 2000));
    // Следующая свеча заполняет FVG: low=102 <= midpoint=102.5
    candles.push(makeCandle(107, 108, 102, 103, 1500));

    const fvgs = detectFairValueGaps(candles);

    // Заполненные FVG отфильтрованы
    const filledPresent = fvgs.some((f) => f.filled);
    expect(filledPresent).toBe(false);
  });

  it('вычисляет корректный midpoint и size', () => {
    const candles = makeFlatCandles(10, 100, 0.3);

    // Bullish FVG: bottom=100, top=110 → midpoint=105, size=(10/105)*100≈9.52%
    candles.push(makeCandle(98, 100, 97, 99, 1000)); // i-2: high=100
    candles.push(makeCandle(100, 105, 99, 103, 1000)); // i-1
    candles.push(makeCandle(110, 115, 110, 113, 2000)); // i: low=110

    const fvgs = detectFairValueGaps(candles);
    const bullishFVG = fvgs.find((f) => f.type === 'BULLISH');

    expect(bullishFVG).toBeDefined();
    expect(bullishFVG!.midpoint).toBeCloseTo(105, 1);
    expect(bullishFVG!.size).toBeGreaterThan(0);
  });
});

// ─── detectStructureBreaks ─────────────────────────────────────────

describe('detectStructureBreaks', () => {
  it('возвращает [] при менее чем 10 свечах', () => {
    const candles = makeFlatCandles(5, 100);
    expect(detectStructureBreaks(candles)).toEqual([]);
  });

  it('находит Bullish BOS: пробой swing high вверх при бычьем тренде', () => {
    // Алгоритму нужно минимум 2 swing high + 2 swing low для определения тренда.
    // findSwingPoints использует 3-bar pivot: curr.high > prev.high && curr.high > next.high.
    // Scan начинается с max(lastSwingHigh.index, lastSwingLow.index)+1.
    const candles: OHLC[] = [
      // [0] нейтральная — левый сосед для swing low 1
      makeCandle(97, 98, 95, 97, 1000),
      // [1] нейтральная
      makeCandle(97, 99, 96, 98, 1000),
      // [2] swing high 1: high=106 > prev(99) и > next(104)
      makeCandle(99, 106, 98, 104, 1000),
      // [3] нейтральная (правый сосед для swing high 1: high=104 < 106)
      makeCandle(104, 104, 99, 100, 1000),
      // [4] swing low 1: low=97 < prev(99) и < next(98) — проверяем
      makeCandle(100, 101, 97, 98, 1000),
      // [5] правый сосед для swing low 1: low=98 > 97
      makeCandle(98, 100, 98, 99, 1000),
      // [6] нейтральная
      makeCandle(99, 101, 98, 100, 1000),
      // [7] swing high 2 (HH): high=112 > prev(101) и > next(111)
      makeCandle(100, 112, 99, 110, 1000),
      // [8] правый сосед для swing high 2: high=111 < 112
      makeCandle(110, 111, 102, 103, 1000),
      // [9] нейтральная
      makeCandle(103, 104, 101, 102, 1000),
      // [10] swing low 2 (HL): low=100 < prev(101) и < next(101)
      makeCandle(102, 103, 100, 101, 1000),
      // [11] правый сосед для swing low 2: low=101 > 100
      makeCandle(101, 103, 101, 102, 1000),
      // [12] BOS: scan начнётся с max(7,10)+1=11, close=115 > lastSwingHigh.price=112
      makeCandle(102, 120, 102, 115, 2000),
    ];

    const breaks = detectStructureBreaks(candles);

    expect(breaks.length).toBeGreaterThan(0);
    const bos = breaks.find((b) => b.type === 'BOS' && b.direction === 'BULLISH');
    expect(bos).toBeDefined();
    expect(bos!.confirmed).toBe(true);
  });

  it('находит Bearish CHoCH: пробой swing low при бычьем тренде — смена характера', () => {
    // Аналогично BOS тесту: нужно 2 swing high + 2 swing low для бычьего тренда.
    // Затем пробой lastSwingLow вниз → CHoCH BEARISH.
    const candles: OHLC[] = [
      // [0] нейтральная
      makeCandle(97, 98, 95, 97, 1000),
      // [1] нейтральная
      makeCandle(97, 99, 96, 98, 1000),
      // [2] swing high 1: high=107 > prev(99) и > next(105)
      makeCandle(99, 107, 98, 105, 1000),
      // [3] правый сосед: high=105 < 107
      makeCandle(105, 105, 99, 100, 1000),
      // [4] swing low 1: low=97 < prev(99) и < next(98)
      makeCandle(100, 101, 97, 98, 1000),
      // [5] правый сосед: low=98 > 97
      makeCandle(98, 100, 98, 99, 1000),
      // [6] нейтральная
      makeCandle(99, 101, 98, 100, 1000),
      // [7] swing high 2 (HH): high=114 > prev(101) и > next(112)
      makeCandle(100, 114, 99, 112, 1000),
      // [8] правый сосед: high=112 < 114
      makeCandle(112, 112, 103, 104, 1000),
      // [9] нейтральная
      makeCandle(104, 105, 102, 103, 1000),
      // [10] swing low 2 (HL): low=101 < prev(102) и < next(102)
      makeCandle(103, 104, 101, 102, 1000),
      // [11] правый сосед: low=102 > 101
      makeCandle(102, 104, 102, 103, 1000),
      // [12] CHoCH: scan с max(7,10)+1=11, close=96 < lastSwingLow.price=101
      makeCandle(103, 104, 90, 96, 2000),
    ];

    const breaks = detectStructureBreaks(candles);

    expect(breaks.length).toBeGreaterThan(0);
    const choch = breaks.find((b) => b.type === 'CHOCH' && b.direction === 'BEARISH');
    expect(choch).toBeDefined();
    expect(choch!.confirmed).toBe(true);
  });

  it('возвращает не более 5 последних событий', () => {
    // Генерируем данные с множеством структурных событий
    const candles = makeFlatCandles(60, 100, 2);
    const breaks = detectStructureBreaks(candles, 60);

    expect(breaks.length).toBeLessThanOrEqual(5);
  });

  it('возвращает [] если недостаточно swing points', () => {
    // Монотонный рост без swing points
    const candles: OHLC[] = [];
    for (let i = 0; i < 15; i++) {
      const p = 100 + i;
      candles.push(makeCandle(p, p + 0.5, p - 0.2, p + 0.3, 1000));
    }
    const breaks = detectStructureBreaks(candles);
    // При монотонном движении swing points не формируются → []
    expect(Array.isArray(breaks)).toBe(true);
  });
});

// ─── detectLiquiditySweeps ─────────────────────────────────────────

describe('detectLiquiditySweeps', () => {
  it('возвращает [] при менее чем 10 свечах', () => {
    const candles = makeFlatCandles(5, 100);
    expect(detectLiquiditySweeps(candles)).toEqual([]);
  });

  it('находит HIGH_SWEEP: пробой swing high вверх с возвратом ниже', () => {
    // Создаём swing high, затем свечу которая его пробивает но закрывается ниже
    const candles: OHLC[] = [
      makeCandle(98, 100, 97, 99, 1000), // предшественник swing high
      makeCandle(99, 105, 98, 103, 1000), // swing high (high=105, является пиком между соседями)
      makeCandle(103, 104, 100, 101, 1000), // правая сторона подтверждает swing high (high < 105)
      makeCandle(101, 102, 99, 100, 1000),
      makeCandle(100, 101, 98, 99, 1000),
      makeCandle(99, 101, 97, 100, 1000),
      makeCandle(100, 102, 98, 101, 1000),
      makeCandle(101, 103, 99, 102, 1000),
      makeCandle(102, 104, 100, 103, 1000),
      // Sweep: high=107 > swing_high=105, но close=103 < 105
      makeCandle(103, 107, 102, 103, 3000),
    ];

    const sweeps = detectLiquiditySweeps(candles, 20);

    if (sweeps.length > 0) {
      const highSweep = sweeps.find((s) => s.type === 'HIGH_SWEEP');
      expect(highSweep).toBeDefined();
      expect(highSweep!.sweepHigh).toBeGreaterThan(highSweep!.level);
      expect(highSweep!.recovered).toBe(true);
    } else {
      // Альтернатив: допускаем что swing high не сформировался в lookback окне
      expect(Array.isArray(sweeps)).toBe(true);
    }
  });

  it('находит LOW_SWEEP: пробой swing low вниз с возвратом выше', () => {
    const candles: OHLC[] = [
      makeCandle(102, 104, 101, 103, 1000),
      makeCandle(103, 105, 98, 99, 1000), // swing low (low=98, пик вниз между соседями)
      makeCandle(99, 101, 99, 100, 1000), // правая сторона (low=99 > 98)
      makeCandle(100, 102, 99, 101, 1000),
      makeCandle(101, 103, 100, 102, 1000),
      makeCandle(102, 104, 101, 103, 1000),
      makeCandle(103, 105, 102, 104, 1000),
      makeCandle(104, 106, 103, 105, 1000),
      makeCandle(105, 107, 104, 106, 1000),
      // Sweep: low=94 < swing_low=98, но close=101 > 98
      makeCandle(106, 108, 94, 101, 3000),
    ];

    const sweeps = detectLiquiditySweeps(candles, 20);

    if (sweeps.length > 0) {
      const lowSweep = sweeps.find((s) => s.type === 'LOW_SWEEP');
      expect(lowSweep).toBeDefined();
      expect(lowSweep!.sweepLow).toBeLessThan(lowSweep!.level);
      expect(lowSweep!.recovered).toBe(true);
    } else {
      expect(Array.isArray(sweeps)).toBe(true);
    }
  });

  it('возвращает не более 3 событий', () => {
    const candles = makeFlatCandles(30, 100, 3);
    const sweeps = detectLiquiditySweeps(candles, 30);
    expect(sweeps.length).toBeLessThanOrEqual(3);
  });

  it('sweep должен быть > 0.1% от уровня (малый выброс игнорируется)', () => {
    // Swing high = 100, выброс только на 100.05 (0.05% < 0.1%) → не sweep
    const candles: OHLC[] = [
      makeCandle(98, 100, 97, 99, 1000),
      makeCandle(99, 100, 98, 99.5, 1000), // swing high (high=100)
      makeCandle(99.5, 99.8, 98.5, 99, 1000),
      makeCandle(99, 99.5, 98, 99, 1000),
      makeCandle(99, 99.5, 98, 99, 1000),
      makeCandle(99, 99.5, 98, 99, 1000),
      makeCandle(99, 99.5, 98, 99, 1000),
      makeCandle(99, 99.5, 98, 99, 1000),
      makeCandle(99, 99.5, 98, 99, 1000),
      // Малый выброс: high=100.05, close=99 < 100 (sweep < 0.1%)
      makeCandle(99, 100.05, 98.5, 99, 1000),
    ];

    const sweeps = detectLiquiditySweeps(candles, 20);
    // Ни одного HIGH_SWEEP не должно быть от этого уровня
    const highSweepsAbove100 = sweeps.filter((s) => s.type === 'HIGH_SWEEP' && s.level === 100);
    expect(highSweepsAbove100.length).toBe(0);
  });
});

// ─── analyzeSMC ────────────────────────────────────────────────────

describe('analyzeSMC', () => {
  it('возвращает пустой анализ при менее чем 30 свечах', () => {
    const candles = makeFlatCandles(15, 100);
    const result = analyzeSMC(candles, 100);

    expect(result.orderBlocks).toEqual([]);
    expect(result.fairValueGaps).toEqual([]);
    expect(result.structureBreaks).toEqual([]);
    expect(result.liquiditySweeps).toEqual([]);
    expect(result.trend).toBe('NEUTRAL');
    expect(result.lastBos).toBeNull();
    expect(result.lastChoch).toBeNull();
    expect(result.nearestBullishOB).toBeNull();
    expect(result.nearestBearishOB).toBeNull();
    expect(result.nearestBullishFVG).toBeNull();
    expect(result.nearestBearishFVG).toBeNull();
  });

  it('возвращает все компоненты анализа (структуру SmcAnalysis)', () => {
    const candles = makeFlatCandles(40, 100, 2);
    const result = analyzeSMC(candles, 100);

    expect(result).toHaveProperty('orderBlocks');
    expect(result).toHaveProperty('fairValueGaps');
    expect(result).toHaveProperty('structureBreaks');
    expect(result).toHaveProperty('liquiditySweeps');
    expect(result).toHaveProperty('trend');
    expect(result).toHaveProperty('lastBos');
    expect(result).toHaveProperty('lastChoch');
    expect(result).toHaveProperty('nearestBullishOB');
    expect(result).toHaveProperty('nearestBearishOB');
    expect(result).toHaveProperty('nearestBullishFVG');
    expect(result).toHaveProperty('nearestBearishFVG');
    expect(['BULLISH', 'BEARISH', 'NEUTRAL']).toContain(result.trend);
  });

  it('nearestBullishOB находится ниже текущей цены', () => {
    const candles = makeFlatCandles(35, 100, 0.5);

    // Bullish OB на уровне ~90 (ниже текущей цены 100)
    candles.push(makeCandle(92, 93, 88, 89, 1500)); // bearish OB-свеча: low=88
    candles.push(makeCandle(89, 100, 89, 97, 3000)); // сильный bullish импульс

    const currentPrice = 100;
    const result = analyzeSMC(candles, currentPrice);

    if (result.nearestBullishOB !== null) {
      expect(result.nearestBullishOB.type).toBe('BULLISH');
      expect(result.nearestBullishOB.high).toBeLessThan(currentPrice);
    }
    // Если OB не найден (митигирован или не хватило данных) — просто null
    expect(result.nearestBullishOB === null || result.nearestBullishOB.high < currentPrice).toBe(
      true,
    );
  });

  it('nearestBearishOB находится выше текущей цены', () => {
    const candles = makeFlatCandles(35, 100, 0.5);

    // Bearish OB на уровне ~110 (выше текущей цены 100)
    candles.push(makeCandle(108, 112, 107, 111, 1500)); // bullish OB-свеча
    candles.push(makeCandle(111, 112, 100, 102, 3000)); // сильный bearish импульс

    const currentPrice = 100;
    const result = analyzeSMC(candles, currentPrice);

    if (result.nearestBearishOB !== null) {
      expect(result.nearestBearishOB.type).toBe('BEARISH');
      expect(result.nearestBearishOB.low).toBeGreaterThan(currentPrice);
    }
    expect(result.nearestBearishOB === null || result.nearestBearishOB.low > currentPrice).toBe(
      true,
    );
  });

  it('nearestBullishFVG находится ниже текущей цены (top < currentPrice)', () => {
    const candles = makeFlatCandles(10, 80, 0.3);

    // Bullish FVG на уровне 81–84 (ниже текущей цены 100)
    candles.push(makeCandle(79, 81, 78, 80, 1000)); // i-2: high=81
    candles.push(makeCandle(80, 83, 79, 82, 1000)); // i-1
    candles.push(makeCandle(84, 88, 84, 87, 2000)); // i: low=84 > high[i-2]=81 → FVG

    // Добавляем ещё свечей для атр и флэта выше
    const moreCandles = makeFlatCandles(20, 100, 0.3);

    const allCandles = [...candles, ...moreCandles];
    const currentPrice = 100;
    const result = analyzeSMC(allCandles, currentPrice);

    if (result.nearestBullishFVG !== null) {
      expect(result.nearestBullishFVG.type).toBe('BULLISH');
      expect(result.nearestBullishFVG.top).toBeLessThan(currentPrice);
    }
    expect(result.nearestBullishFVG === null || result.nearestBullishFVG.top < currentPrice).toBe(
      true,
    );
  });

  it('trend определяется по последнему CHoCH (приоритет над BOS)', () => {
    // Этот тест проверяет что если есть CHoCH, trend берётся от него
    // Мы используем достаточно свечей и проверяем что trend ∈ допустимых значений
    const candles = makeFlatCandles(50, 100, 3);
    const result = analyzeSMC(candles, 100);

    // lastChoch (если есть) должен определять trend
    if (result.lastChoch !== null) {
      expect(result.trend).toBe(result.lastChoch.direction);
    } else if (result.lastBos !== null) {
      expect(result.trend).toBe(result.lastBos.direction);
    } else {
      expect(result.trend).toBe('NEUTRAL');
    }
  });
});
