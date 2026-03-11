import { createLogger } from '../../utils/logger.js';
import {
  cancelOrder,
  getOpenOrders,
  getOpenOrdersFull,
  modifyPosition,
  setLeverage,
  submitOrder,
} from './bybit-client.js';
import config from './config.js';
import { logDecision } from './decision-journal.js';
import type { TradeSignalInternal } from './market-analyzer.js';
import * as state from './state.js';
import { formatQty } from './symbol-specs.js';

const log = createLogger('signal-executor');

const CORRELATION_THRESHOLD = 0.9;

export interface SignalResult extends TradeSignalInternal {
  action: string;
  orderId?: string | undefined;
  qty?: string;
}

// Возвращает название группы экосистемы для символа (или null)
function getEcosystemGroup(symbol: string): string | null {
  for (const group of config.ecosystemGroups) {
    if (group.includes(symbol)) return group[0] ?? symbol;
  }
  return null;
}

// Pearson correlation coefficient между двумя массивами closes
function pearsonCorrelation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 20) return 0; // недостаточно данных
  const xa = a.slice(-n);
  const xb = b.slice(-n);
  const meanA = xa.reduce((s, v) => s + v, 0) / n;
  const meanB = xb.reduce((s, v) => s + v, 0) / n;
  let num = 0,
    denA = 0,
    denB = 0;
  for (let i = 0; i < n; i++) {
    const da = xa[i]! - meanA;
    const db = xb[i]! - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  return den === 0 ? 0 : num / den;
}

