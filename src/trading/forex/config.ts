import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BaseTradingConfig } from '../shared/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

export interface ForexConfig extends BaseTradingConfig {
  maxRiskPerTradePct: number;
  maxTradesPerDay: number;
  maxStopsPerDay: number;
  maxDailyDrawdownPct: number;
  maxTotalDrawdownPct: number;
  atrSlMultiplier: number;
  minSlPips: number;
  trendTimeframe: string;
  entryTimeframe: string;
  environment: 'demo' | 'live';
  minConfidence: number;
  stateFile: string;
  healthFile: string;
  decisionsFile: string;
  positionMetaFile: string;
  killSwitchFile: string;
}

const config: ForexConfig = {
  mode: (process.env.FOREX_MODE as 'execute' | 'dry-run') ?? 'dry-run',

  pairs: ['EURUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'XAUUSD', 'EURJPY', 'GBPJPY', 'USDCHF'],

  defaultLeverage: 30,

  maxRiskPerTradePct: 3.0,
  maxOpenPositions: 3,
  maxTradesPerDay: 5,
  maxStopsPerDay: 3,
  maxDailyDrawdownPct: 4.0,
  maxTotalDrawdownPct: 8.0,
  atrSlMultiplier: 2.0,
  minSlPips: 10,
  minRR: 2.0,
  minConfidence: 30,

  partialClosePercent: 0.5,
  partialCloseAtR: 1.0,
  trailingStartR: 1.5,
  trailingDistanceR: 0.75,

  trendTimeframe: 'H4',
  entryTimeframe: 'M15',

  environment: (process.env.CTRADER_ENVIRONMENT as 'demo' | 'live') ?? 'demo',

  stateFile: path.join(PROJECT_ROOT, 'data', 'forex-state.json'),
  healthFile: path.join(PROJECT_ROOT, 'data', 'forex-health.json'),
  decisionsFile: path.join(PROJECT_ROOT, 'data', 'forex-decisions.jsonl'),
  positionMetaFile: path.join(PROJECT_ROOT, 'data', 'forex-position-meta.json'),
  killSwitchFile: path.join(PROJECT_ROOT, 'data', 'FOREX_KILL_SWITCH'),
};

export default config;
