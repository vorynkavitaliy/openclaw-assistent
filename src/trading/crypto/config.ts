import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TradingConfig } from '../shared/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

const config: TradingConfig = {
  pairs: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT', 'LINKUSDT', 'AVAXUSDT', 'SUIUSDT'],

  allowedOrderTypes: ['Market', 'Limit'],

  monitorIntervalMin: 5,
  reportIntervalMin: 60,
  reportOffsetMin: 10,

  riskPerTrade: 0.01,
  maxDailyLoss: 400,
  maxStopsPerDay: 3,
  maxRiskPerTrade: 200,
  maxOpenPositions: 3,
  maxLeverage: 5,
  defaultLeverage: 3,
  minRR: 1.5,

  partialCloseAtR: 1.0,
  partialClosePercent: 0.5,
  trailingStartR: 1.5,
  trailingDistanceR: 0.5,

  maxFundingRate: 0.005,
  minFundingRate: -0.005,
  maxSpreadPercent: 0.1,
  atrSlMultiplier: 2.0,
  staleOrderMinutes: 30,
  minConfidence: 30,
  pairCooldownMin: 180, // 3 часа между сделками на одну пару

  // Grid entry: 3 лимитных ордера, каждый на 0.3 ATR глубже, суммарно ×1.5 объём
  gridLevels: 3,
  gridSpacingAtr: 0.3,
  gridVolumeMultiplier: 1.5,

  // Группы коррелированных пар — не более 1 позиции на группу
  ecosystemGroups: [
    ['SOLUSDT', 'AVAXUSDT', 'SUIUSDT'], // Alt L1
    ['ETHUSDT', 'LINKUSDT'], // ETH-экосистема
  ],

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
