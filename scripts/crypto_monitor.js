#!/usr/bin/env node
'use strict';
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
 * Запуск:
 *   node scripts/crypto_monitor.js
 *   node scripts/crypto_monitor.js --dry-run   # только анализ без сделок
 *   node scripts/crypto_monitor.js --pair=BTCUSDT  # только одна пара
 *
 * Вывод: JSON с результатами мониторинга.
 */

const { execSync } = require('child_process');
const path = require('path');
const config = require('./crypto_config');
const state = require('./crypto_state');

const SCRIPTS_DIR = path.resolve(__dirname);
const TRADE_JS = path.join(SCRIPTS_DIR, 'bybit_trade.js');
const DATA_PY = path.join(SCRIPTS_DIR, 'bybit_get_data.py');

// ─── CLI ──────────────────────────────────────────────────────

function getArg(name, def) {
  const p = `--${name}=`;
  const f = process.argv.find(a => a.startsWith(p));
  return f ? f.slice(p.length) : def;
}
function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}
const DRY_RUN = hasFlag('dry-run') || config.mode !== 'execute';
const SINGLE_PAIR = getArg('pair');

// ─── Exec helpers ─────────────────────────────────────────────

function runTrade(args) {
  try {
    const out = execSync(`node "${TRADE_JS}" ${args}`, {
      timeout: 30000,
      encoding: 'utf-8',
      env: { ...process.env, HOME: process.env.HOME || '/root' },
    });
    return JSON.parse(out.trim());
  } catch (e) {
    try {
      return JSON.parse(e.stdout?.trim());
    } catch {
      return { status: 'ERROR', error: e.message };
    }
  }
}

function runData(args) {
  try {
    const out = execSync(`python3 "${DATA_PY}" ${args}`, {
      timeout: 15000,
      encoding: 'utf-8',
    });
    return JSON.parse(out.trim());
  } catch (e) {
    try {
      return JSON.parse(e.stdout?.trim());
    } catch {
      return { error: e.message };
    }
  }
}

// ─── Шаг 1: Статус и лимиты ──────────────────────────────────

