import { getArg, hasFlag } from '../../utils/args.js';
import { createLogger } from '../../utils/logger.js';
import { runMain } from '../../utils/process.js';
import { calculateConfluenceScore, type ConfluenceInput } from '../shared/confluence.js';
// levels используются в snapshot-v2, здесь пока не нужны

import { detectMarketRegime, getRegimeThreshold } from '../shared/regime.js';
import type { ConfluenceScore } from '../shared/types.js';
import { buildVolumeProfile } from '../shared/volume-analysis.js';
import {
  getBalance,
  getFundingHistory,
  getKlines,
  getMarketAnalysis,
  getMarketInfo,
  getOIHistory,
  getOpenOrders,
  getOrderbook,
  getPositions,
  getRecentTrades,
  modifyPosition,
  partialClosePosition,
  setLeverage,
  submitOrder,
} from './bybit-client.js';
import config from './config.js';
import * as state from './state.js';

const log = createLogger('crypto-monitor');

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
  confluence: ConfluenceScore;
  regime: string;
  confidence: number;
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

// Дефолтный SL: 1.5 * ATR от цены входа (fallback — 2% от entry)
function calcDefaultSl(entry: number, side: string, atrEstimate?: number): number {
  const slDist = atrEstimate ? atrEstimate * 1.5 : entry * 0.02;
  return side === 'long' ? entry - slDist : entry + slDist;
}

// Дефолтный TP: SL_distance * minRR от entry
function calcDefaultTp(entry: number, sl: number, side: string): number {
  const slDist = Math.abs(entry - sl);
  return side === 'long' ? entry + slDist * config.minRR : entry - slDist * config.minRR;
}