export async function executeSignals(
  signals: TradeSignalInternal[],
  cycleId: string,
  dryRun: boolean,
): Promise<SignalResult[]> {
  if (dryRun) {
    return signals.map((s) => ({ ...s, action: 'DRY_RUN (not executed)' }));
  }

  const tradePerm = state.canTrade();
  if (!tradePerm.allowed) {
    return signals.map((s) => ({ ...s, action: `BLOCKED: ${tradePerm.reason}` }));
  }

  const results: SignalResult[] = [];
  let openOrderSymbols: string[];
  try {
    openOrderSymbols = await getOpenOrders();
  } catch (err) {
    log.error('Failed to fetch open orders — blocking all signals', {
      error: (err as Error).message,
    });
    return signals.map((s) => ({ ...s, action: 'BLOCKED: failed to check open orders' }));
  }

  // Собираем экосистемы уже открытых позиций
  const s0 = state.get();
  const openEcosystems = new Set(
    s0.positions.map((p) => getEcosystemGroup(p.symbol)).filter(Boolean) as string[],
  );

  // Корреляционный фильтр: убираем сигналы с высокой корреляцией к уже принятым
  // Из двух коррелированных оставляем тот, у которого выше confidence
  const acceptedCloses = new Map<string, number[]>(); // pair → closes уже принятых сигналов

  for (const sig of signals) {
    const perm = state.canTrade();
    if (!perm.allowed) {
      results.push({ ...sig, action: `BLOCKED: ${perm.reason}` });
      continue;
    }

    const s = state.get();
    const existing = s.positions.find((p) => p.symbol === sig.pair);
    if (existing) {
      logDecision(
        cycleId,
        'skip',
        sig.pair,
        'POSITION_ALREADY_OPEN',
        [`Позиция ${existing.side} уже открыта`],
        { confluenceScore: sig.confluence.total, regime: sig.regime },
      );
      results.push({ ...sig, action: 'SKIP: position already open' });
      continue;
    }

    if (openOrderSymbols.includes(sig.pair)) {
      logDecision(
        cycleId,
        'skip',
        sig.pair,
        'PENDING_ORDER_EXISTS',
        ['Лимитный ордер уже ожидает исполнения'],
        { confluenceScore: sig.confluence.total, regime: sig.regime },
      );
      results.push({ ...sig, action: 'SKIP: pending order already exists' });
      continue;
    }

    // Фильтр корреляции — не открываем 2+ позиции в одной экосистеме
    const ecosystem = getEcosystemGroup(sig.pair);
    if (ecosystem && openEcosystems.has(ecosystem)) {
      logDecision(
        cycleId,
        'skip',
        sig.pair,
        'ECOSYSTEM_OCCUPIED',
        [`Группа ${ecosystem} уже занята открытой позицией`],
        { confluenceScore: sig.confluence.total, regime: sig.regime },
      );
      results.push({ ...sig, action: `SKIP: ecosystem already has open position (${ecosystem})` });
      continue;
    }

    // Корреляционный фильтр: проверяем корреляцию с уже принятыми сигналами в этом батче
    if (sig.recentCloses && sig.recentCloses.length >= 20) {
      let highCorr: { pair: string; corr: number } | null = null;
      for (const [acceptedPair, closes] of acceptedCloses) {
        const corr = pearsonCorrelation(sig.recentCloses, closes);
        if (Math.abs(corr) >= CORRELATION_THRESHOLD) {
          highCorr = { pair: acceptedPair, corr };
          break;
        }
      }
      if (highCorr) {
        logDecision(cycleId, 'skip', sig.pair, 'HIGH_CORRELATION', [
          `Корреляция ${highCorr.corr.toFixed(3)} с ${highCorr.pair} > порог ${CORRELATION_THRESHOLD}`,
        ]);
        results.push({
          ...sig,
          action: `SKIP: correlation ${highCorr.corr.toFixed(3)} with ${highCorr.pair}`,
        });
        continue;
      }
    }

    // Размер позиции: 1 ордер = baseQty (без grid multiplier)
    const totalQty = state.calcPositionSize(sig.entryPrice, sig.sl);
    if (totalQty <= 0) {
      logDecision(cycleId, 'skip', sig.pair, 'QTY_CALCULATION_FAILED', [
        'Не удалось рассчитать размер позиции',
      ]);
      results.push({ ...sig, action: 'SKIP: failed to calculate qty' });
      continue;
    }

    // Проверка объёма позиции: notional value не должен превышать баланс * maxLeverage
    const notionalValue = sig.entryPrice * totalQty;
    const maxNotional = s.balance.total * config.maxLeverage;
    if (maxNotional > 0 && notionalValue > maxNotional) {
      logDecision(
        cycleId,
        'skip',
        sig.pair,
        'POSITION_SIZE_TOO_LARGE',
        [
          `Notional $${notionalValue.toFixed(0)} > макс $${maxNotional.toFixed(0)} (баланс × leverage)`,
        ],
        { confluenceScore: sig.confluence.total, regime: sig.regime },
      );
      results.push({
        ...sig,
        action: `SKIP: notional $${notionalValue.toFixed(0)} > max $${maxNotional.toFixed(0)}`,
      });
      continue;
    }

    // Проверка риска на сделку
    const slDist = Math.abs(sig.entryPrice - sig.sl);
    const risk = slDist * totalQty;
    if (risk > config.maxRiskPerTrade) {
      logDecision(
        cycleId,
        'skip',
        sig.pair,
        'RISK_TOO_HIGH',
        [`Риск $${risk.toFixed(2)} > лимит $${config.maxRiskPerTrade}`],
        { confluenceScore: sig.confluence.total, regime: sig.regime },
      );
      results.push({
        ...sig,
        action: `SKIP: risk $${risk.toFixed(2)} > max $${config.maxRiskPerTrade}`,
      });
      continue;
    }

    // Проверка маржи: лимит = total / maxOpenPositions (гарантирует что все слоты влезут)
    const balance = s.balance.available;
    const requiredMargin = (sig.entryPrice * totalQty) / config.defaultLeverage;
    const maxMarginPerPosition = s.balance.total / config.maxOpenPositions;
    if (maxMarginPerPosition > 0 && requiredMargin > maxMarginPerPosition) {
      logDecision(
        cycleId,
        'skip',
        sig.pair,
        'MARGIN_PER_POSITION_LIMIT',
        [
          `Маржа $${requiredMargin.toFixed(0)} > лимит $${maxMarginPerPosition.toFixed(0)} (баланс/${config.maxOpenPositions} позиций)`,
        ],
        { confluenceScore: sig.confluence.total, regime: sig.regime },
      );
      results.push({
        ...sig,
        action: `SKIP: margin $${requiredMargin.toFixed(0)} > per-position limit $${maxMarginPerPosition.toFixed(0)}`,
      });
      continue;
    }
    if (balance > 0 && requiredMargin > balance) {
      logDecision(
        cycleId,
        'skip',
        sig.pair,
        'INSUFFICIENT_MARGIN',
        [`Маржа $${requiredMargin.toFixed(2)} > доступно $${balance.toFixed(2)}`],
        { confluenceScore: sig.confluence.total, regime: sig.regime },
      );
      results.push({
        ...sig,
        action: `SKIP: insufficient margin $${requiredMargin.toFixed(2)} > available $${balance.toFixed(2)}`,
      });
      continue;
    }

    // Валидация SL/TP перед отправкой ордера
    if (!sig.sl || !sig.tp || sig.sl === sig.entryPrice || sig.tp === sig.entryPrice) {
      logDecision(cycleId, 'skip', sig.pair, 'INVALID_SL_TP', [
        `SL=${sig.sl}, TP=${sig.tp}, Entry=${sig.entryPrice} — невалидные уровни`,
      ]);
      results.push({ ...sig, action: 'SKIP: invalid SL/TP values' });
      continue;
    }

    try {
      await setLeverage(sig.pair, config.defaultLeverage);

      const qtyStr = formatQty(totalQty, sig.pair);
      log.info('Submitting order', {
        symbol: sig.pair,
        side: sig.side,
        qty: qtyStr,
        rawQty: totalQty,
        entry: sig.entryPrice,
      });

      // Один Market ордер — гарантированный вход по рыночной цене
      const orderRes = await submitOrder({
        symbol: sig.pair,
        side: sig.side,
        orderType: 'Market',
        qty: qtyStr,
      });

      const orderId = orderRes.orderId;

      // Устанавливаем SL/TP на уровне ПОЗИЦИИ
      // Retry с задержкой: market ордер может ещё не создать позицию на Bybit
      let slTpSet = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          if (attempt > 0) {
            await new Promise((r) => setTimeout(r, 2000));
          }
          await modifyPosition(sig.pair, String(sig.sl), String(sig.tp));
          log.info('Position SL/TP set', { symbol: sig.pair, sl: sig.sl, tp: sig.tp, attempt });
          slTpSet = true;
          break;
        } catch (slErr) {
          log.warn(`SL/TP attempt ${attempt + 1}/3 failed`, {
            symbol: sig.pair,
            error: (slErr as Error).message,
          });
        }
      }
      if (!slTpSet) {
        log.error('CRITICAL: Failed to set SL/TP after 3 attempts — SL-Guard must handle', {
          symbol: sig.pair,
          sl: sig.sl,
          tp: sig.tp,
        });
      }

      state.logEvent('order_opened', {
        symbol: sig.pair,
        side: sig.side,
        qty: qtyStr,
        entry: sig.entryPrice,
        sl: sig.sl,
        tp: sig.tp,
        orderType: 'Market',
        confluenceScore: sig.confluence.total,
        confluenceSignal: sig.confluence.signal,
        confidence: sig.confidence,
        regime: sig.regime,
        reason: sig.reason,
        orderId,
      });

      logDecision(
        cycleId,
        'entry',
        sig.pair,
        `OPEN_${sig.side.toUpperCase()}`,
        [
          sig.reason,
          `Entry: ${sig.entryPrice}, SL: ${sig.sl}, TP: ${sig.tp}, R:R: ${sig.rr}`,
          `Qty: ${qtyStr}`,
        ],
        {
          confluenceScore: sig.confluence.total,
          confluenceSignal: sig.confluence.signal,
          confidence: sig.confidence,
          regime: sig.regime,
          side: sig.side,
          entry: sig.entryPrice,
          sl: sig.sl,
          tp: sig.tp,
          qty: qtyStr,
          rr: sig.rr,
          orderId,
        },
      );

      log.info('Market order executed', {
        symbol: sig.pair,
        side: sig.side,
        qty: qtyStr,
        orderId,
      });

      // Помечаем экосистему как занятую и записываем cooldown
      if (ecosystem) openEcosystems.add(ecosystem);
      if (sig.recentCloses) acceptedCloses.set(sig.pair, sig.recentCloses);
      state.recordPairTrade(sig.pair);

      results.push({
        ...sig,
        action: 'EXECUTED',
        orderId,
        qty: qtyStr,
      });
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

// Отмена зависших лимитных ордеров (старше staleOrderMinutes)
export async function cancelStaleOrders(): Promise<Array<Record<string, unknown>>> {
  const actions: Array<Record<string, unknown>> = [];

  try {
    const orders = await getOpenOrdersFull();
    const now = Date.now();
    const staleMs = config.staleOrderMinutes * 60 * 1000;

    for (const order of orders) {
      // Пропускаем conditional ордера (SL/TP/Trailing) — это НЕ stale лимитки
      if (order.stopOrderType) continue;

      const createdAt = parseInt(order.createdTime) || 0;
      if (createdAt === 0) continue;
      const ageMs = now - createdAt;
      if (ageMs < staleMs) continue;

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
