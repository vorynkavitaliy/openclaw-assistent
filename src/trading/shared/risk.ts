/**
 * Risk management — управление рисками.
 * Расчёт размера позиции, проверка лимитов.
 */

import type { AccountInfo, Position, TradingConfig } from './types.js';

/**
 * Результат расчёта размера позиции.
 */
export interface PositionSizeResult {
  qty: number;
  riskAmount: number;
  stopDistance: number;
  leverage: number;
}

/**
 * Результат проверки возможности торговать.
 */
export interface CanTradeResult {
  allowed: boolean;
  reason: string;
}

/**
 * Расчёт размера позиции на основе риска.
 *
 * @param balance - текущий баланс
 * @param entryPrice - цена входа
 * @param stopLoss - цена стоп-лосса
 * @param config - торговая конфигурация
 * @returns объект с количеством, суммой риска и расстоянием до стопа
 */
export function calculatePositionSize(
  balance: number,
  entryPrice: number,
  stopLoss: number,
  config: TradingConfig,
): PositionSizeResult {
  const stopDistance = Math.abs(entryPrice - stopLoss);

  if (stopDistance === 0) {
    return { qty: 0, riskAmount: 0, stopDistance: 0, leverage: config.defaultLeverage };
  }

  // Риск на сделку — меньшее из: riskPerTrade * balance и maxRiskPerTrade
  const riskFromPercent = balance * config.riskPerTrade;
  const riskAmount = Math.min(riskFromPercent, config.maxRiskPerTrade);

  // Количество = риск / расстояние до стопа
  const qty = riskAmount / stopDistance;

  return {
    qty,
    riskAmount,
    stopDistance,
    leverage: config.defaultLeverage,
  };
}

/**
 * Проверка лимитов: можно ли открыть новую сделку.
 *
 * @param state - текущее состояние торговли
 * @param config - торговая конфигурация
 * @param killSwitchActive - активен ли kill switch
 * @returns разрешение или отказ с причиной
 */
export function canTrade(
  state: {
    stopDay: boolean;
    stopsCount: number;
    dailyPnl: number;
    positions: Position[];
  },
  config: TradingConfig,
  killSwitchActive: boolean,
): CanTradeResult {
  if (killSwitchActive) {
    return { allowed: false, reason: 'Kill switch активен' };
  }

  if (state.stopDay) {
    return { allowed: false, reason: 'Стоп-день: торговля приостановлена' };
  }

  if (state.stopsCount >= config.maxStopsPerDay) {
    return {
      allowed: false,
      reason: `Достигнут лимит стопов: ${state.stopsCount}/${config.maxStopsPerDay}`,
    };
  }

  if (state.dailyPnl <= -config.maxDailyLoss) {
    return {
      allowed: false,
      reason: `Достигнут лимит дневного убытка: $${Math.abs(state.dailyPnl)}`,
    };
  }

  if (state.positions.length >= config.maxOpenPositions) {
    return {
      allowed: false,
      reason: `Достигнут лимит позиций: ${state.positions.length}/${config.maxOpenPositions}`,
    };
  }

  return { allowed: true, reason: 'OK' };
}

/**
 * Проверка R:R (Risk/Reward) сигнала.
 *
 * @param entry - цена входа
 * @param stopLoss - цена стоп-лосса
 * @param takeProfit - цена тейк-профита
 * @param minRR - минимальный R:R
 * @returns true если R:R >= minRR
 */
export function isValidRiskReward(
  entry: number,
  stopLoss: number,
  takeProfit: number,
  minRR: number,
): boolean {
  const risk = Math.abs(entry - stopLoss);
  const reward = Math.abs(takeProfit - entry);

  if (risk === 0) return false;

  return reward / risk >= minRR;
}

/**
 * Расчёт R:R (Risk/Reward).
 */
export function calculateRiskReward(entry: number, stopLoss: number, takeProfit: number): number {
  const risk = Math.abs(entry - stopLoss);
  const reward = Math.abs(takeProfit - entry);

  if (risk === 0) return 0;

  return Math.round((reward / risk) * 100) / 100;
}

/**
 * Проверка funding rate фильтра.
 *
 * @param fundingRate - текущий funding rate
 * @param side - сторона сделки
 * @param config - конфигурация
 * @returns true если funding rate допустим для данной стороны
 */
export function isFundingRateOk(
  fundingRate: number,
  side: 'Buy' | 'Sell',
  config: TradingConfig,
): boolean {
  // Высокий positive funding rate → не входить в лонг
  if (side === 'Buy' && fundingRate > config.maxFundingRate) {
    return false;
  }
  // Высокий negative funding rate → не входить в шорт
  if (side === 'Sell' && fundingRate < config.minFundingRate) {
    return false;
  }
  return true;
}

/**
 * Расчёт нереализованной P&L позиции.
 */
export function calculateUnrealizedPnl(
  side: 'long' | 'short',
  entryPrice: number,
  markPrice: number,
  size: number,
): number {
  if (side === 'long') {
    return (markPrice - entryPrice) * size;
  }
  return (entryPrice - markPrice) * size;
}

/**
 * Форматирование баланса и отчётов.
 */
export function formatAccountSummary(account: AccountInfo): string {
  return [
    `💰 Баланс: $${account.totalWalletBalance.toFixed(2)}`,
    `📊 Эквити: $${account.totalEquity.toFixed(2)}`,
    `📈 Доступно: $${account.availableBalance.toFixed(2)}`,
    `${account.unrealisedPnl >= 0 ? '🟢' : '🔴'} Нереал. P&L: $${account.unrealisedPnl.toFixed(2)}`,
  ].join('\n');
}
