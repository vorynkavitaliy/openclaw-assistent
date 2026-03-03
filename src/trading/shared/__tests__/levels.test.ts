import { describe, expect, it } from 'vitest';
import { calculatePivotLevels, findVolumeClusterLevels } from '../levels.js';
import type { OHLC } from '../types.js';

function makeCandles(count: number, basePrice: number = 100): OHLC[] {
  const candles: OHLC[] = [];
  let price = basePrice;
  for (let i = 0; i < count; i++) {
    price += Math.sin(i * 0.3) * 2;
    candles.push({
      time: new Date(Date.now() - (count - i) * 60000 * 240).toISOString(),
      open: price - 0.5,
      high: price + 2,
      low: price - 2,
      close: price + 0.3,
      volume: 1000 + Math.abs(Math.sin(i)) * 5000,
    });
  }
  return candles;
}

describe('calculatePivotLevels', () => {
  it('возвращает нули для пустого массива', () => {
    const pivots = calculatePivotLevels([]);
    expect(pivots.pivotPoint).toBe(0);
  });

  it('рассчитывает pivot points корректно', () => {
    const candles: OHLC[] = [
      { time: '2026-01-01T00:00:00Z', open: 100, high: 110, low: 90, close: 105, volume: 1000 },
    ];
    const pivots = calculatePivotLevels(candles);

    // PP = (H + L + C) / 3 = (110 + 90 + 105) / 3 ≈ 101.67
    expect(pivots.pivotPoint).toBeCloseTo(101.67, 1);

    // R1 > PP > S1
    expect(pivots.r1).toBeGreaterThan(pivots.pivotPoint);
    expect(pivots.pivotPoint).toBeGreaterThan(pivots.s1);

    // R3 > R2 > R1 > PP > S1 > S2 > S3
    expect(pivots.r3).toBeGreaterThan(pivots.r2);
    expect(pivots.r2).toBeGreaterThan(pivots.r1);
    expect(pivots.s1).toBeGreaterThan(pivots.s2);
    expect(pivots.s2).toBeGreaterThan(pivots.s3);
  });

  it('использует последнюю свечу', () => {
    const candles = makeCandles(10);
    const pivots = calculatePivotLevels(candles);
    expect(pivots.pivotPoint).toBeGreaterThan(0);
  });
});

describe('findVolumeClusterLevels', () => {
  it('возвращает пустой объект для малого массива', () => {
    const clusters = findVolumeClusterLevels([]);
    expect(clusters.pocPrice).toBe(0);
    expect(clusters.highVolumeLevels).toEqual([]);
  });

  it('рассчитывает POC и value area', () => {
    const candles = makeCandles(50);
    const clusters = findVolumeClusterLevels(candles);

    const allLows = candles.map((c) => c.low);
    const allHighs = candles.map((c) => c.high);
    const minPrice = Math.min(...allLows);
    const maxPrice = Math.max(...allHighs);

    expect(clusters.pocPrice).toBeGreaterThanOrEqual(minPrice);
    expect(clusters.pocPrice).toBeLessThanOrEqual(maxPrice);

    // Value Area: VAH > VAL
    expect(clusters.valueAreaHigh).toBeGreaterThan(clusters.valueAreaLow);

    // High volume levels — массив
    expect(Array.isArray(clusters.highVolumeLevels)).toBe(true);
  });
});
