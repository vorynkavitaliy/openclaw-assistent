import { describe, expect, it } from 'vitest';
import { detectMarketRegime, getRegimeThreshold } from '../regime.js';
import type { OHLC } from '../types.js';

function makeCandles(
  count: number,
  basePrice: number = 100,
  trend: 'up' | 'down' | 'flat' | 'volatile' = 'flat',
): OHLC[] {
  const candles: OHLC[] = [];
  let price = basePrice;
  for (let i = 0; i < count; i++) {
    let change: number;
    let volatility: number;
    switch (trend) {
      case 'up':
        change = 1;
        volatility = 0.5;
        break;
      case 'down':
        change = -1;
        volatility = 0.5;
        break;
      case 'volatile':
        change = (Math.random() - 0.5) * 10;
        volatility = 5;
        break;
      default:
        change = Math.sin(i * 0.5) * 0.3;
        volatility = 0.5;
        break;
    }
    price += change;
    candles.push({
      time: new Date(Date.now() - (count - i) * 60000 * 240).toISOString(),
      open: price - 0.1,
      high: price + volatility,
      low: price - volatility,
      close: price + 0.05,
      volume: 1000,
    });
  }
  return candles;
}

describe('detectMarketRegime', () => {
  it('возвращает RANGING при недостаточно данных', () => {
    const candles = makeCandles(10);
    expect(detectMarketRegime(candles)).toBe('RANGING');
  });

  it('определяет режим для 50+ свечей', () => {
    const candles = makeCandles(60, 100, 'flat');
    const regime = detectMarketRegime(candles);
    expect(['STRONG_TREND', 'WEAK_TREND', 'RANGING', 'VOLATILE', 'CHOPPY']).toContain(regime);
  });

  it('различает тренд и flat', () => {
    const trendCandles = makeCandles(100, 100, 'up');
    const flatCandles = makeCandles(100, 100, 'flat');

    const trendRegime = detectMarketRegime(trendCandles);
    const flatRegime = detectMarketRegime(flatCandles);

    expect(trendRegime).not.toBe(flatRegime);
  });
});

describe('getRegimeThreshold', () => {
  it('STRONG_TREND имеет самый низкий порог', () => {
    expect(getRegimeThreshold('STRONG_TREND')).toBe(15);
  });

  it('CHOPPY имеет самый высокий порог', () => {
    expect(getRegimeThreshold('CHOPPY')).toBe(35);
  });

  it('пороги растут от тренда к чоппу', () => {
    const strong = getRegimeThreshold('STRONG_TREND');
    const weak = getRegimeThreshold('WEAK_TREND');
    const ranging = getRegimeThreshold('RANGING');
    const volatile_ = getRegimeThreshold('VOLATILE');
    const choppy = getRegimeThreshold('CHOPPY');

    expect(strong).toBeLessThan(weak);
    expect(weak).toBeLessThan(ranging);
    expect(ranging).toBeLessThan(volatile_);
    expect(volatile_).toBeLessThan(choppy);
  });
});
