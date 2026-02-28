import type { AccountInfo, Position, TradingConfig } from './types.js';

export interface PositionSizeResult {
  qty: number;
  riskAmount: number;
  stopDistance: number;
  leverage: number;
}

export interface CanTradeResult {
  allowed: boolean;
  reason: string;
}

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

  const riskFromPercent = balance * config.riskPerTrade;
  const riskAmount = Math.min(riskFromPercent, config.maxRiskPerTrade);
  const qty = riskAmount / stopDistance;

  return { qty, riskAmount, stopDistance, leverage: config.defaultLeverage };
}

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
    return { allowed: false, reason: 'Kill switch active' };
  }

  if (state.stopDay) {
    return { allowed: false, reason: 'Stop day: trading suspended' };
  }

  if (state.stopsCount >= config.maxStopsPerDay) {
    return {
      allowed: false,
      reason: `Stop limit reached: ${state.stopsCount}/${config.maxStopsPerDay}`,
    };
  }

  if (state.dailyPnl <= -config.maxDailyLoss) {
    return {
      allowed: false,
      reason: `Daily loss limit reached: $${Math.abs(state.dailyPnl)}`,
    };
  }

  if (state.positions.length >= config.maxOpenPositions) {
    return {
      allowed: false,
      reason: `Position limit reached: ${state.positions.length}/${config.maxOpenPositions}`,
    };
  }

  return { allowed: true, reason: 'OK' };
}

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

export function calculateRiskReward(entry: number, stopLoss: number, takeProfit: number): number {
  const risk = Math.abs(entry - stopLoss);
  const reward = Math.abs(takeProfit - entry);

  if (risk === 0) return 0;

  return Math.round((reward / risk) * 100) / 100;
}

export function isFundingRateOk(
  fundingRate: number,
  side: 'Buy' | 'Sell',
  config: TradingConfig,
): boolean {
  if (side === 'Buy' && fundingRate > config.maxFundingRate) return false;
  if (side === 'Sell' && fundingRate < config.minFundingRate) return false;

  return true;
}

export function calculateUnrealizedPnl(
  side: 'long' | 'short',
  entryPrice: number,
  markPrice: number,
  size: number,
): number {
  if (side === 'long') return (markPrice - entryPrice) * size;

  return (entryPrice - markPrice) * size;
}

export function formatAccountSummary(account: AccountInfo): string {
  const pnlIcon = account.unrealisedPnl >= 0 ? '+' : '';

  return [
    `Balance:   $${account.totalWalletBalance.toFixed(2)}`,
    `Equity:    $${account.totalEquity.toFixed(2)}`,
    `Available: $${account.availableBalance.toFixed(2)}`,
    `Unreal PnL: ${pnlIcon}$${account.unrealisedPnl.toFixed(2)}`,
  ].join('\n');
}
