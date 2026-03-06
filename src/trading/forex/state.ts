import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../../utils/logger.js';
import config from './config.js';

const log = createLogger('forex-state');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../../data');
const STATE_FILE = path.join(DATA_DIR, 'forex-state.json');
const KILL_SWITCH_FILE = path.join(DATA_DIR, 'FOREX_KILL_SWITCH');

interface ForexState {
  version: number;
  lastUpdate: string;
  lastResetDate: string;
  dailyPnl: number;
  stopsCount: number;
  tradesCount: number;
  stopDay: boolean;
  stopDayReason: string | null;
  wins: number;
  losses: number;
  accountBalance: number;
}

function defaultState(): ForexState {
  const today = new Date().toISOString().slice(0, 10);
  return {
    version: 1,
    lastUpdate: new Date().toISOString(),
    lastResetDate: today,
    dailyPnl: 0,
    stopsCount: 0,
    tradesCount: 0,
    stopDay: false,
    stopDayReason: null,
    wins: 0,
    losses: 0,
    accountBalance: parseFloat(process.env.FTMO_INITIAL_BALANCE ?? '10000'),
  };
}

let _state: ForexState | null = null;

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function loadState(): ForexState {
  ensureDataDir();

  if (fs.existsSync(STATE_FILE)) {
    try {
      _state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as ForexState;
      const today = new Date().toISOString().slice(0, 10);
      if (_state.lastResetDate !== today) {
        resetDaily();
      }
    } catch (error: unknown) {
      log.error('Ошибка чтения forex-state.json, создаём новый', {
        error: error instanceof Error ? error.message : String(error),
      });
      _state = defaultState();
    }
  } else {
    _state = defaultState();
  }

  return _state;
}

export function saveState(): void {
  ensureDataDir();
  const state = getState();
  state.lastUpdate = new Date().toISOString();

  // Atomic write: tmp → rename (предотвращает корруптацию при crash)
  const tmpFile = STATE_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2), 'utf-8');
  fs.renameSync(tmpFile, STATE_FILE);
}

export function getState(): ForexState {
  if (!_state) loadState();
  return _state!;
}

export function resetDaily(): void {
  const state = getState();
  const today = new Date().toISOString().slice(0, 10);

  log.info('Сброс дневных счётчиков', { prevDate: state.lastResetDate, today });

  state.lastResetDate = today;
  state.dailyPnl = 0;
  state.stopsCount = 0;
  state.tradesCount = 0;
  state.stopDay = false;
  state.stopDayReason = null;
  state.wins = 0;
  state.losses = 0;

  saveState();
}

export function recordTrade(pnl: number, isStop: boolean): void {
  const state = getState();

  state.tradesCount++;
  state.dailyPnl += pnl;

  if (pnl > 0) {
    state.wins++;
  } else {
    state.losses++;
  }

  if (isStop) {
    state.stopsCount++;
    log.info('Стоп зафиксирован', {
      stopsCount: state.stopsCount,
      maxStops: 3,
      pnl,
    });
  }

  // Проверяем лимиты после записи
  checkDayLimits();
  saveState();
}

export function updateAccountBalance(balance: number): void {
  const state = getState();
  state.accountBalance = balance;
  saveState();
}

function checkDayLimits(): void {
  const state = getState();
  if (state.stopDay) return;

  const balance = state.accountBalance;

  // Проверка дневной просадки (4%)
  const dailyDrawdownPct = balance > 0 ? (Math.abs(state.dailyPnl) / balance) * 100 : 0;
  if (state.dailyPnl < 0 && dailyDrawdownPct >= config.maxDailyDrawdownPct) {
    state.stopDay = true;
    state.stopDayReason = `Дневная просадка ${dailyDrawdownPct.toFixed(2)}% >= лимита ${config.maxDailyDrawdownPct}% (P&L: ${state.dailyPnl.toFixed(2)})`;
    log.warn('STOP DAY: дневная просадка', { reason: state.stopDayReason });
    return;
  }

  // Проверка лимита стопов (3 стопа)
  if (state.stopsCount >= 3) {
    state.stopDay = true;
    state.stopDayReason = `Достигнуто максимальное число стопов: ${state.stopsCount}`;
    log.warn('STOP DAY: лимит стопов', { reason: state.stopDayReason });
    return;
  }

  // Проверка лимита сделок
  if (state.tradesCount >= config.maxTradesPerDay) {
    state.stopDay = true;
    state.stopDayReason = `Достигнут лимит сделок за день: ${state.tradesCount}/${config.maxTradesPerDay}`;
    log.warn('STOP DAY: лимит сделок', { reason: state.stopDayReason });
  }
}

export function isKillSwitchActive(): boolean {
  return fs.existsSync(KILL_SWITCH_FILE);
}

export function activateKillSwitch(reason: string = 'manual'): void {
  ensureDataDir();
  const content = JSON.stringify({
    activated: new Date().toISOString(),
    reason,
  });
  fs.writeFileSync(KILL_SWITCH_FILE, content, 'utf-8');
  log.warn('KILL SWITCH активирован', { reason });
}

export function deactivateKillSwitch(): void {
  if (fs.existsSync(KILL_SWITCH_FILE)) {
    fs.unlinkSync(KILL_SWITCH_FILE);
    log.info('Kill switch деактивирован');
  }
}

export interface CanTradeResult {
  allowed: boolean;
  reason: string;
}

export function canTrade(): CanTradeResult {
  const state = getState();

  if (isKillSwitchActive()) {
    return { allowed: false, reason: 'KILL_SWITCH активен. Торговля остановлена.' };
  }

  if (state.stopDay) {
    return { allowed: false, reason: `STOP_DAY: ${state.stopDayReason}` };
  }

  if (state.tradesCount >= config.maxTradesPerDay) {
    return {
      allowed: false,
      reason: `Лимит сделок за день: ${state.tradesCount}/${config.maxTradesPerDay}`,
    };
  }

  const balance = state.accountBalance;

  // Проверка дневной просадки (4%)
  if (state.dailyPnl < 0 && balance > 0) {
    const dailyDrawdownPct = (Math.abs(state.dailyPnl) / balance) * 100;
    if (dailyDrawdownPct >= config.maxDailyDrawdownPct) {
      return {
        allowed: false,
        reason: `Дневная просадка ${dailyDrawdownPct.toFixed(2)}% >= лимита ${config.maxDailyDrawdownPct}%`,
      };
    }
  }

  // Проверка суммарной просадки (8%) — от начального баланса
  const initialBalance = parseFloat(process.env.FTMO_INITIAL_BALANCE ?? '10000');
  if (balance > 0 && initialBalance > 0) {
    const totalDrawdownPct = ((initialBalance - balance) / initialBalance) * 100;
    if (totalDrawdownPct >= config.maxTotalDrawdownPct) {
      return {
        allowed: false,
        reason: `Суммарная просадка ${totalDrawdownPct.toFixed(2)}% >= лимита ${config.maxTotalDrawdownPct}%`,
      };
    }
  }

  if (state.stopsCount >= 3) {
    return {
      allowed: false,
      reason: `Достигнуто максимальное число стопов: ${state.stopsCount}/3`,
    };
  }

  return { allowed: true, reason: 'OK' };
}