async function managePositions(): Promise<Array<Record<string, unknown>>> {
  const s = state.get();
  const actions: Array<Record<string, unknown>> = [];

  for (const pos of s.positions) {
    const uPnl = parseFloat(pos.unrealisedPnl) || 0;
    const entry = parseFloat(pos.entryPrice) || 0;
    const sl = parseFloat(pos.stopLoss ?? '0') || 0;
    const tp = parseFloat(pos.takeProfit ?? '0') || 0;
    const size = parseFloat(pos.size) || 0;

    if (entry === 0 || size === 0) continue;

    const slDistance = Math.abs(entry - sl);

    // SL-Guard: позиция без стоп-лосса — установить дефолтный SL/TP
    if (slDistance === 0) {
      const defaultSl = roundPrice(calcDefaultSl(entry, pos.side), pos.symbol);
      const defaultTp =
        tp === 0 ? roundPrice(calcDefaultTp(entry, defaultSl, pos.side), pos.symbol) : undefined;

      if (!DRY_RUN) {
        try {
          await modifyPosition(
            pos.symbol,
            String(defaultSl),
            defaultTp ? String(defaultTp) : undefined,
          );
          actions.push({
            type: 'sl_guard_applied',
            symbol: pos.symbol,
            defaultSl,
            defaultTp: defaultTp ?? 'unchanged',
            result: 'OK',
          });
          state.logEvent('sl_guard', {
            symbol: pos.symbol,
            entry,
            defaultSl,
            defaultTp,
            reason: 'Position found without SL — default SL/TP applied',
          });
          log.warn('SL-Guard: applied default SL/TP', { symbol: pos.symbol, defaultSl, defaultTp });
        } catch (err) {
          actions.push({
            type: 'sl_guard_failed',
            symbol: pos.symbol,
            result: `ERROR: ${(err as Error).message}`,
          });
          state.logEvent('api_error', {
            type: 'sl_guard_failed',
            symbol: pos.symbol,
            entry,
            error: (err as Error).message,
          });
          log.error('SL-Guard: failed to apply default SL/TP', {
            symbol: pos.symbol,
            error: (err as Error).message,
          });
        }
      } else {
        actions.push({
          type: 'sl_guard_applied',
          symbol: pos.symbol,
          defaultSl,
          defaultTp: defaultTp ?? 'unchanged',
          result: 'DRY_RUN',
        });
      }
      continue; // Пропускаем trailing/partial для этой позиции до следующего цикла
    }

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
        if (pos.side === 'long') {
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
          if (newSl < sl) {
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

  // Анализируем все пары параллельно
  const results = await Promise.all(
    pairs.map(async (pair) => {
      try {
        return await analyzePairV2(pair);
      } catch (err) {
        state.logEvent('analysis_error', { pair, error: (err as Error).message });
        return null;
      }
    }),
  );

  for (const signal of results) {
    if (signal) signals.push(signal);
  }

  // Сортируем по силе confluence score (лучшие сигналы первыми)
  signals.sort((a, b) => Math.abs(b.confluence.total) - Math.abs(a.confluence.total));

  return signals;
}

async function analyzePairV2(pair: string): Promise<TradeSignalInternal | null> {
  // Собираем все данные параллельно (как в snapshot-v2)
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

  if (!m15 || !market || !orderbook) return null;

  // Volume profile from M15 candles + recent trades
  const volumeProfile = m15Candles.length > 0 ? buildVolumeProfile(m15Candles, recentTrades) : null;
  if (!volumeProfile) return null;

  // Market regime from H4 candles
  const regime = h4Candles.length >= 50 ? detectMarketRegime(h4Candles) : 'RANGING';

  // Confluence scoring
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
  const confluence = calculateConfluenceScore(input);

  // Проверяем минимальный порог для режима рынка
  const threshold = getRegimeThreshold(regime);
  const absScore = Math.abs(confluence.total);

  if (absScore < threshold) return null; // Сигнал слишком слабый для текущего режима

  // Определяем сторону сделки
  const side: 'Buy' | 'Sell' = confluence.total > 0 ? 'Buy' : 'Sell';
  const atr = m15.indicators.atr14;
  const price = market.lastPrice;

  if (atr === 0 || price === 0) return null;

  // Entry: Limit ордер (bid1 для Buy, ask1 для Sell)
  const entry =
    side === 'Buy' ? (orderbook.bids[0]?.price ?? price) : (orderbook.asks[0]?.price ?? price);

  // SL: 1.5 * ATR от entry
  const slDistance = atr * 1.5;
  const sl = side === 'Buy' ? entry - slDistance : entry + slDistance;

  // TP: используем minRR из конфига
  const tp = side === 'Buy' ? entry + slDistance * config.minRR : entry - slDistance * config.minRR;

  const rr = config.minRR;

  return {
    pair,
    side,
    entryPrice: roundPrice(entry, pair),
    sl: roundPrice(sl, pair),
    tp: roundPrice(tp, pair),
    rr,
    reason: `${confluence.signal} score=${confluence.total} confidence=${confluence.confidence}% regime=${regime} [${confluence.details.slice(0, 3).join('; ')}]`,
    confluence,
    regime,
    confidence: confluence.confidence,
  };
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
  const openOrderSymbols = await getOpenOrders();

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

    if (openOrderSymbols.includes(sig.pair)) {
      results.push({ ...sig, action: 'SKIP: pending order already exists' });
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

      // Используем Limit ордер вместо Market для лучшего исполнения
      const orderRes = await submitOrder({
        symbol: sig.pair,
        side: sig.side,
        orderType: 'Limit',
        qty: qtyStr,
        price: String(sig.entryPrice),
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
        orderType: 'Limit',
        confluenceScore: sig.confluence.total,
        confluenceSignal: sig.confluence.signal,
        confidence: sig.confidence,
        regime: sig.regime,
        reason: sig.reason,
        orderId: orderRes.orderId,
      });

      results.push({ ...sig, action: 'EXECUTED', orderId: orderRes.orderId, qty: qtyStr });
    } catch (err) {
      const errMsg = (err as Error).message;
      results.push({ ...sig, action: `ERROR: ${errMsg}` });
      state.logEvent('api_error', {
        type: 'submit_order_failed',
        symbol: sig.pair,
        side: sig.side,
        entry: sig.entryPrice,
        sl: sig.sl,
        tp: sig.tp,
        error: errMsg,
      });
      log.error('Failed to submit order', { symbol: sig.pair, error: errMsg });
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
    topSignals: signals.slice(0, 3).map((s) => ({
      pair: s.pair,
      score: s.confluence.total,
      signal: s.confluence.signal,
      regime: s.regime,
    })),
  });

  console.log(JSON.stringify(report, null, 2));
}

runMain(main, () => state.save());
