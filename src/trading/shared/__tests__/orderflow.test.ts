import { describe, expect, it } from 'vitest';
import { analyzeOrderflow } from '../orderflow.js';
import type { FundingDataPoint, OIDataPoint, OrderbookData } from '../types.js';

function makeOrderbook(bidHeavy: boolean = false): OrderbookData {
  return {
    bids: [
      { price: 49990, qty: bidHeavy ? 50 : 10 },
      { price: 49980, qty: bidHeavy ? 30 : 5 },
    ],
    asks: [
      { price: 50010, qty: bidHeavy ? 5 : 10 },
      { price: 50020, qty: bidHeavy ? 3 : 5 },
    ],
    bidWallPrice: bidHeavy ? 49900 : 49950,
    askWallPrice: bidHeavy ? 50200 : 50050,
    imbalance: bidHeavy ? 0.7 : 0,
    spread: 20,
    timestamp: new Date().toISOString(),
  };
}

function makeOIHistory(trend: 'rising' | 'falling' | 'flat' = 'flat'): OIDataPoint[] {
  const base = 500000000;
  const points: OIDataPoint[] = [];
  for (let i = 0; i < 25; i++) {
    let oi: number;
    switch (trend) {
      case 'rising':
        oi = base + i * 10000000;
        break;
      case 'falling':
        oi = base - i * 10000000;
        break;
      default:
        oi = base + (i % 2 === 0 ? 1000000 : -1000000);
        break;
    }
    const prevOi = i > 0 ? (points[i - 1]?.openInterest ?? oi) : oi;
    points.push({
      timestamp: new Date(Date.now() - (25 - i) * 3600000).toISOString(),
      openInterest: oi,
      delta: oi - prevOi,
    });
  }
  return points;
}

function makeFundingHistory(rate: number = 0.0001): FundingDataPoint[] {
  return [
    { timestamp: new Date(Date.now() - 28800000).toISOString(), rate },
    { timestamp: new Date(Date.now() - 14400000).toISOString(), rate },
    { timestamp: new Date().toISOString(), rate },
  ];
}

describe('analyzeOrderflow', () => {
  it('определяет bid-heavy imbalance', () => {
    const result = analyzeOrderflow(
      makeOrderbook(true),
      makeOIHistory(),
      makeFundingHistory(),
      50000,
    );
    expect(result.obImbalance).toBeGreaterThan(0);
  });

  it('определяет rising OI', () => {
    const result = analyzeOrderflow(
      makeOrderbook(),
      makeOIHistory('rising'),
      makeFundingHistory(),
      50000,
    );
    expect(result.oiTrend).toBe('RISING');
  });

  it('определяет falling OI', () => {
    const result = analyzeOrderflow(
      makeOrderbook(),
      makeOIHistory('falling'),
      makeFundingHistory(),
      50000,
    );
    expect(result.oiTrend).toBe('FALLING');
  });

  it('определяет funding trend longs paying', () => {
    const result = analyzeOrderflow(
      makeOrderbook(),
      makeOIHistory(),
      makeFundingHistory(0.0005),
      50000,
    );
    expect(result.fundingTrend).toBe('LONGS_PAYING');
  });

  it('определяет shorts paying', () => {
    const result = analyzeOrderflow(
      makeOrderbook(),
      makeOIHistory(),
      makeFundingHistory(-0.0005),
      50000,
    );
    expect(result.fundingTrend).toBe('SHORTS_PAYING');
  });

  it('содержит все поля анализа', () => {
    const result = analyzeOrderflow(makeOrderbook(), makeOIHistory(), makeFundingHistory(), 50000);
    expect(typeof result.obImbalance).toBe('number');
    expect(typeof result.oiTrend).toBe('string');
    expect(typeof result.oiDelta24h).toBe('number');
    expect(typeof result.fundingTrend).toBe('string');
    expect(typeof result.fundingExtreme).toBe('boolean');
  });
});
