/**
 * Crypto Snapshot V2 — Extended market data with confluence scoring.
 *
 * Collects ALL data needed for quality trading decisions:
 * - Multi-timeframe analysis (D1, H4, H1, M15, M5)
 * - Orderbook depth, OI history, funding history
 * - Volume profile, VWAP, volume delta
 * - Market regime detection
 * - Confluence scoring (-100..+100)
 * - Pre-computed trade setups for top pairs
 *
 * Usage:
 *   npx tsx src/trading/crypto/snapshot-v2.ts
 *   npx tsx src/trading/crypto/snapshot-v2.ts --pair=BTCUSDT
 */

import { getArg } from '../../utils/args.js';
import { createLogger } from '../../utils/logger.js';
import { runMain } from '../../utils/process.js';
import { calculateConfluenceScore, type ConfluenceInput } from '../shared/confluence.js';
import { calculatePivotLevels, findVolumeClusterLevels } from '../shared/levels.js';
import { detectMarketRegime } from '../shared/regime.js';
import type {
  AccountInfo,
  ConfluenceScore,
  FundingDataPoint,
  MarketAnalysis,
  MarketInfo,
  MarketRegime,
  OIDataPoint,
  OrderbookData,
  PivotLevels,
  Position,
  VolumeClusterLevels,
  VolumeProfile,
} from '../shared/types.js';
import { buildVolumeProfile } from '../shared/volume-analysis.js';
import {
  getBalance,
  getFundingHistory,
  getKlines,
  getMarketAnalysis,
  getMarketInfo,
  getOIHistory,
  getOrderbook,
  getPositions,
  getRecentTrades,
} from './bybit-client.js';
import config from './config.js';
import * as state from './state.js';

const log = createLogger('snapshot-v2');

interface PairSnapshotV2 {
  pair: string;
  market: MarketInfo | null;
  timeframes: {
    d1: MarketAnalysis | null;
    h4: MarketAnalysis | null;
    h1: MarketAnalysis | null;
    m15: MarketAnalysis | null;
    m5: MarketAnalysis | null;
  };
  orderbook: OrderbookData | null;
  oiHistory: OIDataPoint[];
  fundingHistory: FundingDataPoint[];
  volumeProfile: VolumeProfile | null;
  pivotLevels: PivotLevels | null;
  volumeClusters: VolumeClusterLevels | null;
  regime: MarketRegime;
  confluence: ConfluenceScore | null;
  suggestedTrade: {
    side: 'Buy' | 'Sell';
    entry: number;
    sl: number;
    tp1: number;
    tp2: number;
    tp3: number;
    rr: number;
  } | null;
}

interface SnapshotV2 {
  timestamp: string;
  type: 'market_snapshot_v2';
  account: AccountInfo;
  positions: Position[];
  dailyStats: {
    trades: number;
    wins: number;
    losses: number;
    stops: number;
    totalPnl: number;
    stopDay: boolean;
    stopDayReason: string | null;
  };
  killSwitch: boolean;
  pairs: PairSnapshotV2[];
  bestSetups: string[]; // top-3 по confluence score
  config: {
    riskPerTrade: number;
    maxDailyLoss: number;
    maxStopsPerDay: number;
    maxRiskPerTrade: number;
    maxOpenPositions: number;
    defaultLeverage: number;
    minRR: number;
    mode: string;
  };
}

async function collectPairDataV2(pair: string): Promise<PairSnapshotV2> {
  // Collect all data in parallel
  const [
    market,
    d1,
    h4,
    h1,
    m15,
    m5,
    orderbook,
    oiHistory,
    fundingHistory,
    recentTrades,
    m15Candles,
    h4Candles,
  ] = await Promise.all([
    getMarketInfo(pair).catch(() => null),
    getMarketAnalysis(pair, 'D', 200).catch(() => null),
    getMarketAnalysis(pair, '240', 200).catch(() => null),
    getMarketAnalysis(pair, '60', 200).catch(() => null),
    getMarketAnalysis(pair, '15', 200).catch(() => null),
    getMarketAnalysis(pair, '5', 100).catch(() => null),
    getOrderbook(pair, 25).catch(() => null),
    getOIHistory(pair, 24).catch(() => []),
    getFundingHistory(pair, 20).catch(() => []),
    getRecentTrades(pair, 500).catch(() => []),
    getKlines(pair, '15', 200).catch(() => []),
    getKlines(pair, '240', 200).catch(() => []),
  ]);

  // Volume profile from M15 candles + recent trades
  const volumeProfile = m15Candles.length > 0 ? buildVolumeProfile(m15Candles, recentTrades) : null;

  // Pivot levels from H4 candles
  const pivotLevels = h4Candles.length > 0 ? calculatePivotLevels(h4Candles) : null;

  // Volume clusters from H4 candles
  const volumeClusters = h4Candles.length > 0 ? findVolumeClusterLevels(h4Candles) : null;

  // Market regime from H4 candles
  const regime = h4Candles.length >= 50 ? detectMarketRegime(h4Candles) : 'RANGING';

  // Confluence scoring
  let confluence: ConfluenceScore | null = null;
  if (m15 && market && orderbook && volumeProfile) {
    const input: ConfluenceInput = {
      trendTF: d1 ?? h4,
      zonesTF: h1,
      entryTF: m15,
      precisionTF: m5,
      entryCandles: m15Candles,
      orderbook,
      oiHistory,
      fundingHistory,
      volumeProfile,
      regime,
      market,
    };
    confluence = calculateConfluenceScore(input);
  }

  // Suggested trade setup
  const suggestedTrade = buildSuggestedTrade(confluence, market, m15, orderbook);

  return {
    pair,
    market,
    timeframes: { d1, h4, h1, m15, m5 },
    orderbook,
    oiHistory,
    fundingHistory,
    volumeProfile,
    pivotLevels,
    volumeClusters,
    regime,
    confluence,
    suggestedTrade,
  };
}

