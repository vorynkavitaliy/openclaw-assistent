import type { FundingDataPoint, OIDataPoint, OrderbookData } from './types.js';

export interface OrderflowAnalysis {
  obImbalance: number; // -1..+1 (bid-heavy = positive)
  oiTrend: 'RISING' | 'FALLING' | 'FLAT';
  oiDelta24h: number; // % change за 24h
  fundingTrend: 'LONGS_PAYING' | 'SHORTS_PAYING' | 'NEUTRAL';
  fundingExtreme: boolean;
  bidWallDistance: number; // % от текущей цены
  askWallDistance: number;
}

/**
 * Анализирует orderflow: orderbook imbalance, OI trend, funding trend.
 */
export function analyzeOrderflow(
  orderbook: OrderbookData,
  oiHistory: OIDataPoint[],
  fundingHistory: FundingDataPoint[],
  currentPrice: number,
): OrderflowAnalysis {
  return {
    obImbalance: orderbook.imbalance,
    oiTrend: getOITrend(oiHistory),
    oiDelta24h: getOIDelta24h(oiHistory),
    fundingTrend: getFundingTrend(fundingHistory),
    fundingExtreme: isFundingExtreme(fundingHistory),
    bidWallDistance:
      currentPrice > 0 && orderbook.bidWallPrice > 0
        ? Math.round(((currentPrice - orderbook.bidWallPrice) / currentPrice) * 10000) / 100
        : 0,
    askWallDistance:
      currentPrice > 0 && orderbook.askWallPrice > 0
        ? Math.round(((orderbook.askWallPrice - currentPrice) / currentPrice) * 10000) / 100
        : 0,
  };
}

function getOITrend(oiHistory: OIDataPoint[]): 'RISING' | 'FALLING' | 'FLAT' {
  if (oiHistory.length < 10) return 'FLAT';

  // Сравниваем среднее последних 12 точек (1ч) с предыдущими 12
  const recent = oiHistory.slice(-12);
  const prev = oiHistory.slice(-24, -12);

  if (prev.length === 0) return 'FLAT';

  const recentAvg = recent.reduce((s, p) => s + p.openInterest, 0) / recent.length;
  const prevAvg = prev.reduce((s, p) => s + p.openInterest, 0) / prev.length;

  const change = prevAvg > 0 ? (recentAvg - prevAvg) / prevAvg : 0;

  if (change > 0.02) return 'RISING'; // > 2% growth
  if (change < -0.02) return 'FALLING'; // > 2% decline
  return 'FLAT';
}

function getOIDelta24h(oiHistory: OIDataPoint[]): number {
  if (oiHistory.length < 2) return 0;

  const first = oiHistory[0]!;
  const last = oiHistory[oiHistory.length - 1]!;

  if (first.openInterest === 0) return 0;
  return Math.round(((last.openInterest - first.openInterest) / first.openInterest) * 10000) / 100;
}

function getFundingTrend(
  fundingHistory: FundingDataPoint[],
): 'LONGS_PAYING' | 'SHORTS_PAYING' | 'NEUTRAL' {
  if (fundingHistory.length === 0) return 'NEUTRAL';

  // Средний funding за последние 3 записи
  const recent = fundingHistory.slice(-3);
  const avgRate = recent.reduce((s, f) => s + f.rate, 0) / recent.length;

  if (avgRate > 0.0001) return 'LONGS_PAYING';
  if (avgRate < -0.0001) return 'SHORTS_PAYING';
  return 'NEUTRAL';
}

function isFundingExtreme(fundingHistory: FundingDataPoint[]): boolean {
  if (fundingHistory.length === 0) return false;

  const last = fundingHistory[fundingHistory.length - 1]!;
  return Math.abs(last.rate) > 0.0005; // > 0.05% considered extreme
}
