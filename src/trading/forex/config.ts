export interface ForexConfig {
  mode: 'execute' | 'dry-run';
  pairs: string[];
  defaultLeverage: number;
  maxRiskPerTradePct: number;
  maxOpenPositions: number;
  maxTradesPerDay: number;
  maxDailyDrawdownPct: number;
  maxTotalDrawdownPct: number;
  minRR: number;
  partialClosePercent: number;
  partialCloseAtR: number;
  trailingStartR: number;
  trailingDistanceR: number;
  trendTimeframe: string;
  entryTimeframe: string;
  environment: 'demo' | 'live';
}

const config: ForexConfig = {
  mode: (process.env.FOREX_MODE as 'execute' | 'dry-run') ?? 'dry-run',

  pairs: ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'NZDUSD', 'EURGBP', 'XAUUSD'],

  defaultLeverage: 30,

  maxRiskPerTradePct: 1.0,
  maxOpenPositions: 3,
  maxTradesPerDay: 5,
  maxDailyDrawdownPct: 4.0,
  maxTotalDrawdownPct: 8.0,
  minRR: 2.0,

  partialClosePercent: 0.5,
  partialCloseAtR: 1.0,
  trailingStartR: 1.5,
  trailingDistanceR: 0.75,

  trendTimeframe: 'H4',
  entryTimeframe: 'M15',

  environment: (process.env.CTRADER_ENVIRONMENT as 'demo' | 'live') ?? 'demo',
};

export default config;
