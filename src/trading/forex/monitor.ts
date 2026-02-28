import { createLogger } from '../../utils/logger.js';
import type { AccountInfo } from '../shared/types.js';
import {
  closePosition,
  disconnect,
  getBalance,
  getMarketAnalysis,
  getPositions,
  modifyPosition,
  submitOrder,
  type PositionWithId,
} from './client.js';
import config from './config.js';

const log = createLogger('forex-monitor');

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((a: string) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

const DRY_RUN = hasFlag('dry-run') || config.mode !== 'execute';

interface RiskAlert {
  level: 'CRITICAL' | 'WARNING' | 'INFO';
  message: string;
  details?: Record<string, unknown>;
}

interface HeartbeatReport {
  timestamp: string;
  account: AccountInfo;
  positions: PositionWithId[];
  positionsCount: number;
  totalProfit: number;
  drawdownPct: number;
  alerts: RiskAlert[];
  riskStatus: 'OK' | 'WARNING' | 'CRITICAL';
  tradingAllowed: boolean;
}

function checkPositionRisks(positions: PositionWithId[], balance: number): RiskAlert[] {
  const alerts: RiskAlert[] = [];

  for (const pos of positions) {
    const sl = parseFloat(pos.stopLoss ?? '0');
    const entry = parseFloat(pos.entryPrice);
    const size = parseFloat(pos.size);

    if (sl === 0) {
      alerts.push({
        level: 'CRITICAL',
        message: `NO STOP LOSS: ${pos.symbol} ${pos.side} ${size} lots`,
        details: { symbol: pos.symbol, positionId: pos.positionId },
      });
    }

    if (sl > 0 && entry > 0 && balance > 0) {
      const pipDiff = Math.abs(entry - sl);
      const riskUsd = pipDiff * 10000 * size * 10;
      const riskPct = (riskUsd / balance) * 100;

      if (riskPct > config.maxRiskPerTradePct) {
        alerts.push({
          level: 'WARNING',
          message: `Risk ${riskPct.toFixed(1)}% > ${config.maxRiskPerTradePct}% | ${pos.symbol}`,
          details: { symbol: pos.symbol, riskPct: riskPct.toFixed(2) },
        });
      }
    }
  }

  return alerts;
}

function checkDrawdown(account: AccountInfo): RiskAlert[] {
  const alerts: RiskAlert[] = [];
  const { totalWalletBalance: balance, totalEquity: equity } = account;
  if (balance === 0) return alerts;

  const drawdownPct = equity < balance ? ((balance - equity) / balance) * 100 : 0;

  if (drawdownPct >= config.maxDailyDrawdownPct) {
    alerts.push({
      level: 'CRITICAL',
      message: `DRAWDOWN ${drawdownPct.toFixed(1)}% HIT LIMIT ${config.maxDailyDrawdownPct}%! STOP!`,
      details: { drawdownPct: drawdownPct.toFixed(2), limit: config.maxDailyDrawdownPct },
    });
  } else if (drawdownPct >= config.maxDailyDrawdownPct * 0.75) {
    alerts.push({
      level: 'WARNING',
      message: `Drawdown ${drawdownPct.toFixed(1)}% approaching limit ${config.maxDailyDrawdownPct}%`,
      details: { drawdownPct: drawdownPct.toFixed(2) },
    });
  }

  return alerts;
}

async function heartbeat(): Promise<HeartbeatReport> {
  const account = await getBalance();
  const positions = await getPositions();

  const totalProfit = positions.reduce((sum, p) => sum + parseFloat(p.unrealisedPnl), 0);
  const drawdownPct =
    account.totalEquity < account.totalWalletBalance
      ? ((account.totalWalletBalance - account.totalEquity) / account.totalWalletBalance) * 100
      : 0;

  const posAlerts = checkPositionRisks(positions, account.totalWalletBalance);
  const ddAlerts = checkDrawdown(account);
  const allAlerts = [...posAlerts, ...ddAlerts];

  const riskStatus = allAlerts.some((a) => a.level === 'CRITICAL')
    ? 'CRITICAL'
    : allAlerts.some((a) => a.level === 'WARNING')
      ? 'WARNING'
      : 'OK';

  return {
    timestamp: new Date().toISOString(),
    account,
    positions,
    positionsCount: positions.length,
    totalProfit: Math.round(totalProfit * 100) / 100,
    drawdownPct: Math.round(drawdownPct * 100) / 100,
    alerts: allAlerts,
    riskStatus,
    tradingAllowed: drawdownPct < config.maxDailyDrawdownPct,
  };
}

interface TradeSignal {
  pair: string;
  side: 'Buy' | 'Sell';
  lots: number;
  slPips: number;
  tpPips: number;
  rr: number;
  reason: string;
}

async function analyzeForTrade(pair: string): Promise<TradeSignal | null> {
  const [h4, m15] = await Promise.all([
    getMarketAnalysis(pair, 'H4', 100),
    getMarketAnalysis(pair, 'M15', 100),
  ]);

  if (!h4 || !m15) return null;

  const trendBias = h4.bias.emaTrend;
  const priceVsEma = h4.bias.priceVsEma200;
  const rsi15m = m15.indicators.rsi14;
  const atr15m = m15.indicators.atr14;

  if (trendBias === 'UNKNOWN') return null;

  if (trendBias === 'BULLISH' && priceVsEma === 'ABOVE' && rsi15m < 40) {
    const slPips = Math.max(Math.round(atr15m * 10000 * 1.5), 20);
    const tpPips = slPips * config.minRR;

    return {
      pair,
      side: 'Buy',
      lots: 0.01,
      slPips,
      tpPips,
      rr: config.minRR,
      reason: `BULLISH H4 + RSI15m=${rsi15m.toFixed(1)} oversold`,
    };
  }

  if (trendBias === 'BEARISH' && priceVsEma === 'BELOW' && rsi15m > 60) {
    const slPips = Math.max(Math.round(atr15m * 10000 * 1.5), 20);
    const tpPips = slPips * config.minRR;

    return {
      pair,
      side: 'Sell',
      lots: 0.01,
      slPips,
      tpPips,
      rr: config.minRR,
      reason: `BEARISH H4 + RSI15m=${rsi15m.toFixed(1)} overbought`,
    };
  }

  return null;
}

async function executeTrades(): Promise<void> {
  const pairs = getArg('pair') ? [getArg('pair')!.toUpperCase()] : config.pairs;
  const account = await getBalance();
  const positions = await getPositions();

  if (positions.length >= config.maxOpenPositions) {
    log.info(`Max positions reached (${config.maxOpenPositions}). Skipping.`);
    return;
  }

  const ddAlerts = checkDrawdown(account);
  if (ddAlerts.some((a) => a.level === 'CRITICAL')) {
    log.warn('Critical drawdown — trading blocked');
    return;
  }

  const signals: TradeSignal[] = [];

  for (const pair of pairs) {
    if (positions.some((p) => p.symbol === pair)) continue;

    try {
      const sig = await analyzeForTrade(pair);
      if (sig) signals.push(sig);
    } catch (err) {
      log.warn(`Analysis error ${pair}: ${(err as Error).message}`);
    }
  }

  log.info(`Signals: ${signals.length}`);

  for (const sig of signals) {
    if (DRY_RUN) {
      console.log(
        `[DRY-RUN] ${sig.side} ${sig.pair} | SL=${sig.slPips}p TP=${sig.tpPips}p | ${sig.reason}`,
      );
      continue;
    }

    try {
      const result = await submitOrder({
        symbol: sig.pair,
        side: sig.side,
        lots: sig.lots,
        sl: { pips: sig.slPips },
        tp: { pips: sig.tpPips },
      });
      log.info(`Order opened: ${result.orderId} ${sig.pair} ${sig.side}`);
    } catch (err) {
      log.error(`Order error ${sig.pair}: ${(err as Error).message}`);
    }
  }
}

async function manageOpenPositions(): Promise<void> {
  const positions = await getPositions();

  for (const pos of positions) {
    const uPnl = parseFloat(pos.unrealisedPnl);
    const entry = parseFloat(pos.entryPrice);
    const sl = parseFloat(pos.stopLoss ?? '0');
    const size = parseFloat(pos.size);

    if (entry === 0 || size === 0 || sl === 0) continue;

    const slDistance = Math.abs(entry - sl);
    if (slDistance === 0) continue;

    const oneR = slDistance * 10000 * size * 10;
    if (oneR === 0) continue;

    const currentR = uPnl / oneR;
    const positionId = pos.positionId;
    if (!positionId) continue;

    if (currentR >= config.partialCloseAtR && !DRY_RUN) {
      const partialLots = size * config.partialClosePercent;
      if (partialLots >= 0.01) {
        try {
          await closePosition(positionId, partialLots);
          await modifyPosition(positionId, { sl: { pips: 0 } });
          log.info(`Partial close ${pos.symbol} ${partialLots} lots at ${currentR.toFixed(1)}R`);
        } catch (err) {
          log.warn(`Partial close error ${pos.symbol}: ${(err as Error).message}`);
        }
      }
    }

    if (currentR >= config.trailingStartR && !DRY_RUN) {
      try {
        const trailPips = Math.round(slDistance * config.trailingDistanceR * 10000);
        await modifyPosition(positionId, { sl: { pips: trailPips } });
        log.info(`Trailing SL ${pos.symbol} to ${trailPips} pips at ${currentR.toFixed(1)}R`);
      } catch (err) {
        log.warn(`Trailing error ${pos.symbol}: ${(err as Error).message}`);
      }
    }
  }
}

async function main(): Promise<void> {
  try {
    if (hasFlag('heartbeat')) {
      const report = await heartbeat();
      console.log(JSON.stringify(report, null, 2));
    } else if (hasFlag('positions')) {
      const positions = await getPositions();
      console.log(JSON.stringify({ positions, count: positions.length }, null, 2));
    } else if (hasFlag('account')) {
      const account = await getBalance();
      console.log(JSON.stringify(account, null, 2));
    } else if (hasFlag('risk-check')) {
      const report = await heartbeat();
      console.log(
        JSON.stringify(
          {
            alerts: report.alerts,
            riskStatus: report.riskStatus,
            tradingAllowed: report.tradingAllowed,
            drawdownPct: report.drawdownPct,
          },
          null,
          2,
        ),
      );
    } else if (hasFlag('trade')) {
      await manageOpenPositions();
      await executeTrades();
    } else {
      const report = await heartbeat();
      console.log(JSON.stringify(report, null, 2));
    }
  } finally {
    disconnect();
  }
}

main().catch((err) => {
  log.error(`Critical error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
