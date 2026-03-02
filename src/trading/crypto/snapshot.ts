/**
 * Crypto Snapshot — Raw market data collector for AI analysis.
 *
 * Collects: balance, positions, market analysis (EMA/RSI/ATR/bias),
 * market info (funding, OI, volume, 24h change) for ALL pairs.
 * NO signal generation — the AI agent analyzes and decides.
 *
 * Usage:
 *   npx tsx src/trading/crypto/snapshot.ts
 *   npx tsx src/trading/crypto/snapshot.ts --pair=BTCUSDT
 */

import { getArg } from '../../utils/args.js';
import { runMain } from '../../utils/process.js';
import type { AccountInfo, MarketAnalysis, MarketInfo, Position } from '../shared/types.js';
import { getBalance, getMarketAnalysis, getMarketInfo, getPositions } from './bybit-client.js';
import config from './config.js';
import * as state from './state.js';

interface PairSnapshot {
  pair: string;
  market: MarketInfo | null;
  trend: MarketAnalysis | null; // H4 (240) — trend direction
  entry: MarketAnalysis | null; // M15 (15) — entry timeframe
}

interface Snapshot {
  timestamp: string;
  type: 'market_snapshot';
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
  pairs: PairSnapshot[];
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

async function collectPairData(pair: string): Promise<PairSnapshot> {
  const [market, trend, entry] = await Promise.all([
    getMarketInfo(pair).catch(() => null),
    getMarketAnalysis(pair, config.trendTF).catch(() => null),
    getMarketAnalysis(pair, config.entryTF).catch(() => null),
  ]);

  return { pair, market, trend, entry };
}

async function main(): Promise<void> {
  const singlePair = getArg('pair');
  const pairs = singlePair ? [singlePair.toUpperCase()] : config.pairs;

  // Collect all data in parallel
  const [account, positions, ...pairSnapshots] = await Promise.all([
    getBalance(),
    getPositions(),
    ...pairs.map((p) => collectPairData(p)),
  ]);

  // Get daily stats from state
  const st = state.load();
  const daily = st.daily;

  const snapshot: Snapshot = {
    timestamp: new Date().toISOString(),
    type: 'market_snapshot',
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
