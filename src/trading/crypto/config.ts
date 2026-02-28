import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TradingConfig } from '../shared/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

const config: TradingConfig = {
  pairs: [
    'BTCUSDT',
    'ETHUSDT',
    'SOLUSDT',
    'XRPUSDT',
    'DOGEUSDT',
    'AVAXUSDT',
    'LINKUSDT',
    'ADAUSDT',
    'DOTUSDT',
    'MATICUSDT',
    'ARBUSDT',
    'OPUSDT',
  ],

  allowedOrderTypes: ['Market', 'Limit'],

  monitorIntervalMin: 10,
  reportIntervalMin: 60,
  reportOffsetMin: 10,

  riskPerTrade: 0.02,
  maxDailyLoss: 500,
  maxStopsPerDay: 2,
  maxRiskPerTrade: 250,
  maxOpenPositions: 3,
  maxLeverage: 5,
  defaultLeverage: 3,
  minRR: 2,

  partialCloseAtR: 1.0,
  partialClosePercent: 0.5,
  trailingStartR: 1.5,
  trailingDistanceR: 0.5,

  maxFundingRate: 0.0005,
  minFundingRate: -0.0005,
  maxSpreadPercent: 0.1,

  mode: 'execute',
  demoTrading: true,

  trendTF: '240',
  zonesTF: '60',
  entryTF: '15',
  precisionTF: '5',

  killSwitchFile: path.join(PROJECT_ROOT, 'data', 'KILL_SWITCH'),

  stateFile: path.join(PROJECT_ROOT, 'data', 'state.json'),
  eventsFile: path.join(PROJECT_ROOT, 'data', 'events.jsonl'),

  telegramEnabled: true,
};

export default config;
