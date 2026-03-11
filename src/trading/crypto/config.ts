import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TradingConfig } from '../shared/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

// ═══ HyroTrader Prop Firm — МЕНЯЙ ЗДЕСЬ ═══
const ACCOUNT_BALANCE = 10_000; // Размер аккаунта HyroTrader ($5k/$10k/$25k/$50k)

const config: TradingConfig = {
  pairs: [
    // Tier 1: топ ликвидность (>$500M/day)
    'BTCUSDT',
    'ETHUSDT',
    'SOLUSDT',
    'XRPUSDT',
    'BNBUSDT',
    'DOGEUSDT',
    // Tier 2: крупные альты ($100-500M/day)
    'ADAUSDT',
    'AVAXUSDT',
    'LINKUSDT',
    'SUIUSDT',
    'NEARUSDT',
    'APTUSDT',
    'DOTUSDT',
    'LTCUSDT',
    'ATOMUSDT',
    'INJUSDT',
    // Tier 3: средние альты ($50-100M/day)
    'AAVEUSDT',
    'UNIUSDT',
    'ARBUSDT',
    'OPUSDT',
    'RENDERUSDT',
    'FETUSDT',
    'ONDOUSDT',
    'JUPUSDT',
    'WLDUSDT',
    'TONUSDT',
    'RUNEUSDT',
  ],

  allowedOrderTypes: ['Market', 'Limit'],

  monitorIntervalMin: 2,
  reportIntervalMin: 60,
  reportOffsetMin: 10,

  riskPerTrade: 0.01, // 1% от баланса на сделку (~$100 при $10k)
  maxDailyLoss: ACCOUNT_BALANCE * 0.04, // 4% от баланса — запас до лимита 5%
  maxStopsPerDay: 4,
  maxRiskPerTrade: ACCOUNT_BALANCE * 0.02, // $200 при $10k
  maxOpenPositions: 2, // Снижено с 3: фокус на 1-2 качественные позиции
  maxLeverage: 5,
  defaultLeverage: 3,
  minRR: 1.0, // Снижено с 1.5: быстрые TP, цель +$15-20 за сделку

  // Quick profit strategy: закрываем 100% по TP, без partial close
  partialCloseAtR: 99, // Отключён (недостижимый порог) — закрываем всё сразу по TP
  partialClosePercent: 0.5,
  trailingStartR: 0.7, // Раньше начинаем тянуть SL (было 1.5R)
  trailingDistanceR: 0.3, // Теснее trailing (было 0.5R)

  maxFundingRate: 0.005,
  minFundingRate: -0.005,
  maxSpreadPercent: 0.1,
  atrSlMultiplier: 1.5, // Теснее SL (было 2.0): меньше риск = больше позиция = быстрее $15-20
  staleOrderMinutes: 30,
  minConfidence: 45, // Повышен с 20: отсекаем мусор до Claude (ARB 35% → заблокирован)
  backtestMinConfidence: 38, // Ниже чем live: в бэктесте нет orderbook/OI/funding данных
  pairCooldownMin: 240, // 4 часа между сделками на одну пару (было 3ч — WLD спамил)
  maxDailyTrades: 5, // Максимум сделок в день: 3 целевые + 2 запасные

  // Группы коррелированных пар — не более 1 позиции на группу
  ecosystemGroups: [
    ['SOLUSDT', 'AVAXUSDT', 'SUIUSDT', 'NEARUSDT', 'APTUSDT'], // Alt L1
    ['ETHUSDT', 'LINKUSDT', 'AAVEUSDT', 'UNIUSDT'], // ETH-экосистема
    ['XRPUSDT', 'ADAUSDT', 'DOTUSDT', 'ATOMUSDT'], // Legacy L1
    ['ARBUSDT', 'OPUSDT'], // L2
    ['RENDERUSDT', 'FETUSDT', 'WLDUSDT'], // AI/Infra tokens
    ['JUPUSDT', 'ONDOUSDT'], // DeFi
  ],

  // BTC корреляция: альты следуют за BTC
  btcCorrelationFilter: true,
  weakPairs: ['DOGEUSDT', 'WLDUSDT', 'RUNEUSDT'], // Пары с повышенным порогом confidence
  weakPairConfidenceBonus: 3,

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
