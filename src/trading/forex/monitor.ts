/**
 * Forex Monitor — мониторинг позиций и рисков (FTMO-совместимый).
 *
 * Функционал:
 *   1. Проверка дродауна (дневной + общий)
 *   2. Обновление позиций
 *   3. Проверка рисков (SL, позиция без SL, перегрузка)
 *   4. Управление открытыми (partial close, trailing)
 *   5. Анализ рынка + вход (если mode=execute)
 *
 * Использование:
 *   tsx src/trading/forex/monitor.ts --heartbeat
 *   tsx src/trading/forex/monitor.ts --positions
 *   tsx src/trading/forex/monitor.ts --risk-check
 *   tsx src/trading/forex/monitor.ts --trade --dry-run
 *   tsx src/trading/forex/monitor.ts --trade --pair=EURUSD
 *
 * Мигрировано из scripts/mt5_monitor.py
 */

import { createLogger } from '../../utils/logger.js';
import type { AccountInfo, Position } from '../shared/types.js';
import {
  closePosition,
  disconnect,
  getBalance,
  getMarketAnalysis,
  getPositions,
  modifyPosition,
  submitOrder,
} from './client.js';
import config from './config.js';

const log = createLogger('forex-monitor');

// ─── CLI ──────────────────────────────────────────────────────

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

const DRY_RUN = hasFlag('dry-run') || config.mode !== 'execute';

// ─── Типы ─────────────────────────────────────────────────────

interface RiskAlert {
  level: 'CRITICAL' | 'WARNING' | 'INFO';
  message: string;
  details?: Record<string, unknown>;
}

interface HeartbeatReport {
  timestamp: string;
  account: AccountInfo;
  positions: Position[];
  positionsCount: number;
  totalProfit: number;
  drawdownPct: number;
  alerts: RiskAlert[];
  riskStatus: 'OK' | 'WARNING' | 'CRITICAL';
  tradingAllowed: boolean;
}

// ─── Risk checks ─────────────────────────────────────────────

function checkPositionRisks(positions: Position[], balance: number): RiskAlert[] {
  const alerts: RiskAlert[] = [];

  for (const pos of positions) {
    const sl = parseFloat(pos.stopLoss ?? '0');
    const entry = parseFloat(pos.entryPrice);
    const size = parseFloat(pos.size); // lots

    // Позиция без SL — критично
    if (sl === 0) {
      alerts.push({
        level: 'CRITICAL',
        message: `⚠️ ПОЗИЦИЯ БЕЗ STOP LOSS! ${pos.symbol} ${pos.side} ${size} lots`,
        details: {
          symbol: pos.symbol,
          positionId: (pos as unknown as Record<string, unknown>).positionId,
        },
      });
    }

    // Риск > maxRiskPerTradePct
    if (sl > 0 && entry > 0 && balance > 0) {
      const pipDiff = Math.abs(entry - sl);
      // Упрощённый расчёт: ~$10/pip per lot для мажоров
      const riskUsd = pipDiff * 10000 * size * 10;
      const riskPct = (riskUsd / balance) * 100;

      if (riskPct > config.maxRiskPerTradePct) {
        alerts.push({
          level: 'WARNING',
          message: `⚠️ Риск ${riskPct.toFixed(1)}% > ${config.maxRiskPerTradePct}% | ${pos.symbol}`,
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
      message: `🚨 ДРОДАУН ${drawdownPct.toFixed(1)}% ДОСТИГ ЛИМИТА ${config.maxDailyDrawdownPct}%! СТОП!`,
      details: { drawdownPct: drawdownPct.toFixed(2), limit: config.maxDailyDrawdownPct },
    });
  } else if (drawdownPct >= config.maxDailyDrawdownPct * 0.75) {
    alerts.push({
      level: 'WARNING',
      message: `⚠️ Дродаун ${drawdownPct.toFixed(1)}% приближается к лимиту ${config.maxDailyDrawdownPct}%`,
      details: { drawdownPct: drawdownPct.toFixed(2) },
    });
  }

  return alerts;
}

// ─── Heartbeat ───────────────────────────────────────────────

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

// ─── Trading logic ───────────────────────────────────────────

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

  // LONG
  if (trendBias === 'BULLISH' && priceVsEma === 'ABOVE' && rsi15m < 40) {
    const slPips = Math.max(Math.round(atr15m * 10000 * 1.5), 20);
    const tpPips = slPips * config.minRR;

    return {
      pair,
      side: 'Buy',
      lots: 0.01, // будет пересчитано через equity % risk
      slPips,
      tpPips,
      rr: config.minRR,
      reason: `BULLISH 4h + RSI15m=${rsi15m.toFixed(1)} перепродан`,
    };
  }

  // SHORT
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
      reason: `BEARISH 4h + RSI15m=${rsi15m.toFixed(1)} перекуплен`,
    };
  }

  return null;
}

