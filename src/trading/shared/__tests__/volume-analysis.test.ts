import { describe, expect, it } from 'vitest';
import { buildVolumeProfile } from '../volume-analysis.js';
import type { OHLC, RecentTrade } from '../types.js';

function makeCandles(count: number): OHLC[] {
  return Array.from({ length: count }, (_, i) => ({
    time: new Date(Date.now() - (count - i) * 60000 * 15).toISOString(),
    open: 100 + Math.sin(i * 0.3) * 5,
    high: 100 + Math.sin(i * 0.3) * 5 + 2,
    low: 100 + Math.sin(i * 0.3) * 5 - 2,
    close: 100 + Math.sin(i * 0.3) * 5 + 1,
    volume: 1000 + i * 100,
  }));
}

describe('buildVolumeProfile', () => {
  it('рассчитывает VWAP', () => {
    const candles = makeCandles(50);
    const profile = buildVolumeProfile(candles, []);
    expect(profile.vwap).toBeGreaterThan(0);
  });

  it('рассчитывает volume delta с trades', () => {
    const candles = makeCandles(50);
    const buyTrades: RecentTrade[] = Array.from({ length: 20 }, (_, i) => ({
      price: 100,
      qty: 100,
      side: 'Buy' as const,
      time: new Date(Date.now() - i * 1000).toISOString(),
    }));
    const profile = buildVolumeProfile(candles, buyTrades);
    expect(profile.volumeDelta).toBeGreaterThan(0);
  });

  it('рассчитывает relative volume', () => {
    const candles = makeCandles(50);
    const profile = buildVolumeProfile(candles, []);
    expect(profile.relativeVolume).toBeGreaterThan(0);
  });

  it('находит high volume nodes', () => {
    const candles = makeCandles(50);
    const profile = buildVolumeProfile(candles, []);
    expect(Array.isArray(profile.highVolumeNodes)).toBe(true);
  });

  it('работает без recent trades', () => {
    const candles = makeCandles(30);
    const profile = buildVolumeProfile(candles, []);
    expect(profile.vwap).toBeGreaterThan(0);
    expect(typeof profile.volumeDelta).toBe('number');
    expect(typeof profile.relativeVolume).toBe('number');
  });

  it('sell-heavy trades дают отрицательный delta', () => {
    const candles = makeCandles(50);
    const sellTrades: RecentTrade[] = Array.from({ length: 20 }, (_, i) => ({
      price: 100,
      qty: 100,
      side: 'Sell' as const,
      time: new Date(Date.now() - i * 1000).toISOString(),
    }));
    const profile = buildVolumeProfile(candles, sellTrades);
    expect(profile.volumeDelta).toBeLessThan(0);
  });
});
