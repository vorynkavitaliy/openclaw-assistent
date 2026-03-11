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
  ema21: number | null;
  ema9: number | null;
  ema3: number | null;
  rsi14: number;
  atr14: number;
  roc6: number; // Rate of Change за 6 свечей (%)
  roc2: number; // Rate of Change за 2 свечи (30 мин на M15)
  impulse: number; // Сила импульса последней свечи (0 = нет, >0 bullish, <0 bearish)
  obv?: number;
  bb?: BollingerBands;
  ichimoku?: IchimokuCloud;
  candlePatterns?: CandlestickPattern[];
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
  price?: string | undefined;
  stopLoss?: string | undefined;
  takeProfit?: string | undefined;
  leverage?: number | undefined;
}

export interface OrderResult {
  orderId: string;
  symbol: string;
  side: OrderSide;
  orderType: OrderType;
  qty: string;
  price?: string | undefined;
  sl?: string | undefined;
  tp?: string | undefined;
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
  stopLoss?: string | undefined;
  takeProfit?: string | undefined;
  liqPrice?: string | undefined;
  createdTime?: string | undefined;
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

// ─── Confluence Scoring System ───────────────────────────────────

export interface OrderbookData {
  bids: Array<{ price: number; qty: number }>;
  asks: Array<{ price: number; qty: number }>;
  bidWallPrice: number;
  askWallPrice: number;
  imbalance: number; // -1..+1 (bid/ask volume ratio)
  spread: number;
  timestamp: string;
}

export interface OIDataPoint {
  timestamp: string;
  openInterest: number;
  delta: number;
}

export interface FundingDataPoint {
  timestamp: string;
  rate: number;
}

export type MarketRegime = 'STRONG_TREND' | 'WEAK_TREND' | 'RANGING' | 'VOLATILE' | 'CHOPPY';

export type ConfluenceSignal = 'STRONG_LONG' | 'LONG' | 'NEUTRAL' | 'SHORT' | 'STRONG_SHORT';

export interface ConfluenceScore {
  total: number; // -100..+100
  trend: number; // -10..+10
  momentum: number; // -10..+10
  volume: number; // -10..+10
  structure: number; // -10..+10
  orderflow: number; // -10..+10
  regime: number; // -10..+10
  signal: ConfluenceSignal;
  confidence: number; // 0..100
  details: string[];
  candlePatterns?: number; // -10..+10
}

export interface VolumeProfile {
  vwap: number;
  volumeDelta: number; // buy_vol - sell_vol
  relativeVolume: number; // current / average
  highVolumeNodes: number[];
  avgCandleVolumeUsd: number; // средний объём свечи в USD для нормализации
}

export interface PivotLevels {
  pivotPoint: number;
  r1: number;
  r2: number;
  r3: number;
  s1: number;
  s2: number;
  s3: number;
}

export interface VolumeClusterLevels {
  highVolumeLevels: number[];
  pocPrice: number; // Point of Control
  valueAreaHigh: number;
  valueAreaLow: number;
}

export interface MACDResult {
  macd: number;
  signal: number;
  histogram: number;
}

export interface StochRSIResult {
  k: number;
  d: number;
}

export interface BollingerBands {
  upper: number;
  lower: number;
  middle: number; // SMA
  width: number; // (upper - lower) / middle * 100
  percentB: number; // (close - lower) / (upper - lower) * 100
  squeeze: boolean; // width < 2%
}

export interface IchimokuCloud {
  tenkan: number; // Conversion Line (9)
  kijun: number; // Base Line (26)
  senkouA: number; // Leading Span A
  senkouB: number; // Leading Span B
  priceAboveCloud: boolean;
  priceBelowCloud: boolean;
  cloudBullish: boolean; // senkouA > senkouB
  tkCross: 'BULLISH' | 'BEARISH' | 'NONE'; // tenkan vs kijun
}

export interface CandlestickPattern {
  name: string;
  direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  strength: 1 | 2 | 3; // 1=weak, 2=moderate, 3=strong
}

export interface ConfluenceConfig {
  trendWeight: number;
  momentumWeight: number;
  volumeWeight: number;
  structureWeight: number;
  orderflowWeight: number;
  regimeWeight: number;
  candlePatternsWeight: number;
  entryThreshold: number; // min score для входа
  strongThreshold: number; // min score для auto-trade
}

export interface RecentTrade {
  price: number;
  qty: number;
  side: 'Buy' | 'Sell';
  time: string;
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

export interface BaseTradingConfig {
  mode: 'execute' | 'dry-run';
  pairs: string[];
  defaultLeverage: number;
  maxOpenPositions: number;
  minRR: number;
  partialCloseAtR: number;
  partialClosePercent: number;
  trailingStartR: number;
  trailingDistanceR: number;
}

export interface TradingConfig extends BaseTradingConfig {
  allowedOrderTypes: OrderType[];
  monitorIntervalMin: number;
  reportIntervalMin: number;
  reportOffsetMin: number;
  riskPerTrade: number;
  maxDailyLoss: number;
  maxStopsPerDay: number;
  maxRiskPerTrade: number;
  maxLeverage: number;
  maxFundingRate: number;
  minFundingRate: number;
  maxSpreadPercent: number;
  atrSlMultiplier: number; // ATR multiplier for SL distance (default 2.0)
  staleOrderMinutes: number; // Cancel limit orders older than N minutes
  ecosystemGroups: string[][]; // Correlated pairs groups (max 1 position per group)
  btcCorrelationFilter: boolean; // Filter alts against BTC trend
  weakPairs: string[]; // Pairs requiring higher confidence
  weakPairConfidenceBonus: number; // Extra confidence % for weak pairs
  minConfidence: number; // Minimum confidence % to enter (default 50)
  backtestMinConfidence: number; // Minimum confidence % for backtester (lower due to missing live data)
  pairCooldownMin: number; // Cooldown between trades on same pair (minutes)
  maxDailyTrades: number; // Maximum trades per day (prevents overtrading)
  // Prop firm settings
  propFirm: boolean; // Включён ли режим prop firm
  accountBalance: number; // Начальный баланс аккаунта (для расчёта лимитов)
  maxDailyLossPct: number; // Max daily drawdown % (HyroTrader 2-step: 5%)
  maxTotalDrawdownPct: number; // Max total drawdown % (HyroTrader 2-step: 10%)
  profitTargetPct: number; // Profit target % (HyroTrader phase 1: 10%)
  maxRiskPerTradePct: number; // Max risk per trade % от начального баланса (HyroTrader: 3%)
  maxSingleTradeProfitPct: number; // Max profit from single trade as % of total profit (HyroTrader: 40%)
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
