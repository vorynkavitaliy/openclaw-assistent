import { getArg, hasFlag } from '../../utils/args.js';
import { createLogger } from '../../utils/logger.js';
import { runMain } from '../../utils/process.js';
import { calculateConfluenceScore, type ConfluenceInput } from '../shared/confluence.js';
// levels используются в snapshot-v2, здесь пока не нужны

import { detectMarketRegime, getRegimeThreshold } from '../shared/regime.js';
import type { ConfluenceScore } from '../shared/types.js';
import { buildVolumeProfile } from '../shared/volume-analysis.js';
import {
  cancelOrder,
  getBalance,
  getFundingHistory,
  getKlines,
  getMarketAnalysis,
  getMarketInfo,
  getOIHistory,
  getOpenOrders,
  getOpenOrdersFull,
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

  // Проверяем дневные лимиты с учётом unrealized P&L
  state.checkDayLimits();
}

// Дефолтный SL: ATR * atrSlMultiplier от цены входа (fallback — 2% от entry)
function calcDefaultSl(entry: number, side: string, atrEstimate?: number): number {
  const slDist = atrEstimate ? atrEstimate * config.atrSlMultiplier : entry * 0.02;
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

          // D4: После частичного закрытия — SL в безубыток + пересчёт TP на расширенную цель (3R)
          const extendedTp = roundPrice(
            pos.side === 'long'
              ? entry + slDistance * (config.minRR + 1)
              : entry - slDistance * (config.minRR + 1),
            pos.symbol,
          );
          await modifyPosition(pos.symbol, String(entry), String(extendedTp));
          actions.push({
            type: 'sl_breakeven_tp_extended',
            symbol: pos.symbol,
            newSl: entry,
            newTp: extendedTp,
            note: `TP extended to ${config.minRR + 1}R after partial close`,
            result: 'OK',
          });

          state.logEvent('partial_close', {
            symbol: pos.symbol,
            qty: partialQty,
            pnlAtClose: uPnl,
            rMultiple: currentR.toFixed(2),
            newTp: extendedTp,
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

// E4: Параллельный анализ с ограничением пропускной способности
// Каждая пара делает ~12 API запросов, Bybit лимит ~20 req/sec
// Запускаем не более CONCURRENCY пар одновременно
const ANALYSIS_CONCURRENCY = 3;

async function analyzeMarket(): Promise<TradeSignalInternal[]> {
  const pairs = SINGLE_PAIR ? [SINGLE_PAIR.toUpperCase()] : config.pairs;
  const signals: TradeSignalInternal[] = [];

  // E4: Батчи по ANALYSIS_CONCURRENCY пар
  for (let i = 0; i < pairs.length; i += ANALYSIS_CONCURRENCY) {
    const batch = pairs.slice(i, i + ANALYSIS_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (pair) => {
        try {
          return await analyzePairV2(pair);
        } catch (err) {
          state.logEvent('analysis_error', { pair, error: (err as Error).message });
          return null;
        }
      }),
    );
    for (const signal of batchResults) {
      if (signal) signals.push(signal);
    }
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

  // D1: Спред-фильтр — отклоняем вход при аномальном спреде
  const spreadPct = market.lastPrice > 0 ? (orderbook.spread / market.lastPrice) * 100 : 0;
  if (spreadPct > config.maxSpreadPercent) {
    log.debug('Spread filter: skip', {
      pair,
      spreadPct: spreadPct.toFixed(4),
      max: config.maxSpreadPercent,
    });
    return null;
  }

  // D2: Funding rate фильтр — не входим против перегретого рынка
  const fr = market.fundingRate;
  if (fr > config.maxFundingRate || fr < config.minFundingRate) {
    log.debug('Funding rate filter: skip', {
      pair,
      fundingRate: fr,
      max: config.maxFundingRate,
      min: config.minFundingRate,
    });
    return null;
  }

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

  // SL: ATR * atrSlMultiplier от entry
  const slDistance = atr * config.atrSlMultiplier;
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

// E3: Отмена зависших лимитных ордеров (старше staleOrderMinutes)
async function cancelStaleOrders(): Promise<Array<Record<string, unknown>>> {
  if (DRY_RUN) return [];
  const actions: Array<Record<string, unknown>> = [];

  try {
    const orders = await getOpenOrdersFull();
    const now = Date.now();
    const staleMs = config.staleOrderMinutes * 60 * 1000;

    for (const order of orders) {
      const createdAt = parseInt(order.createdTime) || 0;
      if (createdAt === 0) continue;
      const ageMs = now - createdAt;
      if (ageMs < staleMs) continue;

      // Только лимитные ордера (у рыночных createdTime обычно = 0 и они быстро исполняются)
      try {
        await cancelOrder(order.symbol, order.orderId);
        const ageMin = Math.round(ageMs / 60000);
        actions.push({
          type: 'stale_order_cancelled',
          symbol: order.symbol,
          orderId: order.orderId,
          ageMin,
          price: order.price,
          result: 'OK',
        });
        state.logEvent('stale_order_cancelled', {
          symbol: order.symbol,
          orderId: order.orderId,
          ageMin,
          price: order.price,
        });
        log.info('Stale order cancelled', { symbol: order.symbol, orderId: order.orderId, ageMin });
      } catch (err) {
        actions.push({
          type: 'stale_order_cancel_failed',
          symbol: order.symbol,
          orderId: order.orderId,
          result: `ERROR: ${(err as Error).message}`,
        });
      }
    }
  } catch (err) {
    log.warn('Failed to check stale orders', { error: (err as Error).message });
  }

  return actions;
}

// E2: Возвращает название группы экосистемы для символа (или null)
function getEcosystemGroup(symbol: string): string | null {
  for (const group of config.ecosystemGroups) {
    if (group.includes(symbol)) return group[0] ?? symbol;
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
  const openOrderSymbols = await getOpenOrders();

  // E2: Собираем экосистемы уже открытых позиций
  const s0 = state.get();
  const openEcosystems = new Set(
    s0.positions.map((p) => getEcosystemGroup(p.symbol)).filter(Boolean) as string[],
  );

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

    // E2: Фильтр корреляции — не открываем 2+ позиции в одной экосистеме
    const ecosystem = getEcosystemGroup(sig.pair);
    if (ecosystem && openEcosystems.has(ecosystem)) {
      results.push({ ...sig, action: `SKIP: ecosystem already has open position (${ecosystem})` });
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

    // F2: Проверка доступной маржи перед ордером
    const balance = s.balance.available;
    const requiredMargin = (sig.entryPrice * qty) / config.defaultLeverage;
    if (balance > 0 && requiredMargin > balance) {
      results.push({
        ...sig,
        action: `SKIP: insufficient margin $${requiredMargin.toFixed(2)} > available $${balance.toFixed(2)}`,
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

      log.info('Order executed', {
        symbol: sig.pair,
        side: sig.side,
        qty: qtyStr,
        orderId: orderRes.orderId,
      });

      // E2: Помечаем экосистему как занятую
      if (ecosystem) openEcosystems.add(ecosystem);

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

// Точные спецификации Bybit USDT Perpetual (qty step → decimals, price tick → decimals)
// Источник: Bybit Instruments Info API для каждого символа
const SYMBOL_SPECS: Record<string, { qtyDec: number; priceDec: number }> = {
  BTCUSDT: { qtyDec: 3, priceDec: 1 }, // step=0.001, tick=0.1
  ETHUSDT: { qtyDec: 2, priceDec: 2 }, // step=0.01,  tick=0.01
  SOLUSDT: { qtyDec: 1, priceDec: 2 }, // step=0.1,   tick=0.01
  XRPUSDT: { qtyDec: 0, priceDec: 4 }, // step=1,     tick=0.0001
  DOGEUSDT: { qtyDec: 0, priceDec: 5 }, // step=1,     tick=0.00001
  AVAXUSDT: { qtyDec: 1, priceDec: 2 }, // step=0.1,   tick=0.01
  LINKUSDT: { qtyDec: 1, priceDec: 3 }, // step=0.1,   tick=0.001
  ADAUSDT: { qtyDec: 0, priceDec: 4 }, // step=1,     tick=0.0001
  DOTUSDT: { qtyDec: 1, priceDec: 3 }, // step=0.1,   tick=0.001
  MATICUSDT: { qtyDec: 0, priceDec: 4 }, // step=1,     tick=0.0001
  ARBUSDT: { qtyDec: 0, priceDec: 4 }, // step=1,     tick=0.0001
  OPUSDT: { qtyDec: 0, priceDec: 4 }, // step=1,     tick=0.0001
};

function getQtyPrecision(symbol: string): number {
  return SYMBOL_SPECS[symbol]?.qtyDec ?? 1;
}

function formatQty(qty: number, symbol: string): string {
  const prec = getQtyPrecision(symbol);
  const formatted = qty.toFixed(prec);
  const minQty = Math.pow(10, -prec);
  return parseFloat(formatted) < minQty ? minQty.toFixed(prec) : formatted;
}

function roundPrice(val: number, symbol: string): number {
  const prec = SYMBOL_SPECS[symbol]?.priceDec ?? 4;
  return parseFloat(val.toFixed(prec));
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
    log.warn('Monitor stopped', { reason: status.reason });
    return;
  }

  await refreshAccount();
  report.balance = state.get().balance;
  report.openPositions = state.get().positions.length;

  const posActions = await managePositions();
  report.positionActions = posActions;

  // E3: Отменяем зависшие лимитные ордера перед анализом
  const staleActions = await cancelStaleOrders();
  report.staleOrdersCancelled = staleActions;

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

  log.info('Monitor cycle complete', report);
}

runMain(main, () => state.save());
