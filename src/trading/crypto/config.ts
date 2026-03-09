import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TradingConfig } from '../shared/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

// ═══ HyroTrader Prop Firm — МЕНЯЙ ЗДЕСЬ ═══
const ACCOUNT_BALANCE = 10_000; // Размер аккаунта HyroTrader ($5k/$10k/$25k/$50k)

const config: TradingConfig = {
  pairs: [
    // Tier 1: основные (самые ликвидные)
    'BTCUSDT',
    'ETHUSDT',
    'SOLUSDT',
    'XRPUSDT',
    'BNBUSDT',
    // Tier 2: крупные альты
    'ADAUSDT',
    'AVAXUSDT',
    'LINKUSDT',
    'DOTUSDT',
    'SUIUSDT',
    'NEARUSDT',
    'APTUSDT',
    'LTCUSDT',
    'ATOMUSDT',
    'INJUSDT',
    // Tier 3: средние альты
    'AAVEUSDT',
    'UNIUSDT',
    'ARBUSDT',
    'OPUSDT',
    'TIAUSDT',
    'RENDERUSDT',
    'FETUSDT',
    'ONDOUSDT',
    'JUPUSDT',
    'WLDUSDT',
    // Tier 4: расширенный набор
    'TONUSDT',
    'MKRUSDT',
    'ICPUSDT',
    'STXUSDT',
    'SEIUSDT',
    'PENDLEUSDT',
    'ENAUSDT',
    'EIGENUSDT',
    'THETAUSDT',
    'FTMUSDT',
    'RUNEUSDT',
    'LDOUSDT',
    'PYTHUSDT',
    'GRTUSDT',
    'ALGOUSDT',
    // Tier 5: спекулятивные
    'DOGEUSDT',
    '1000SHIBUSDT',
    '1000PEPEUSDT',
    'TRXUSDT',
    'CRVUSDT',
  ],

  allowedOrderTypes: ['Market', 'Limit'],

  monitorIntervalMin: 5,
  reportIntervalMin: 60,
  reportOffsetMin: 10,

  riskPerTrade: 0.015, // 1.5% от баланса на сделку (консервативнее лимита HyroTrader 3%)
  maxDailyLoss: ACCOUNT_BALANCE * 0.04, // 4% от баланса — оставляем запас до лимита 5%
  maxStopsPerDay: 4,
  maxRiskPerTrade: ACCOUNT_BALANCE * 0.02, // $200 при $10k (лимит HyroTrader 3% = $300)
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
  minConfidence: 35, // Реалистичный порог: live confluence scores обычно 15-40
  backtestMinConfidence: 38, // Ниже чем live: в бэктесте нет orderbook/OI/funding данных
  pairCooldownMin: 180, // 3 часа между сделками на одну пару

  // Grid entry: 3 лимитных ордера, каждый на 0.3 ATR глубже, суммарно ×1.5 объём
  gridLevels: 3,
  gridSpacingAtr: 0.3,
  gridVolumeMultiplier: 1.5,

  // Группы коррелированных пар — не более 1 позиции на группу
  ecosystemGroups: [
    ['SOLUSDT', 'AVAXUSDT', 'SUIUSDT', 'NEARUSDT', 'APTUSDT', 'SEIUSDT'], // Alt L1
    ['ETHUSDT', 'LINKUSDT', 'AAVEUSDT', 'UNIUSDT', 'LDOUSDT'], // ETH-экосистема
    ['XRPUSDT', 'ADAUSDT', 'DOTUSDT', 'ATOMUSDT', 'ALGOUSDT'], // Legacy L1
    ['ARBUSDT', 'OPUSDT', 'STXUSDT'], // L2
    ['RENDERUSDT', 'FETUSDT', 'WLDUSDT', 'THETAUSDT', 'GRTUSDT'], // AI/Infra tokens
    ['TIAUSDT', 'ONDOUSDT', 'EIGENUSDT'], // Modular/RWA
    ['DOGEUSDT', '1000SHIBUSDT', '1000PEPEUSDT'], // Meme coins
    ['JUPUSDT', 'PYTHUSDT'], // Solana DeFi
    ['PENDLEUSDT', 'ENAUSDT'], // DeFi yield
    ['TONUSDT', 'ICPUSDT'], // Alt infra
  ],

  // BTC корреляция: альты следуют за BTC
  btcCorrelationFilter: true, // Включить фильтр BTC-корреляции для альтов
  weakPairs: [
    // Только Tier 4-5: реально слабые/волатильные пары
    'SEIUSDT',
    'EIGENUSDT',
    'GRTUSDT',
    'STXUSDT',
    'DOGEUSDT',
    '1000SHIBUSDT',
    '1000PEPEUSDT',
    'TRXUSDT',
    'CRVUSDT',
  ], // Пары с повышенным порогом (только мелкие/спекулятивные)
  weakPairConfidenceBonus: 3, // Доп. порог confidence для слабых пар

  mode: 'execute',

  // ═══ HyroTrader 2-Step Challenge ═══
  propFirm: true,
  accountBalance: ACCOUNT_BALANCE,
  maxDailyLossPct: 5, // HyroTrader 2-step: 5% daily drawdown
  maxTotalDrawdownPct: 10, // HyroTrader 2-step: 10% max drawdown (trailing)
  profitTargetPct: 10, // Phase 1: 10%, Phase 2: 5%
  maxRiskPerTradePct: 3, // HyroTrader: макс 3% на сделку
  maxSingleTradeProfitPct: 40, // Одна сделка не больше 40% общей прибыли

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
