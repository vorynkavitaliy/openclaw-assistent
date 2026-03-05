import { createLogger } from '../../utils/logger.js';
import {
  cancelOrder,
  getOpenOrders,
  getOpenOrdersFull,
  setLeverage,
  submitOrder,
} from './bybit-client.js';
import config from './config.js';
import { logDecision } from './decision-journal.js';
import type { TradeSignalInternal } from './market-analyzer.js';
import * as state from './state.js';
import { formatQty } from './symbol-specs.js';

const log = createLogger('signal-executor');

export interface SignalResult extends TradeSignalInternal {
  action: string;
  orderId?: string;
  qty?: string;
}

// Возвращает название группы экосистемы для символа (или null)
function getEcosystemGroup(symbol: string): string | null {
  for (const group of config.ecosystemGroups) {
    if (group.includes(symbol)) return group[0] ?? symbol;
  }
  return null;
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
  const openOrderSymbols = await getOpenOrders();

  // Собираем экосистемы уже открытых позиций
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

    const qty = state.calcPositionSize(sig.entryPrice, sig.sl);
    if (qty <= 0) {
      logDecision(cycleId, 'skip', sig.pair, 'QTY_CALCULATION_FAILED', [
        'Не удалось рассчитать размер позиции',
      ]);
      results.push({ ...sig, action: 'SKIP: failed to calculate qty' });
      continue;
    }

    const slDist = Math.abs(sig.entryPrice - sig.sl);
    const risk = slDist * qty;
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

    // Проверка доступной маржи перед ордером
    const balance = s.balance.available;
    const requiredMargin = (sig.entryPrice * qty) / config.defaultLeverage;
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

      const qtyStr = formatQty(qty, sig.pair);

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

      logDecision(
        cycleId,
        'entry',
        sig.pair,
        `OPEN_${sig.side.toUpperCase()}`,
        [
          sig.reason,
          `Entry: ${sig.entryPrice}, SL: ${sig.sl}, TP: ${sig.tp}, R:R: ${sig.rr}`,
          `Qty: ${qtyStr}, Risk: $${(Math.abs(sig.entryPrice - sig.sl) * parseFloat(qtyStr)).toFixed(2)}`,
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
          orderId: orderRes.orderId,
        },
      );

      log.info('Order executed', {
        symbol: sig.pair,
        side: sig.side,
        qty: qtyStr,
        orderId: orderRes.orderId,
      });

      // Помечаем экосистему как занятую
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

// Отмена зависших лимитных ордеров (старше staleOrderMinutes)
export async function cancelStaleOrders(): Promise<Array<Record<string, unknown>>> {
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
