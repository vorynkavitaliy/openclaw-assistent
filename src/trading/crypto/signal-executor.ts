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
import { recordPairTrade, type TradeSignalInternal } from './market-analyzer.js';
import * as state from './state.js';
import { formatQty, roundPrice } from './symbol-specs.js';

const log = createLogger('signal-executor');

export interface SignalResult extends TradeSignalInternal {
  action: string;
  orderId?: string | undefined;
  orderIds?: string[];
  qty?: string;
}

/**
 * Рассчитывает grid-уровни входа.
 * Ордер 1 (50%): entry (bid1/ask1)
 * Ордер 2 (30%): entry ± 0.3×ATR
 * Ордер 3 (20%): entry ± 0.6×ATR
 * Суммарный объём = baseQty × gridVolumeMultiplier
 */
interface GridLevel {
  price: number;
  qtyFraction: number; // доля от общего объёма (0.5, 0.3, 0.2)
}

function buildGridLevels(
  entry: number,
  side: 'Buy' | 'Sell',
  atr: number,
  pair: string,
): GridLevel[] {
  const levels = config.gridLevels;
  if (levels <= 1) {
    return [{ price: entry, qtyFraction: 1.0 }];
  }

  const spacing = atr * config.gridSpacingAtr;
  // Распределение объёма: 50% / 30% / 20% для 3 уровней
  const fractions = levels === 2 ? [0.6, 0.4] : [0.5, 0.3, 0.2];

  return fractions.slice(0, levels).map((frac, i) => {
    const offset = spacing * i;
    // Buy: каждый следующий уровень ниже (лучшая цена)
    // Sell: каждый следующий уровень выше (лучшая цена)
    const price = side === 'Buy' ? entry - offset : entry + offset;
    return { price: roundPrice(price, pair), qtyFraction: frac };
  });
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

    // Базовый размер позиции (от riskPerTrade, до увеличения grid multiplier)
    const baseQty = state.calcPositionSize(sig.entryPrice, sig.sl);
    if (baseQty <= 0) {
      logDecision(cycleId, 'skip', sig.pair, 'QTY_CALCULATION_FAILED', [
        'Не удалось рассчитать размер позиции',
      ]);
      results.push({ ...sig, action: 'SKIP: failed to calculate qty' });
      continue;
    }

    // Grid: общий объём = baseQty × gridVolumeMultiplier
    const totalQty = baseQty * config.gridVolumeMultiplier;

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

    // Риск при полном заполнении grid (worst case — все ордера заполнены, SL от первого уровня)
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

    // Проверка доступной маржи перед ордером (для полного grid)
    const balance = s.balance.available;
    const requiredMargin = (sig.entryPrice * totalQty) / config.defaultLeverage;
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

      // ATR для расчёта grid spacing
      const atr = slDist / config.atrSlMultiplier;

      // Grid уровни
      const gridLevels = buildGridLevels(sig.entryPrice, sig.side, atr, sig.pair);
      const orderIds: string[] = [];
      const qtyParts: string[] = [];
      let totalFilledQtyStr = '';

      for (const level of gridLevels) {
        const levelQty = totalQty * level.qtyFraction;
        const qtyStr = formatQty(levelQty, sig.pair);
        if (parseFloat(qtyStr) <= 0) continue;

        // SL/TP только на первом (основном) ордере — Bybit привяжет к позиции
        const isFirst = orderIds.length === 0;

        const orderRes = await submitOrder({
          symbol: sig.pair,
          side: sig.side,
          orderType: 'Limit',
          qty: qtyStr,
          price: String(level.price),
          ...(isFirst ? { stopLoss: String(sig.sl), takeProfit: String(sig.tp) } : {}),
        });

        orderIds.push(orderRes.orderId);
        qtyParts.push(qtyStr);
      }

      totalFilledQtyStr = qtyParts.join('+');

      state.logEvent('order_opened', {
        symbol: sig.pair,
        side: sig.side,
        qty: totalFilledQtyStr,
        gridLevels: gridLevels.length,
        gridPrices: gridLevels.map((l) => l.price),
        entry: sig.entryPrice,
        sl: sig.sl,
        tp: sig.tp,
        orderType: 'Limit',
        confluenceScore: sig.confluence.total,
        confluenceSignal: sig.confluence.signal,
        confidence: sig.confidence,
        regime: sig.regime,
        reason: sig.reason,
        orderIds,
      });

      logDecision(
        cycleId,
        'entry',
        sig.pair,
        `OPEN_${sig.side.toUpperCase()}`,
        [
          sig.reason,
          `Grid ${gridLevels.length} lvl: ${gridLevels.map((l) => l.price).join(' / ')}`,
          `Entry: ${sig.entryPrice}, SL: ${sig.sl}, TP: ${sig.tp}, R:R: ${sig.rr}`,
          `Qty: ${totalFilledQtyStr} (×${config.gridVolumeMultiplier})`,
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
          qty: totalFilledQtyStr,
          gridLevels: gridLevels.length,
          rr: sig.rr,
          orderIds,
        },
      );

      log.info('Grid orders executed', {
        symbol: sig.pair,
        side: sig.side,
        gridLevels: gridLevels.length,
        qty: totalFilledQtyStr,
        orderIds,
      });

      // Помечаем экосистему как занятую и записываем cooldown
      if (ecosystem) openEcosystems.add(ecosystem);
      recordPairTrade(sig.pair);

      results.push({
        ...sig,
        action: 'EXECUTED',
        orderId: orderIds[0],
        orderIds,
        qty: totalFilledQtyStr,
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
