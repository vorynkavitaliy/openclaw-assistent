import { describe, expect, it } from 'vitest';
import {
  calculateConfluenceScore,
  DEFAULT_CONFLUENCE_CONFIG,
  type ConfluenceInput,
} from '../confluence.js';
import type { MarketAnalysis, MarketInfo, OHLC, OrderbookData, VolumeProfile } from '../types.js';

function makeEntryTF(bias: 'BULLISH' | 'BEARISH' | 'UNKNOWN' = 'BULLISH'): MarketAnalysis {
  const isBearish = bias === 'BEARISH';
  return {
    pair: 'BTCUSDT',
    timeframe: '15',
    barsCount: 200,
    source: 'bybit',
    currentPrice: 50000,
    lastBar: {
      time: '2026-01-01T00:00:00Z',
      open: 49900,
      high: 50100,
      low: 49800,
      close: 50000,
      volume: 100,
    },
    indicators: {
      ema200: isBearish ? 52000 : 48000,
      ema50: isBearish ? 50500 : 49500,
      ema20: isBearish ? 50200 : 49800,
      ema21: isBearish ? 50250 : 49750,
      ema9: isBearish ? 50100 : 49900, // Bearish: ema9 < ema21; Bullish: ema9 > ema21
      ema3: isBearish ? 50050 : 49950,
      rsi14: isBearish ? 45 : 55,
      atr14: 200,
      roc6: isBearish ? -0.5 : 0.5,
      roc2: isBearish ? -0.2 : 0.2,
      impulse: 0,
    },
    levels: { support: 49500, resistance: 50500 },
    bias: { emaTrend: bias, priceVsEma200: isBearish ? 'BELOW' : 'ABOVE', rsiZone: 'NEUTRAL' },
    timestamp: new Date().toISOString(),
  };
}

function makeOrderbook(): OrderbookData {
  return {
    bids: [
      { price: 49990, qty: 10 },
      { price: 49980, qty: 5 },
    ],
    asks: [
      { price: 50010, qty: 8 },
      { price: 50020, qty: 6 },
    ],
    bidWallPrice: 49900,
    askWallPrice: 50100,
    imbalance: 0.1,
    spread: 20,
    timestamp: new Date().toISOString(),
  };
}

function makeVolumeProfile(): VolumeProfile {
  return {
    vwap: 49950,
    volumeDelta: 5000,
    relativeVolume: 1.5,
    highVolumeNodes: [49800, 50200],
    avgCandleVolumeUsd: 100000,
  };
}

function makeMarket(): MarketInfo {
  return {
    lastPrice: 50000,
    price24hPct: 0.02,
    high24h: 50500,
    low24h: 49000,
    volume24h: 1000000,
    turnover24h: 50000000000,
    fundingRate: 0.0001,
    nextFundingTime: new Date(Date.now() + 3600000).toISOString(),
    bid1: 49990,
    ask1: 50010,
    openInterest: 500000000,
  };
}

function makeCandles(count: number): OHLC[] {
  return Array.from({ length: count }, (_, i) => ({
    time: new Date(Date.now() - (count - i) * 60000 * 15).toISOString(),
    open: 50000 + Math.sin(i * 0.3) * 100,
    high: 50000 + Math.sin(i * 0.3) * 100 + 50,
    low: 50000 + Math.sin(i * 0.3) * 100 - 50,
    close: 50000 + Math.sin(i * 0.3) * 100 + 20,
    volume: 1000,
  }));
}

function makeBullishInput(): ConfluenceInput {
  return {
    trendTF: makeEntryTF('BULLISH'),
    zonesTF: makeEntryTF('BULLISH'),
    entryTF: makeEntryTF('BULLISH'),
    precisionTF: makeEntryTF('BULLISH'),
    entryCandles: makeCandles(100),
    orderbook: makeOrderbook(),
    oiHistory: [
      {
        timestamp: new Date(Date.now() - 3600000).toISOString(),
        openInterest: 490000000,
        delta: 0,
      },
      { timestamp: new Date().toISOString(), openInterest: 500000000, delta: 10000000 },
    ],
    fundingHistory: [{ timestamp: new Date().toISOString(), rate: 0.0001 }],
    volumeProfile: makeVolumeProfile(),
    regime: 'STRONG_TREND',
    market: makeMarket(),
  };
}