async function executeTrades(): Promise<void> {
  const pairs = getArg('pair') ? [getArg('pair')!.toUpperCase()] : config.pairs;

  const account = await getBalance();
  const positions = await getPositions();

  if (positions.length >= config.maxOpenPositions) {
    log.info(`Макс позиций (${config.maxOpenPositions}). Пропуск.`);
    return;
  }

  // Check drawdown
  const ddAlerts = checkDrawdown(account);
  if (ddAlerts.some((a) => a.level === 'CRITICAL')) {
    log.warn('Дродаун критический — торговля заблокирована');
    return;
  }

  const signals: TradeSignal[] = [];
  for (const pair of pairs) {
    // Skip if already have position
    if (positions.some((p) => p.symbol === pair)) continue;
    try {
      const sig = await analyzeForTrade(pair);
      if (sig) signals.push(sig);
    } catch (err) {
      log.warn(`Ошибка анализа ${pair}: ${(err as Error).message}`);
    }
  }

  log.info(`Сигналов: ${signals.length}`);

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
      log.info(`Ордер открыт: ${result.orderId} ${sig.pair} ${sig.side}`);
    } catch (err) {
      log.error(`Ошибка ордера ${sig.pair}: ${(err as Error).message}`);
    }
  }
}

// ─── Manage positions ────────────────────────────────────────

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

    // Simplified 1R calc for forex ($ per pip × lots)
    const oneR = slDistance * 10000 * size * 10;
    if (oneR === 0) continue;

    const currentR = uPnl / oneR;
    const positionId = parseInt(
      (pos as unknown as Record<string, unknown>).positionId as string,
      10,
    );
    if (isNaN(positionId)) continue;

    // Partial close at +1R
    if (currentR >= config.partialCloseAtR && !DRY_RUN) {
      const partialLots = size * config.partialClosePercent;
      if (partialLots >= 0.01) {
        try {
          await closePosition(positionId, partialLots);
          await modifyPosition(positionId, { sl: { pips: 0 } }); // breakeven
          log.info(`Partial close ${pos.symbol} ${partialLots} lots at ${currentR.toFixed(1)}R`);
        } catch (err) {
          log.warn(`Ошибка partial close ${pos.symbol}: ${(err as Error).message}`);
        }
      }
    }

    // Trailing stop at +1.5R
    if (currentR >= config.trailingStartR && !DRY_RUN) {
      try {
        const trailPips = Math.round(slDistance * config.trailingDistanceR * 10000);
        await modifyPosition(positionId, { sl: { pips: trailPips } });
        log.info(`Trailing SL ${pos.symbol} to ${trailPips} pips at ${currentR.toFixed(1)}R`);
      } catch (err) {
        log.warn(`Ошибка trailing ${pos.symbol}: ${(err as Error).message}`);
      }
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────

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
      // По умолчанию — heartbeat
      const report = await heartbeat();
      console.log(JSON.stringify(report, null, 2));
    }
  } finally {
    await disconnect();
  }
}

main().catch((err) => {
  log.error(`Критическая ошибка: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
