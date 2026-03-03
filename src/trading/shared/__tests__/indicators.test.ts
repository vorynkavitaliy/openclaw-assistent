import { describe, expect, it } from 'vitest';
import {
  calculateADX,
  calculateAtr,
  calculateBBWidth,
  calculateEma,
  calculateMACD,
  calculateRsi,
  calculateRsiSeries,
  calculateStochRSI,
  calculateVWAP,
} from '../indicators.js';
import type { OHLC } from '../types.js';

function makeCandles(
  count: number,
  basePrice: number = 100,
  trend: 'up' | 'down' | 'flat' = 'flat',
): OHLC[] {
  const candles: OHLC[] = [];
  let price = basePrice;
  for (let i = 0; i < count; i++) {
    const change = trend === 'up' ? 0.5 : trend === 'down' ? -0.5 : Math.sin(i * 0.3) * 2;
    price += change;
    candles.push({
      time: new Date(Date.now() - (count - i) * 60000).toISOString(),
      open: price - 0.3,
      high: price + 1,
      low: price - 1,
      close: price + 0.2,
      volume: 1000 + i * 10,
    });
  }
  return candles;
}

describe('calculateEma', () => {
  it('возвращает пустой массив при недостаточно данных', () => {
    expect(calculateEma([1, 2, 3], 5)).toEqual([]);
  });

  it('возвращает EMA для достаточных данных', () => {
    const prices = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
    const ema = calculateEma(prices, 5);
    expect(ema.length).toBeGreaterThan(0);
    expect(ema[0]).toBe(12);
  });

  it('EMA следует за трендом', () => {
    const prices = Array.from({ length: 30 }, (_, i) => 100 + i);
    const ema = calculateEma(prices, 10);
    for (let i = 1; i < ema.length; i++) {
      expect(ema[i]!).toBeGreaterThan(ema[i - 1]!);
    }
  });
});

describe('calculateRsi', () => {
  it('возвращает 50 при недостаточно данных', () => {
    expect(calculateRsi([1, 2, 3], 14)).toBe(50);
  });

  it('RSI > 70 при сильном uptrend', () => {
    const prices = Array.from({ length: 30 }, (_, i) => 100 + i * 2);
    const rsi = calculateRsi(prices, 14);
    expect(rsi).toBeGreaterThan(70);
  });

  it('RSI < 30 при сильном downtrend', () => {
    const prices = Array.from({ length: 30 }, (_, i) => 200 - i * 2);
    const rsi = calculateRsi(prices, 14);
    expect(rsi).toBeLessThan(30);
  });

  it('RSI 0-100 range', () => {
    const prices = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i) * 10);
    const rsi = calculateRsi(prices, 14);
    expect(rsi).toBeGreaterThanOrEqual(0);
    expect(rsi).toBeLessThanOrEqual(100);
  });
});

describe('calculateRsiSeries', () => {
  it('возвращает пустой при недостаточно данных', () => {
    expect(calculateRsiSeries([1, 2, 3], 14)).toEqual([]);
  });

  it('возвращает серию RSI значений', () => {
    const prices = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i * 0.5) * 10);
    const series = calculateRsiSeries(prices, 14);
    expect(series.length).toBeGreaterThan(0);
    for (const val of series) {
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThanOrEqual(100);
    }
  });
});

describe('calculateMACD', () => {
  it('возвращает нули при недостаточно данных', () => {
    const result = calculateMACD([1, 2, 3]);
    expect(result.macd).toBe(0);
    expect(result.signal).toBe(0);
    expect(result.histogram).toBe(0);
  });

  it('MACD bullish при uptrend', () => {
    const prices = Array.from({ length: 50 }, (_, i) => 100 + i);
    const result = calculateMACD(prices);
    expect(result.macd).toBeGreaterThan(0);
    // Histogram может быть 0 при устоявшемся линейном тренде (signal = macd)
    expect(result.histogram).toBeGreaterThanOrEqual(0);
  });

  it('MACD bearish при downtrend', () => {
    const prices = Array.from({ length: 50 }, (_, i) => 200 - i);
    const result = calculateMACD(prices);
    expect(result.macd).toBeLessThan(0);
  });
});

describe('calculateStochRSI', () => {
  it('возвращает default при недостаточно данных', () => {
    const result = calculateStochRSI([1, 2, 3]);
    expect(result.k).toBe(50);
    expect(result.d).toBe(50);
  });

  it('K и D в диапазоне 0-100', () => {
    const prices = Array.from({ length: 100 }, (_, i) => 100 + Math.sin(i * 0.3) * 20);
    const result = calculateStochRSI(prices);
    expect(result.k).toBeGreaterThanOrEqual(0);
    expect(result.k).toBeLessThanOrEqual(100);
    expect(result.d).toBeGreaterThanOrEqual(0);
    expect(result.d).toBeLessThanOrEqual(100);
  });
});

describe('calculateVWAP', () => {
  it('возвращает 0 для пустого массива', () => {
    expect(calculateVWAP([])).toBe(0);
  });

  it('рассчитывает VWAP корректно', () => {
    const candles: OHLC[] = [
      { time: '2026-01-01T00:00:00Z', open: 100, high: 110, low: 90, close: 105, volume: 1000 },
      { time: '2026-01-01T01:00:00Z', open: 105, high: 115, low: 95, close: 110, volume: 2000 },
    ];
    const vwap = calculateVWAP(candles);
    expect(vwap).toBeGreaterThan(100);
    expect(vwap).toBeLessThan(115);
  });
});

describe('calculateADX', () => {
  it('возвращает 0 при недостаточно данных', () => {
    expect(calculateADX([1, 2, 3], [0.5, 1.5, 2.5], [1, 2, 3])).toBe(0);
  });

  it('ADX > 0 при сильном тренде', () => {
    const candles = makeCandles(60, 100, 'up');
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const closes = candles.map((c) => c.close);
    const adx = calculateADX(highs, lows, closes);
    expect(adx).toBeGreaterThan(0);
  });
});

describe('calculateBBWidth', () => {
  it('возвращает 0 при недостаточно данных', () => {
    expect(calculateBBWidth([1, 2, 3])).toBe(0);
  });

  it('BB width увеличивается при высокой волатильности', () => {
    const stable = Array.from({ length: 30 }, () => 100);
    const volatile = Array.from({ length: 30 }, (_, i) => 100 + (i % 2 === 0 ? 10 : -10));

    const stableBB = calculateBBWidth(stable);
    const volatileBB = calculateBBWidth(volatile);

    expect(volatileBB).toBeGreaterThan(stableBB);
  });
});

describe('calculateAtr', () => {
  it('возвращает 0 при недостаточно данных', () => {
    expect(calculateAtr([1, 2], [0.5, 1.5], [1, 2])).toBe(0);
  });

  it('ATR > 0 для нормальных данных', () => {
    const candles = makeCandles(30);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const closes = candles.map((c) => c.close);
    const atr = calculateAtr(highs, lows, closes);
    expect(atr).toBeGreaterThan(0);
  });
});