describe('calculateConfluenceScore', () => {
  it('возвращает score в диапазоне -100..+100', () => {
    const input = makeBullishInput();
    const result = calculateConfluenceScore(input);
    expect(result.total).toBeGreaterThanOrEqual(-100);
    expect(result.total).toBeLessThanOrEqual(100);
  });

  it('bullish alignment даёт положительный score', () => {
    const input = makeBullishInput();
    const result = calculateConfluenceScore(input);
    expect(result.total).toBeGreaterThan(0);
    expect(result.signal).toMatch(/LONG/);
  });

  it('bearish alignment даёт отрицательный score', () => {
    const input = makeBullishInput();
    input.trendTF = makeEntryTF('BEARISH');
    input.zonesTF = makeEntryTF('BEARISH');
    input.entryTF = makeEntryTF('BEARISH');
    const result = calculateConfluenceScore(input);
    expect(result.total).toBeLessThan(0);
  });

  it('CHOPPY режим снижает score', () => {
    const input = makeBullishInput();
    input.regime = 'CHOPPY';
    const result = calculateConfluenceScore(input);
    expect(result.regime).toBe(-10);
  });

  it('содержит все компоненты score', () => {
    const input = makeBullishInput();
    const result = calculateConfluenceScore(input);
    expect(typeof result.trend).toBe('number');
    expect(typeof result.momentum).toBe('number');
    expect(typeof result.volume).toBe('number');
    expect(typeof result.structure).toBe('number');
    expect(typeof result.orderflow).toBe('number');
    expect(typeof result.regime).toBe('number');
  });

  it('компоненты в допустимых диапазонах', () => {
    const input = makeBullishInput();
    const result = calculateConfluenceScore(input);
    // trend расширен до ±20, остальные ±10
    expect(result.trend).toBeGreaterThanOrEqual(-20);
    expect(result.trend).toBeLessThanOrEqual(20);
    for (const c of [
      result.momentum,
      result.volume,
      result.structure,
      result.orderflow,
      result.regime,
    ]) {
      expect(c).toBeGreaterThanOrEqual(-10);
      expect(c).toBeLessThanOrEqual(10);
    }
  });

  it('details не пустой', () => {
    const input = makeBullishInput();
    const result = calculateConfluenceScore(input);
    expect(result.details.length).toBeGreaterThan(0);
  });

  it('confidence 0-100', () => {
    const input = makeBullishInput();
    const result = calculateConfluenceScore(input);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(100);
  });

  it('signal соответствует score', () => {
    const input = makeBullishInput();
    const result = calculateConfluenceScore(input);
    if (result.total >= 70) expect(result.signal).toBe('STRONG_LONG');
    else if (result.total >= 40) expect(result.signal).toBe('LONG');
    else if (result.total <= -70) expect(result.signal).toBe('STRONG_SHORT');
    else if (result.total <= -40) expect(result.signal).toBe('SHORT');
    else expect(result.signal).toBe('NEUTRAL');
  });
});

describe('intraday bias correction', () => {
  it('сильный bullish 24h (+5%) гасит bearish EMA тренд', () => {
    const input = makeBullishInput();
    input.trendTF = makeEntryTF('BEARISH');
    input.zonesTF = makeEntryTF('BEARISH');
    input.entryTF = makeEntryTF('BEARISH');
    input.market = { ...makeMarket(), price24hPct: 5.0 };

    const result = calculateConfluenceScore(input);
    // С intraday bias bearish trend ослаблен → score ближе к нулю
    expect(result.trend).toBeGreaterThan(-7); // Без коррекции было бы -10
    expect(result.details.some((d) => d.includes('IntradayBias'))).toBe(true);
  });

  it('умеренный 24h (+3%) ослабляет bearish EMA', () => {
    const input = makeBullishInput();
    input.trendTF = makeEntryTF('BEARISH');
    input.zonesTF = makeEntryTF('BEARISH');
    input.entryTF = makeEntryTF('BEARISH');
    input.market = { ...makeMarket(), price24hPct: 3.0 };

    const result = calculateConfluenceScore(input);
    // Bearish full alignment = -13 (EMA -10, fast EMA -3), 60% dampening: -13 * 0.4 = -5.2 → -5
    expect(result.trend).toBe(-5);
  });

  it('малое 24h движение (<2%) не влияет на тренд', () => {
    const input = makeBullishInput();
    input.trendTF = makeEntryTF('BEARISH');
    input.zonesTF = makeEntryTF('BEARISH');
    input.entryTF = makeEntryTF('BEARISH');
    input.market = { ...makeMarket(), price24hPct: 1.5 };

    const result = calculateConfluenceScore(input);
    expect(result.trend).toBe(-13); // Полный bearish alignment (EMA -10 + fast EMA -3) без коррекции
  });

  it('совпадающее направление (bearish EMA + bearish 24h) не корректируется', () => {
    const input = makeBullishInput();
    input.trendTF = makeEntryTF('BEARISH');
    input.zonesTF = makeEntryTF('BEARISH');
    input.entryTF = makeEntryTF('BEARISH');
    input.market = { ...makeMarket(), price24hPct: -5.0 };

    const result = calculateConfluenceScore(input);
    expect(result.trend).toBe(-13); // Без коррекции — EMA и 24h оба bearish
  });
});

describe('DEFAULT_CONFLUENCE_CONFIG', () => {
  it('веса суммируются до 1.0', () => {
    const cfg = DEFAULT_CONFLUENCE_CONFIG;
    const sum =
      cfg.trendWeight +
      cfg.momentumWeight +
      cfg.volumeWeight +
      cfg.structureWeight +
      cfg.orderflowWeight +
      cfg.regimeWeight +
      cfg.candlePatternsWeight +
      cfg.smcWeight;
    expect(sum).toBeCloseTo(1.0, 5);
  });

  it('entryThreshold < strongThreshold', () => {
    expect(DEFAULT_CONFLUENCE_CONFIG.entryThreshold).toBeLessThan(
      DEFAULT_CONFLUENCE_CONFIG.strongThreshold,
    );
  });
});