function checkStatus() {
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

function refreshAccount() {
  const balRes = runTrade('--action=balance');
  if (balRes.status === 'OK') {
    state.updateBalance(balRes);
  }

  const posRes = runTrade('--action=positions');
  if (posRes.status === 'OK') {
    state.updatePositions(posRes.positions || []);
  }

  return { balance: balRes, positions: posRes };
}

// ─── Шаг 3: Управление открытыми позициями ───────────────────

function managePositions() {
  const s = state.get();
  const actions = [];

  for (const pos of s.positions) {
    const uPnl = parseFloat(pos.unrealisedPnl) || 0;
    const entry = parseFloat(pos.entryPrice) || 0;
    const sl = parseFloat(pos.stopLoss) || 0;
    const size = parseFloat(pos.size) || 0;

    if (entry === 0 || size === 0) continue;

    // Рассчитать 1R
    const slDistance = Math.abs(entry - sl);
    if (slDistance === 0) continue;

    const oneR = slDistance * size;
    const currentR = uPnl / oneR;

    // Partial close при +1R
    if (currentR >= config.partialCloseAtR && !DRY_RUN) {
      const partialQty = (size * config.partialClosePercent).toFixed(getQtyPrecision(pos.symbol));
      if (parseFloat(partialQty) > 0) {
        const closeRes = runTrade(
          `--action=partial_close --symbol=${pos.symbol} --qty=${partialQty}`
        );
        actions.push({
          type: 'partial_close',
          symbol: pos.symbol,
          qty: partialQty,
          atR: currentR.toFixed(2),
          result: closeRes.status,
        });

        // Передвинуть SL на безубыток
        const modRes = runTrade(`--action=modify --symbol=${pos.symbol} --sl=${entry}`);
        actions.push({
          type: 'sl_breakeven',
          symbol: pos.symbol,
          newSl: entry,
          result: modRes.status,
        });

        state.logEvent('partial_close', {
          symbol: pos.symbol,
          qty: partialQty,
          pnlAtClose: uPnl,
          rMultiple: currentR.toFixed(2),
        });
      }
    }

    // Trailing stop после +1.5R (передвигаем SL)
    if (currentR >= config.trailingStartR && !DRY_RUN) {
      const mark = parseFloat(pos.markPrice) || 0;
      const trailingDistance = slDistance * config.trailingDistanceR;
      let newSl;
      if (pos.side === 'Buy') {
        newSl = mark - trailingDistance;
        if (newSl > sl) {
          const modRes = runTrade(
            `--action=modify --symbol=${pos.symbol} --sl=${newSl.toFixed(2)}`
          );
          actions.push({
            type: 'trailing_sl',
            symbol: pos.symbol,
            oldSl: sl,
            newSl: newSl.toFixed(2),
            result: modRes.status,
          });
        }
      } else {
        newSl = mark + trailingDistance;
        if (newSl < sl || sl === 0) {
          const modRes = runTrade(
            `--action=modify --symbol=${pos.symbol} --sl=${newSl.toFixed(2)}`
          );
          actions.push({
            type: 'trailing_sl',
            symbol: pos.symbol,
            oldSl: sl,
            newSl: newSl.toFixed(2),
            result: modRes.status,
          });
        }
      }
    }
  }

  return actions;
}

// ─── Шаг 4: Анализ рынка ────────────────────────────────────

function analyzeMarket() {
  const pairs = SINGLE_PAIR ? [SINGLE_PAIR.toUpperCase()] : config.pairs;
  const signals = [];

  for (const pair of pairs) {
    try {
      const signal = analyzePair(pair);
      if (signal) signals.push(signal);
    } catch (e) {
      state.logEvent('analysis_error', { pair, error: e.message });
    }
  }

  return signals;
}

function analyzePair(pair) {
  // 4h — тренд
  const h4 = runData(`--pair ${pair} --tf 240 --bars 100`);
  if (h4.error) return null;

  // 1h — зоны
  const h1 = runData(`--pair ${pair} --tf 60 --bars 50`);

  // 15m — точка входа
  const m15 = runData(`--pair ${pair} --tf 15 --bars 100`);
  if (m15.error) return null;

  // Market info (funding, OI)
  const mkt = runData(`--pair ${pair} --market-info`);

  // Определяем bias
  const trendBias = h4.bias?.ema_trend || 'UNKNOWN';
  const priceVsEma = h4.bias?.price_vs_ema200 || 'UNKNOWN';
  const rsi4h = h4.indicators?.rsi14 || 50;
  const rsi15m = m15.indicators?.rsi14 || 50;
  const atr15m = m15.indicators?.atr14 || 0;
  const currentPrice = m15.current_price || h4.current_price || 0;
  const fundingRate = mkt?.data?.funding_rate || 0;

  // Нет тренда = не торгуем
  if (trendBias === 'UNKNOWN') return null;

  // Проверяем фильтры
  // Funding rate фильтр
  if (trendBias === 'BULLISH' && fundingRate > config.maxFundingRate) return null;
  if (trendBias === 'BEARISH' && fundingRate < config.minFundingRate) return null;

  // RSI фильтр — ищем перепроданность для лонга, перекупленность для шорта
  let entrySignal = null;

  if (trendBias === 'BULLISH' && priceVsEma === 'ABOVE') {
    // LONG: RSI15m < 40 или цена вблизи support
    const support = m15.levels?.support || 0;
    const distToSupport = support > 0 ? ((currentPrice - support) / currentPrice) * 100 : 999;

    if (rsi15m < 40 || distToSupport < 1.5) {
      const sl = support > 0 ? support - atr15m : currentPrice * 0.98;
      const slDist = currentPrice - sl;
      const tp = currentPrice + slDist * config.minRR;

      entrySignal = {
        pair,
        side: 'Buy',
        entryPrice: currentPrice,
        sl: round(sl, pair),
        tp: round(tp, pair),
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

  if (trendBias === 'BEARISH' && priceVsEma === 'BELOW') {
    // SHORT: RSI15m > 60 или цена вблизи resistance
    const resistance = m15.levels?.resistance || 0;
    const distToResistance =
      resistance > 0 ? ((resistance - currentPrice) / currentPrice) * 100 : 999;

    if (rsi15m > 60 || distToResistance < 1.5) {
      const sl = resistance > 0 ? resistance + atr15m : currentPrice * 1.02;
      const slDist = sl - currentPrice;
      const tp = currentPrice - slDist * config.minRR;

      entrySignal = {
        pair,
        side: 'Sell',
        entryPrice: currentPrice,
        sl: round(sl, pair),
        tp: round(tp, pair),
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

  return entrySignal;
}

// ─── Шаг 5: Исполнение сигналов ──────────────────────────────

function executeSignals(signals) {
  if (DRY_RUN) {
    return signals.map(s => ({ ...s, action: 'DRY_RUN (не исполнено)' }));
  }

  const tradePerm = state.canTrade();
  if (!tradePerm.allowed) {
    return signals.map(s => ({ ...s, action: `BLOCKED: ${tradePerm.reason}` }));
  }

  const results = [];

  for (const sig of signals) {
    // Ещё раз проверяем лимиты (может измениться после каждой сделки)
    const perm = state.canTrade();
    if (!perm.allowed) {
      results.push({ ...sig, action: `BLOCKED: ${perm.reason}` });
      continue;
    }

    // Проверяем нет ли уже позиции по этой паре
    const s = state.get();
    const existing = s.positions.find(p => p.symbol === sig.pair);
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

    // Проверяем R:R
    const slDist = Math.abs(sig.entryPrice - sig.sl);
    const risk = slDist * qty;
    if (risk > config.maxRiskPerTrade) {
      results.push({
        ...sig,
        action: `SKIP: риск $${risk.toFixed(2)} > макс $${config.maxRiskPerTrade}`,
      });
      continue;
    }

    // Установить плечо
    runTrade(`--action=leverage --symbol=${sig.pair} --leverage=${config.defaultLeverage}`);

    // Открыть ордер
    const qtyStr = formatQty(qty, sig.pair);
    const orderRes = runTrade(
      `--action=order --symbol=${sig.pair} --side=${sig.side} --qty=${qtyStr} --sl=${sig.sl} --tp=${sig.tp}`
    );

    if (orderRes.status === 'EXECUTED') {
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
    } else {
      results.push({ ...sig, action: `ERROR: ${orderRes.error || orderRes.retMsg || 'unknown'}` });
    }
  }

  return results;
}

// ─── Utils ────────────────────────────────────────────────────

function getQtyPrecision(symbol) {
  if (symbol.startsWith('BTC')) return 3;
  if (symbol.startsWith('ETH')) return 2;
  if (symbol.startsWith('SOL')) return 1;
  return 1;
}

function formatQty(qty, symbol) {
  const prec = getQtyPrecision(symbol);
  const formatted = qty.toFixed(prec);
  // Минимальное значение
  const minQty = Math.pow(10, -prec);
  return parseFloat(formatted) < minQty ? minQty.toFixed(prec) : formatted;
}

function round(val, symbol) {
  if (symbol.startsWith('BTC')) return parseFloat(val.toFixed(1));
  if (symbol.startsWith('ETH')) return parseFloat(val.toFixed(2));
  return parseFloat(val.toFixed(4));
}

// ─── Main ─────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();
  const report = {
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
  const account = refreshAccount();
  report.balance = state.get().balance;
  report.openPositions = state.get().positions.length;

  // 3. Управление позициями
  const posActions = managePositions();
  report.positionActions = posActions;

  // 4. Анализ рынка
  const signals = analyzeMarket();
  report.signals = signals;

  // 5. Исполнение
  const execResults = executeSignals(signals);
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
    executed: execResults.filter(r => r.action === 'EXECUTED').length,
    positions: s.positions.length,
    mode: DRY_RUN ? 'dry-run' : 'execute',
  });

  console.log(JSON.stringify(report, null, 2));
}

main().catch(err => {
  console.error(JSON.stringify({ status: 'ERROR', error: err.message }));
  process.exit(1);
});
