import type { OHLC, PivotLevels, VolumeClusterLevels } from './types.js';

/**
 * Classic Pivot Points (Standard).
 * PP = (H + L + C) / 3
 */
export function calculatePivotLevels(candles: OHLC[]): PivotLevels {
  if (candles.length === 0) {
    return { pivotPoint: 0, r1: 0, r2: 0, r3: 0, s1: 0, s2: 0, s3: 0 };
  }

  // Используем последнюю завершённую свечу (или текущую если одна)
  const bar = candles.length > 1 ? candles[candles.length - 2]! : candles[0]!;
  const h = bar.high;
  const l = bar.low;
  const c = bar.close;

  const pp = (h + l + c) / 3;
  const r1 = 2 * pp - l;
  const r2 = pp + (h - l);
  const r3 = h + 2 * (pp - l);
  const s1 = 2 * pp - h;
  const s2 = pp - (h - l);
  const s3 = l - 2 * (h - pp);

  const round = (n: number) => Math.round(n * 100) / 100;

  return {
    pivotPoint: round(pp),
    r1: round(r1),
    r2: round(r2),
    r3: round(r3),
    s1: round(s1),
    s2: round(s2),
    s3: round(s3),
  };
}

/**
 * Volume Profile Analysis.
 * Разбивает ценовой диапазон на bins, считает объём в каждом.
 * POC = уровень с максимальным объёмом.
 * Value Area = 70% объёма вокруг POC.
 */
export function findVolumeClusterLevels(candles: OHLC[], bins: number = 50): VolumeClusterLevels {
  const empty: VolumeClusterLevels = {
    highVolumeLevels: [],
    pocPrice: 0,
    valueAreaHigh: 0,
    valueAreaLow: 0,
  };

  if (candles.length < 10) return empty;

  let minPrice = Infinity;
  let maxPrice = -Infinity;
  for (const c of candles) {
    if (c.low < minPrice) minPrice = c.low;
    if (c.high > maxPrice) maxPrice = c.high;
  }

  const range = maxPrice - minPrice;
  if (range <= 0) return empty;

  const binSize = range / bins;
  const volumeAtPrice = new Array<number>(bins).fill(0);

  for (const c of candles) {
    const typicalPrice = (c.high + c.low + c.close) / 3;
    const binIndex = Math.min(Math.floor((typicalPrice - minPrice) / binSize), bins - 1);
    volumeAtPrice[binIndex] = (volumeAtPrice[binIndex] ?? 0) + c.volume;
  }

  // POC — bin с максимальным объёмом
  let pocBin = 0;
  let maxVol = 0;
  for (let i = 0; i < bins; i++) {
    if (volumeAtPrice[i]! > maxVol) {
      maxVol = volumeAtPrice[i]!;
      pocBin = i;
    }
  }

  const pocPrice = minPrice + (pocBin + 0.5) * binSize;

  // Value Area — 70% объёма вокруг POC
  const totalVolume = volumeAtPrice.reduce((a, b) => a + b, 0);
  const targetVolume = totalVolume * 0.7;

  let vaVolume = volumeAtPrice[pocBin]!;
  let vaHigh = pocBin;
  let vaLow = pocBin;

  while (vaVolume < targetVolume && (vaHigh < bins - 1 || vaLow > 0)) {
    const upVol = vaHigh < bins - 1 ? volumeAtPrice[vaHigh + 1]! : 0;
    const downVol = vaLow > 0 ? volumeAtPrice[vaLow - 1]! : 0;

    if (upVol >= downVol && vaHigh < bins - 1) {
      vaHigh++;
      vaVolume += upVol;
    } else if (vaLow > 0) {
      vaLow--;
      vaVolume += downVol;
    } else {
      vaHigh++;
      vaVolume += upVol;
    }
  }

  // High Volume Nodes — bins с объёмом > 1.5x среднего
  const avgVolPerBin = totalVolume / bins;
  const highVolumeThreshold = avgVolPerBin * 1.5;
  const highVolumeLevels: number[] = [];

  for (let i = 0; i < bins; i++) {
    if (volumeAtPrice[i]! > highVolumeThreshold) {
      highVolumeLevels.push(Math.round((minPrice + (i + 0.5) * binSize) * 100) / 100);
    }
  }

  return {
    highVolumeLevels,
    pocPrice: Math.round(pocPrice * 100) / 100,
    valueAreaHigh: Math.round((minPrice + (vaHigh + 1) * binSize) * 100) / 100,
    valueAreaLow: Math.round((minPrice + vaLow * binSize) * 100) / 100,
  };
}
