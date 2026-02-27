/**
 * Конфигурация автоторговли crypto-trader.
 * Все лимиты, пары и параметры в одном месте.
 *
 * Мигрировано из scripts/crypto_config.js
 */

import path from 'node:path';
import type { TradingConfig } from '../shared/types.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

const config: TradingConfig = {
  // ─── Торговые пары ───────────────────────────────────────────
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

  // ─── Ордера ──────────────────────────────────────────────────
  allowedOrderTypes: ['Market', 'Limit'],

  // ─── Расписание ──────────────────────────────────────────────
  monitorIntervalMin: 10,
  reportIntervalMin: 60,
  reportOffsetMin: 10,

  // ─── Риск-менеджмент ─────────────────────────────────────────
  riskPerTrade: 0.02,
  maxDailyLoss: 500,
  maxStopsPerDay: 2,
  maxRiskPerTrade: 250,
  maxOpenPositions: 3,
  maxLeverage: 5,
  defaultLeverage: 3,
  minRR: 2,

  // ─── Управление позицией ─────────────────────────────────────
  partialCloseAtR: 1.0,
  partialClosePercent: 0.5,
  trailingStartR: 1.5,
  trailingDistanceR: 0.5,

  // ─── Фильтры входа ──────────────────────────────────────────
  maxFundingRate: 0.0005,
  minFundingRate: -0.0005,
  maxSpreadPercent: 0.1,

  // ─── Режим ───────────────────────────────────────────────────
  mode: 'execute',
  demoTrading: true,

  // ─── Таймфреймы анализа ──────────────────────────────────────
  trendTF: '240',
  zonesTF: '60',
  entryTF: '15',
  precisionTF: '5',

  // ─── Kill Switch ─────────────────────────────────────────────
  killSwitchFile: path.join(PROJECT_ROOT, 'data', 'KILL_SWITCH'),

  // ─── Файлы данных ────────────────────────────────────────────
  stateFile: path.join(PROJECT_ROOT, 'data', 'state.json'),
  eventsFile: path.join(PROJECT_ROOT, 'data', 'events.jsonl'),

  // ─── Telegram ────────────────────────────────────────────────
  telegramEnabled: true,
};

export default config;
