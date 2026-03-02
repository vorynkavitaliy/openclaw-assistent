/**
 * Forex Snapshot — Raw market data collector for AI analysis.
 *
 * Collects: account, positions, drawdown, FTMO alerts,
 * market analysis (EMA/RSI/ATR/bias) for ALL pairs on H4+M15.
 * NO signal generation — the AI agent analyzes and decides.
 *
 * Usage:
 *   npx tsx src/trading/forex/snapshot.ts
 *   npx tsx src/trading/forex/snapshot.ts --pair=EURUSD
 */

import { getArg } from '../../utils/args.js';
import { runMain } from '../../utils/process.js';
import type { AccountInfo, MarketAnalysis } from '../shared/types.js';
import {
  disconnect,
  getBalance,
  getMarketAnalysis,
  getPositions,
  type PositionWithId,
} from './client.js';
import config from './config.js';

interface PairSnapshot {
  pair: string;
  trend: MarketAnalysis | null; // H4 — trend direction
  entry: MarketAnalysis | null; // M15 — entry timeframe
}

interface ForexSnapshot {
  timestamp: string;
  type: 'forex_snapshot';
  account: AccountInfo;
  positions: PositionWithId[];
  positionsCount: number;
  totalProfit: number;
  drawdownPct: number;
  tradingAllowed: boolean;
  alerts: string[];
  pairs: PairSnapshot[];
  config: {
    maxRiskPerTradePct: number;
    maxOpenPositions: number;
    maxDailyDrawdownPct: number;
    maxTotalDrawdownPct: number;
    minRR: number;
    defaultLeverage: number;
    mode: string;
  };
}

async function collectPairData(pair: string): Promise<PairSnapshot> {
  const [trend, entry] = await Promise.all([
    getMarketAnalysis(pair, config.trendTimeframe, 100).catch(() => null),
    getMarketAnalysis(pair, config.entryTimeframe, 100).catch(() => null),
  ]);

  return { pair, trend, entry };
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

  const totalProfit = positions.reduce((sum, p) => sum + parseFloat(p.unrealisedPnl || '0'), 0);
  const drawdownPct =
    account.totalEquity < account.totalWalletBalance
      ? ((account.totalWalletBalance - account.totalEquity) / account.totalWalletBalance) * 100
      : 0;

  const alerts: string[] = [];
  if (drawdownPct >= config.maxDailyDrawdownPct) {
    alerts.push(
      `CRITICAL: Drawdown ${drawdownPct.toFixed(1)}% >= limit ${config.maxDailyDrawdownPct}%`,
    );
  } else if (drawdownPct >= config.maxDailyDrawdownPct * 0.75) {
    alerts.push(`WARNING: Drawdown ${drawdownPct.toFixed(1)}% approaching limit`);
  }

  for (const pos of positions) {
    if (!pos.stopLoss || parseFloat(pos.stopLoss) === 0) {
      alerts.push(`CRITICAL: No SL on ${pos.symbol} ${pos.side}`);
    }
  }

  const snapshot: ForexSnapshot = {
    timestamp: new Date().toISOString(),
    type: 'forex_snapshot',
    account,
    positions,
    positionsCount: positions.length,
    totalProfit: Math.round(totalProfit * 100) / 100,
    drawdownPct: Math.round(drawdownPct * 100) / 100,
    tradingAllowed: drawdownPct < config.maxDailyDrawdownPct,
    alerts,
    pairs: pairSnapshots,
    config: {
      maxRiskPerTradePct: config.maxRiskPerTradePct,
      maxOpenPositions: config.maxOpenPositions,
      maxDailyDrawdownPct: config.maxDailyDrawdownPct,
      maxTotalDrawdownPct: config.maxTotalDrawdownPct,
      minRR: config.minRR,
      defaultLeverage: config.defaultLeverage,
      mode: config.mode,
    },
  };

  console.log(JSON.stringify(snapshot, null, 2));
}

runMain(async () => {
  try {
    await main();
  } finally {
    disconnect();
  }
});
