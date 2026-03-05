import { calculateVWAP } from './indicators.js';
import type { OHLC, RecentTrade, VolumeProfile } from './types.js';

/**
 * Строит Volume Profile из свечей и recent trades.
 */
export function buildVolumeProfile(candles: OHLC[], recentTrades: RecentTrade[]): VolumeProfile {
  const vwap = calculateVWAP(candles);

  // Volume Delta из recent trades (buy vol - sell vol)
  let buyVolume = 0;
  let sellVolume = 0;
  for (const t of recentTrades) {
    if (t.side === 'Buy') buyVolume += t.qty * t.price;
    else sellVolume += t.qty * t.price;
  }
  const volumeDelta = Math.round((buyVolume - sellVolume) * 100) / 100;

  // Relative Volume: текущий объём vs средний
  const relativeVolume = calculateRelativeVolume(candles);

  // High Volume Nodes из свечей
  const highVolumeNodes = findHighVolumeNodes(candles);

  // Средний объём одной свечи в USD для нормализации delta
  const avgCandleVolume =
    candles.length > 0
      ? candles.reduce((s, c) => s + c.volume * ((c.high + c.low + c.close) / 3), 0) /
        candles.length
      : 0;

  return {
    vwap,
    volumeDelta,
    relativeVolume,
    highVolumeNodes,
    avgCandleVolumeUsd: Math.round(avgCandleVolume),
  };
}

/**
 * Relative Volume = средний объём последних 5 свечей / средний объём за весь период.
 */
function calculateRelativeVolume(candles: OHLC[]): number {
  if (candles.length < 10) return 1;

  const totalAvg = candles.reduce((s, c) => s + c.volume, 0) / candles.length;
  if (totalAvg === 0) return 1;

  const recent = candles.slice(-5);
  const recentAvg = recent.reduce((s, c) => s + c.volume, 0) / recent.length;

  return Math.round((recentAvg / totalAvg) * 100) / 100;
}

/**
 * Находит уровни с повышенным объёмом (> 1.5x среднего).
 */
function findHighVolumeNodes(candles: OHLC[]): number[] {
  if (candles.length < 10) return [];

  const avgVolume = candles.reduce((s, c) => s + c.volume, 0) / candles.length;
  const threshold = avgVolume * 1.5;
  const nodes: number[] = [];

  for (const c of candles) {
    if (c.volume > threshold) {
      const typicalPrice = (c.high + c.low + c.close) / 3;
      nodes.push(Math.round(typicalPrice * 100) / 100);
    }
  }

  return nodes;
}
