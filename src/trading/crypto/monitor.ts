import { createLogger } from '../../utils/logger.js';
import {
  getBalance,
  getMarketAnalysis,
  getMarketInfo,
  getPositions,
  modifyPosition,
  partialClosePosition,
  setLeverage,
  submitOrder,
} from './bybit-client.js';
import config from './config.js';
import * as state from './state.js';

const log = createLogger('crypto-monitor');

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((a: string) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const DRY_RUN = hasFlag('dry-run') || config.mode !== 'execute';
const SINGLE_PAIR = getArg('pair');

interface TradeSignalInternal {
  pair: string;
  side: 'Buy' | 'Sell';
  entryPrice: number;
  sl: number;
  tp: number;
  rr: number;
  reason: string;
  funding: number;
  atr: number;
  trendBias: string;
  rsi4h: number;
  rsi15m: number;
}

interface SignalResult extends TradeSignalInternal {
  action: string;
  orderId?: string;
  qty?: string;
}

function checkStatus(): { ok: boolean; reason: string } {
  state.load();

  if (state.isKillSwitchActive()) {
    return { ok: false, reason: 'KILL_SWITCH active' };
  }

  const s = state.get();
  if (s.daily.stopDay) {
    return { ok: false, reason: `STOP_DAY: ${s.daily.stopDayReason}` };
  }

  return { ok: true, reason: 'OK' };
}

async function refreshAccount(): Promise<void> {
  try {
    const balance = await getBalance();
    state.updateBalance({
      totalEquity: String(balance.totalEquity),
      totalWalletBalance: String(balance.totalWalletBalance),
      totalAvailableBalance: String(balance.availableBalance),
      totalPerpUPL: String(balance.unrealisedPnl),
    });
  } catch (err) {
    log.warn('Failed to get balance', { error: (err as Error).message });
  }

  try {
    const positions = await getPositions();
    state.updatePositions(
      positions.map((p) => ({
        symbol: p.symbol,
        side: p.side,
        size: p.size,
        entryPrice: p.entryPrice,
        markPrice: p.markPrice,
        unrealisedPnl: p.unrealisedPnl,
        leverage: p.leverage,
        stopLoss: p.stopLoss,
        takeProfit: p.takeProfit,
      })),
    );
  } catch (err) {
    log.warn('Failed to get positions', { error: (err as Error).message });
  }
}

async function managePositions(): Promise<Array<Record<string, unknown>>> {
  const s = state.get();
  const actions: Array<Record<string, unknown>> = [];

  for (const pos of s.positions) {
    const uPnl = parseFloat(pos.unrealisedPnl) || 0;
    const entry = parseFloat(pos.entryPrice) || 0;
    const sl = parseFloat(pos.stopLoss ?? '0') || 0;
    const size = parseFloat(pos.size) || 0;

    if (entry === 0 || size === 0) continue;

    const slDistance = Math.abs(entry - sl);
    if (slDistance === 0) continue;

    const oneR = slDistance * size;
    const currentR = uPnl / oneR;

    if (currentR >= config.partialCloseAtR && !DRY_RUN) {
      const partialQty = (size * config.partialClosePercent).toFixed(getQtyPrecision(pos.symbol));
      if (parseFloat(partialQty) > 0) {
        try {
          await partialClosePosition(pos.symbol, partialQty);
          actions.push({
            type: 'partial_close',
            symbol: pos.symbol,
            qty: partialQty,
            atR: currentR.toFixed(2),
            result: 'OK',
          });

          await modifyPosition(pos.symbol, String(entry));
          actions.push({
            type: 'sl_breakeven',
            symbol: pos.symbol,
            newSl: entry,
            result: 'OK',
          });

          state.logEvent('partial_close', {
            symbol: pos.symbol,
            qty: partialQty,
            pnlAtClose: uPnl,
            rMultiple: currentR.toFixed(2),
          });
        } catch (err) {
          actions.push({
            type: 'partial_close',
            symbol: pos.symbol,
            result: `ERROR: ${(err as Error).message}`,
          });
        }
      }
    }

    if (currentR >= config.trailingStartR && !DRY_RUN) {
      const mark = parseFloat(pos.markPrice) || 0;
      const trailingDistance = slDistance * config.trailingDistanceR;

      try {
        if (pos.side === 'Buy' || pos.side === 'long') {
          const newSl = mark - trailingDistance;
          if (newSl > sl) {
            await modifyPosition(pos.symbol, newSl.toFixed(2));
            actions.push({
              type: 'trailing_sl',
              symbol: pos.symbol,
              oldSl: sl,
              newSl: newSl.toFixed(2),
              result: 'OK',
            });
          }
        } else {
          const newSl = mark + trailingDistance;
          if (newSl < sl || sl === 0) {
            await modifyPosition(pos.symbol, newSl.toFixed(2));
            actions.push({
              type: 'trailing_sl',
              symbol: pos.symbol,
              oldSl: sl,
              newSl: newSl.toFixed(2),
              result: 'OK',
            });
          }
        }
      } catch (err) {
        actions.push({
          type: 'trailing_sl',
          symbol: pos.symbol,
          result: `ERROR: ${(err as Error).message}`,
        });
      }
    }
  }

  return actions;
}

async function analyzeMarket(): Promise<TradeSignalInternal[]> {
  const pairs = SINGLE_PAIR ? [SINGLE_PAIR.toUpperCase()] : config.pairs;
  const signals: TradeSignalInternal[] = [];

  for (const pair of pairs) {
    try {
      const signal = await analyzePair(pair);
      if (signal) signals.push(signal);
    } catch (err) {
      state.logEvent('analysis_error', { pair, error: (err as Error).message });
    }
  }

  return signals;
}

async function analyzePair(pair: string): Promise<TradeSignalInternal | null> {
  const [h4, m15, mkt] = await Promise.all([
    getMarketAnalysis(pair, '240', 100),
    getMarketAnalysis(pair, '15', 100),
    getMarketInfo(pair),
  ]);

  if (!h4 || !m15) return null;

  const trendBias = h4.bias.emaTrend;
  const priceVsEma = h4.bias.priceVsEma200;
  const rsi4h = h4.indicators.rsi14;
  const rsi15m = m15.indicators.rsi14;
  const atr15m = m15.indicators.atr14;
  const currentPrice = m15.currentPrice;
  const fundingRate = mkt?.fundingRate ?? 0;

  if (trendBias === 'UNKNOWN') return null;

  if (trendBias === 'BULLISH' && fundingRate > config.maxFundingRate) return null;
  if (trendBias === 'BEARISH' && fundingRate < config.minFundingRate) return null;

  if (trendBias === 'BULLISH' && priceVsEma === 'ABOVE') {
    const support = m15.levels.support;
    const distToSupport = support > 0 ? ((currentPrice - support) / currentPrice) * 100 : 999;

    if (rsi15m < 40 || distToSupport < 1.5) {
      const sl = support > 0 ? support - atr15m : currentPrice * 0.98;
      const slDist = currentPrice - sl;
      const tp = currentPrice + slDist * config.minRR;

      return {
        pair,
        side: 'Buy',
        entryPrice: currentPrice,
        sl: roundPrice(sl, pair),
        tp: roundPrice(tp, pair),
        rr: config.minRR,
        reason: `BULLISH trend H4 + RSI15m=${rsi15m.toFixed(1)} + support ${support}`,
        funding: fundingRate,
        atr: atr15m,
        trendBias,
        rsi4h,
        rsi15m,
      };
    }
  }

  if (trendBias === 'BEARISH' && priceVsEma === 'BELOW') {
    const resistance = m15.levels.resistance;
    const distToResistance =
      resistance > 0 ? ((resistance - currentPrice) / currentPrice) * 100 : 999;

    if (rsi15m > 60 || distToResistance < 1.5) {
      const sl = resistance > 0 ? resistance + atr15m : currentPrice * 1.02;
      const slDist = sl - currentPrice;
      const tp = currentPrice - slDist * config.minRR;

      return {
        pair,
        side: 'Sell',
        entryPrice: currentPrice,
        sl: roundPrice(sl, pair),
        tp: roundPrice(tp, pair),
        rr: config.minRR,
        reason: `BEARISH trend H4 + RSI15m=${rsi15m.toFixed(1)} + resistance ${resistance}`,
        funding: fundingRate,
        atr: atr15m,
        trendBias,
        rsi4h,
        rsi15m,
      };
    }
  }

  return null;
}

async function executeSignals(signals: TradeSignalInternal[]): Promise<SignalResult[]> {
  if (DRY_RUN) {
    return signals.map((s) => ({ ...s, action: 'DRY_RUN (not executed)' }));
  }

  const tradePerm = state.canTrade();
  if (!tradePerm.allowed) {
    return signals.map((s) => ({ ...s, action: `BLOCKED: ${tradePerm.reason}` }));
  }

  const results: SignalResult[] = [];

  for (const sig of signals) {
    const perm = state.canTrade();
    if (!perm.allowed) {
      results.push({ ...sig, action: `BLOCKED: ${perm.reason}` });
      continue;
    }

    const s = state.get();
    const existing = s.positions.find((p) => p.symbol === sig.pair);
    if (existing) {
      results.push({ ...sig, action: 'SKIP: position already open' });
      continue;
    }

    const qty = state.calcPositionSize(sig.entryPrice, sig.sl);
    if (qty <= 0) {
      results.push({ ...sig, action: 'SKIP: failed to calculate qty' });
      continue;
    }

    const slDist = Math.abs(sig.entryPrice - sig.sl);
    const risk = slDist * qty;
    if (risk > config.maxRiskPerTrade) {
      results.push({
        ...sig,
        action: `SKIP: risk $${risk.toFixed(2)} > max $${config.maxRiskPerTrade}`,
      });
      continue;
    }

    try {
      await setLeverage(sig.pair, config.defaultLeverage);

      const qtyStr = formatQty(qty, sig.pair);
      const orderRes = await submitOrder({
        symbol: sig.pair,
        side: sig.side,
        orderType: 'Market',
        qty: qtyStr,
        stopLoss: String(sig.sl),
        takeProfit: String(sig.tp),
      });

      state.logEvent('order_opened', {
        symbol: sig.pair,
        side: sig.side,
        qty: qtyStr,
        entry: sig.entryPrice,
        sl: sig.sl,
        tp: sig.tp,
        reason: sig.reason,
        orderId: orderRes.orderId,
      });

      results.push({ ...sig, action: 'EXECUTED', orderId: orderRes.orderId, qty: qtyStr });
    } catch (err) {
      results.push({ ...sig, action: `ERROR: ${(err as Error).message}` });
    }
  }

  return results;
}

function getQtyPrecision(symbol: string): number {
  if (symbol.startsWith('BTC')) return 3;
  if (symbol.startsWith('ETH')) return 2;
  if (symbol.startsWith('SOL')) return 1;
  return 1;
}

function formatQty(qty: number, symbol: string): string {
  const prec = getQtyPrecision(symbol);
  const formatted = qty.toFixed(prec);
  const minQty = Math.pow(10, -prec);
  return parseFloat(formatted) < minQty ? minQty.toFixed(prec) : formatted;
}

function roundPrice(val: number, symbol: string): number {
  if (symbol.startsWith('BTC')) return parseFloat(val.toFixed(1));
  if (symbol.startsWith('ETH')) return parseFloat(val.toFixed(2));
  return parseFloat(val.toFixed(4));
}

async function main(): Promise<void> {
  const startTime = Date.now();
  const report: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    mode: DRY_RUN ? 'dry-run' : 'execute',
  };

  const status = checkStatus();
  report.status = status;
  if (!status.ok) {
    report.result = 'STOPPED';
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  await refreshAccount();
  report.balance = state.get().balance;
  report.openPositions = state.get().positions.length;

  const posActions = await managePositions();
  report.positionActions = posActions;

  const signals = await analyzeMarket();
  report.signals = signals;

  const execResults = await executeSignals(signals);
  report.execution = execResults;

  const s = state.get();
  s.lastMonitor = new Date().toISOString();
  state.save();

  report.daily = s.daily;
  report.elapsed = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
  report.result = 'OK';

  state.logEvent('monitor', {
    signals: signals.length,
    executed: execResults.filter((r) => r.action === 'EXECUTED').length,
    positions: s.positions.length,
    mode: DRY_RUN ? 'dry-run' : 'execute',
  });

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  log.error(`Critical error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