function buildSuggestedTrade(
  confluence: ConfluenceScore | null,
  market: MarketInfo | null,
  m15: MarketAnalysis | null,
  orderbook: OrderbookData | null,
): PairSnapshotV2['suggestedTrade'] {
  if (!confluence || !market || !m15) return null;

  const score = confluence.total;
  const absScore = Math.abs(score);
  if (absScore < 40) return null; // Too weak

  const side: 'Buy' | 'Sell' = score > 0 ? 'Buy' : 'Sell';
  const atr = m15.indicators.atr14;
  const price = market.lastPrice;

  if (atr === 0 || price === 0) return null;

  // Entry: use limit price (bid1 for buy, ask1 for sell)
  const entry =
    side === 'Buy' ? (orderbook?.bids[0]?.price ?? price) : (orderbook?.asks[0]?.price ?? price);

  // SL: 1.5 * ATR from entry
  const slDistance = atr * 1.5;
  const sl = side === 'Buy' ? entry - slDistance : entry + slDistance;

  // TP: 1.5x, 2x, 3x R:R
  const tp1 = side === 'Buy' ? entry + slDistance * 1.5 : entry - slDistance * 1.5;
  const tp2 = side === 'Buy' ? entry + slDistance * 2 : entry - slDistance * 2;
  const tp3 = side === 'Buy' ? entry + slDistance * 3 : entry - slDistance * 3;

  const round = (n: number) => Math.round(n * 100) / 100;

  return {
    side,
    entry: round(entry),
    sl: round(sl),
    tp1: round(tp1),
    tp2: round(tp2),
    tp3: round(tp3),
    rr: 2,
  };
}

async function main(): Promise<void> {
  const singlePair = getArg('pair');
  const pairs = singlePair ? [singlePair.toUpperCase()] : config.pairs;

  log.info(`Collecting snapshot V2 for ${pairs.length} pairs...`);

  // Collect account data + all pairs in parallel
  const [account, positions, ...pairSnapshots] = await Promise.all([
    getBalance(),
    getPositions(),
    ...pairs.map((p) => collectPairDataV2(p)),
  ]);

  // Get daily stats from state
  const st = state.load();
  const daily = st.daily;

  // Find best setups (top-3 by absolute confluence score)
  const scored = pairSnapshots
    .filter((p) => p.confluence !== null)
    .sort((a, b) => Math.abs(b.confluence!.total) - Math.abs(a.confluence!.total));

  const bestSetups = scored.slice(0, 3).map((p) => {
    const c = p.confluence!;
    return `${p.pair}: score=${c.total} ${c.signal} (${c.details[0] ?? ''})`;
  });

  const snapshot: SnapshotV2 = {
    timestamp: new Date().toISOString(),
    type: 'market_snapshot_v2',
    account,
    positions,
    dailyStats: {
      trades: daily.trades,
      wins: daily.wins,
      losses: daily.losses,
      stops: daily.stops,
      totalPnl: daily.totalPnl,
      stopDay: daily.stopDay,
      stopDayReason: daily.stopDayReason,
    },
    killSwitch: state.isKillSwitchActive(),
    pairs: pairSnapshots,
    bestSetups,
    config: {
      riskPerTrade: config.riskPerTrade,
      maxDailyLoss: config.maxDailyLoss,
      maxStopsPerDay: config.maxStopsPerDay,
      maxRiskPerTrade: config.maxRiskPerTrade,
      maxOpenPositions: config.maxOpenPositions,
      defaultLeverage: config.defaultLeverage,
      minRR: config.minRR,
      mode: config.mode,
    },
  };

  // Output clean JSON to stdout
  console.log(JSON.stringify(snapshot, null, 2));
}

runMain(main);
