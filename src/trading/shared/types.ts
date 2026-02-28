export interface OHLC {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover?: number;
}

export interface MarketInfo {
  lastPrice: number;
  price24hPct: number;
  volume24h: number;
  turnover24h: number;
  high24h: number;
  low24h: number;
  fundingRate: number;
  nextFundingTime: string;
  bid1: number;
  ask1: number;
  lastFundingRate?: number;
  lastFundingTime?: string;
  openInterest?: number;
  oiTimestamp?: string;
  fundingSignal?: 'LONGS_OVERHEATED' | 'SHORTS_OVERHEATED' | 'NEUTRAL';
}

export interface Indicators {
  ema200: number | null;
  ema50: number | null;
  ema20: number | null;
  rsi14: number;
  atr14: number;
}

export interface Levels {
  resistance: number;
  support: number;
}

export type EmaTrend = 'BULLISH' | 'BEARISH' | 'UNKNOWN';
export type RsiZone = 'OVERBOUGHT' | 'OVERSOLD' | 'NEUTRAL';
export type PriceVsEma = 'ABOVE' | 'BELOW' | 'UNKNOWN';

export interface Bias {
  emaTrend: EmaTrend;
  priceVsEma200: PriceVsEma;
  rsiZone: RsiZone;
}

export interface MarketAnalysis {
  pair: string;
  timeframe: string;
  barsCount: number;
  source: string;
  currentPrice: number;
  lastBar: OHLC;
  indicators: Indicators;
  levels: Levels;
  bias: Bias;
  timestamp: string;
}

export type OrderSide = 'Buy' | 'Sell';
export type OrderType = 'Market' | 'Limit';
export type PositionSide = 'long' | 'short';

export interface OrderParams {
  symbol: string;
  side: OrderSide;
  orderType: OrderType;
  qty: string;
  price?: string;
  stopLoss?: string;
  takeProfit?: string;
  leverage?: number;
}

export interface OrderResult {
  orderId: string;
  symbol: string;
  side: OrderSide;
  orderType: OrderType;
  qty: string;
  price?: string;
  status: string;
}

export interface Position {
  symbol: string;
  side: PositionSide;
  size: string;
  entryPrice: string;
  markPrice: string;
  unrealisedPnl: string;
  leverage: string;
  stopLoss?: string;
  takeProfit?: string;
  liqPrice?: string;
  createdTime?: string;
}

export interface AccountInfo {
  totalEquity: number;
  availableBalance: number;
  totalWalletBalance: number;
  unrealisedPnl: number;
  currency: string;
}

export interface TradeSignal {
  pair: string;
  side: OrderSide;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  riskReward: number;
  confidence: number;
  reason: string;
  timeframe: string;
}

export interface TradeRecord {
  id: string;
  symbol: string;
  side: OrderSide;
  entryPrice: number;
  exitPrice?: number;
  stopLoss: number;
  takeProfit: number;
  qty: string;
  pnl?: number;
  result?: 'win' | 'loss' | 'breakeven';
  openTime: string;
  closeTime?: string;
}

export interface TradingState {
  date: string;
  balance: number;
  equity: number;
  dailyPnl: number;
  tradesCount: number;
  wins: number;
  losses: number;
  stopsCount: number;
  stopDay: boolean;
  positions: Position[];
  lastUpdate: string;
}

export interface TradingConfig {
  pairs: string[];
  allowedOrderTypes: OrderType[];
  monitorIntervalMin: number;
  reportIntervalMin: number;
  reportOffsetMin: number;
  riskPerTrade: number;
  maxDailyLoss: number;
  maxStopsPerDay: number;
  maxRiskPerTrade: number;
  maxOpenPositions: number;
  maxLeverage: number;
  defaultLeverage: number;
  minRR: number;
  partialCloseAtR: number;
  partialClosePercent: number;
  trailingStartR: number;
  trailingDistanceR: number;
  maxFundingRate: number;
  minFundingRate: number;
  maxSpreadPercent: number;
  mode: 'execute' | 'dry-run';
  demoTrading: boolean;
  trendTF: string;
  zonesTF: string;
  entryTF: string;
  precisionTF: string;
  killSwitchFile: string;
  stateFile: string;
  eventsFile: string;
  telegramEnabled: boolean;
}

export interface TradingEvent {
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export const TIMEFRAME_MAP: Record<string, string> = {
  '1': '1',
  '3': '3',
  '5': '5',
  '15': '15',
  '30': '30',
  '60': '60',
  '120': '120',
  '240': '240',
  '360': '360',
  '720': '720',
  D: 'D',
  W: 'W',
  M: 'M',
  '1m': '1',
  '3m': '3',
  '5m': '5',
  '15m': '15',
  '30m': '30',
  '1h': '60',
  '2h': '120',
  '4h': '240',
  '6h': '360',
  '12h': '720',
  '1d': 'D',
  '1w': 'W',
  M1: '1',
  M5: '5',
  M15: '15',
  M30: '30',
  H1: '60',
  H4: '240',
  D1: 'D',
};
