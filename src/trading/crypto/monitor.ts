/**
 * Crypto Monitor — автономный мониторинг рынка (каждые 10 минут).
 *
 * Выполняет:
 *   1. Проверку kill-switch / stop-day
 *   2. Обновление баланса и позиций
 *   3. Управление открытыми позициями (partial close, trailing, SL на б/у)
 *   4. Анализ рынка по всем парам (тренд + вход)
 *   5. Открытие сделок при наличии сигнала (mode=execute)
 *
 * Использование:
 *   tsx src/trading/crypto/monitor.ts
 *   tsx src/trading/crypto/monitor.ts --dry-run
 *   tsx src/trading/crypto/monitor.ts --pair=BTCUSDT
 *
 * Мигрировано из scripts/crypto_monitor.js
 */

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

// ─── CLI ──────────────────────────────────────────────────────

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const DRY_RUN = hasFlag('dry-run') || config.mode !== 'execute';
const SINGLE_PAIR = getArg('pair');

// ─── Типы ─────────────────────────────────────────────────────

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

// ─── Шаг 1: Статус и лимиты ──────────────────────────────────

function checkStatus(): { ok: boolean; reason: string } {
  state.load();

  if (state.isKillSwitchActive()) {
    return { ok: false, reason: 'KILL_SWITCH активен' };
  }

  const s = state.get();
  if (s.daily.stopDay) {
    return { ok: false, reason: `СТОП-ДЕНЬ: ${s.daily.stopDayReason}` };
  }

  return { ok: true, reason: 'OK' };
}

// ─── Шаг 2: Обновить баланс + позиции ───────────────────────

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
    log.warn('Не удалось получить баланс', { error: (err as Error).message });
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
    log.warn('Не удалось получить позиции', { error: (err as Error).message });
  }
}

// ─── Шаг 3: Управление открытыми позициями ───────────────────

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

    // Partial close при +1R
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

          // Передвинуть SL на безубыток
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

    // Trailing stop после +1.5R
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

// ─── Шаг 4: Анализ рынка ────────────────────────────────────

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
  // Multi-timeframe анализ
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

  // Нет тренда — не торгуем
  if (trendBias === 'UNKNOWN') return null;

  // Funding rate фильтр
  if (trendBias === 'BULLISH' && fundingRate > config.maxFundingRate) return null;
  if (trendBias === 'BEARISH' && fundingRate < config.minFundingRate) return null;

  // LONG сигнал
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
        reason: `BULLISH тренд 4h + RSI15m=${rsi15m.toFixed(1)} + поддержка ${support}`,
        funding: fundingRate,
        atr: atr15m,
        trendBias,
        rsi4h,
        rsi15m,
      };
    }
  }

  // SHORT сигнал
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
        reason: `BEARISH тренд 4h + RSI15m=${rsi15m.toFixed(1)} + сопротивление ${resistance}`,
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

// ─── Шаг 5: Исполнение сигналов ──────────────────────────────

async function executeSignals(signals: TradeSignalInternal[]): Promise<SignalResult[]> {
  if (DRY_RUN) {
    return signals.map((s) => ({ ...s, action: 'DRY_RUN (не исполнено)' }));
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

    // Проверяем нет ли уже позиции по этой паре
    const s = state.get();
    const existing = s.positions.find((p) => p.symbol === sig.pair);
    if (existing) {
      results.push({ ...sig, action: 'SKIP: уже есть позиция' });
      continue;
    }

    // Рассчитываем размер позиции
    const qty = state.calcPositionSize(sig.entryPrice, sig.sl);
    if (qty <= 0) {
      results.push({ ...sig, action: 'SKIP: не удалось рассчитать qty' });
      continue;
    }

    // Проверяем риск
    const slDist = Math.abs(sig.entryPrice - sig.sl);
    const risk = slDist * qty;
    if (risk > config.maxRiskPerTrade) {
      results.push({
        ...sig,
        action: `SKIP: риск $${risk.toFixed(2)} > макс $${config.maxRiskPerTrade}`,
      });
      continue;
    }

    try {
      // Установить плечо
      await setLeverage(sig.pair, config.defaultLeverage);

      // Открыть ордер
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

// ─── Utils ────────────────────────────────────────────────────

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

// ─── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const startTime = Date.now();
  const report: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    mode: DRY_RUN ? 'dry-run' : 'execute',
  };

  // 1. Проверка статуса
  const status = checkStatus();
  report.status = status;
  if (!status.ok) {
    report.result = 'STOPPED';
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // 2. Обновить аккаунт
  await refreshAccount();
  report.balance = state.get().balance;
  report.openPositions = state.get().positions.length;

  // 3. Управление позициями
  const posActions = await managePositions();
  report.positionActions = posActions;

  // 4. Анализ рынка
  const signals = await analyzeMarket();
  report.signals = signals;

  // 5. Исполнение
  const execResults = await executeSignals(signals);
  report.execution = execResults;

  // 6. Обновить lastMonitor
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
  log.error(`Критическая ошибка: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
