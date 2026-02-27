/**
 * Crypto State Manager — управление состоянием между запусками.
 *
 * Хранит:
 *   - Дневная статистика: trades, stops, PnL
 *   - Kill-switch / stop-day
 *   - Открытые позиции snapshot
 *   - События (events.jsonl)
 *
 * Мигрировано из scripts/crypto_state.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../../utils/logger.js';
import config from './config.js';

const log = createLogger('crypto-state');

// ─── Пути ─────────────────────────────────────────────────────

const STATE_FILE = config.stateFile;
const EVENTS_FILE = config.eventsFile;
const KILL_SWITCH_FILE = config.killSwitchFile;
const DATA_DIR = path.dirname(STATE_FILE);

// ─── Типы ─────────────────────────────────────────────────────

interface DailyStats {
  date: string;
  trades: number;
  wins: number;
  losses: number;
  stops: number;
  totalPnl: number;
  realizedPnl: number;
  fees: number;
  maxDrawdown: number;
  stopDay: boolean;
  stopDayReason: string | null;
}

interface BalanceSnapshot {
  total: number;
  available: number;
  unrealizedPnl: number;
  lastUpdate: string | null;
}

interface PositionSnapshot {
  symbol: string;
  side: string;
  size: string;
  entryPrice: string;
  markPrice: string;
  unrealisedPnl: string;
  leverage: string;
  stopLoss?: string;
  takeProfit?: string;
}

interface CryptoState {
  version: number;
  lastUpdate: string;
  today: string;
  daily: DailyStats;
  positions: PositionSnapshot[];
  pendingSignals: unknown[];
  lastMonitor: string | null;
  lastReport: string | null;
  balance: BalanceSnapshot;
}

interface TradeInput {
  symbol: string;
  side: string;
  pnl: number | string;
  fee?: number | string;
  isStop?: boolean;
  entryPrice?: number | string;
  exitPrice?: number | string;
  qty?: string;
}

interface EventData {
  [key: string]: unknown;
}

interface StoredEvent {
  ts: string;
  type: string;
  [key: string]: unknown;
}

// ─── Инициализация ────────────────────────────────────────────

function defaultState(): CryptoState {
  const today = new Date().toISOString().slice(0, 10);
  return {
    version: 1,
    lastUpdate: new Date().toISOString(),
    today,
    daily: {
      date: today,
      trades: 0,
      wins: 0,
      losses: 0,
      stops: 0,
      totalPnl: 0,
      realizedPnl: 0,
      fees: 0,
      maxDrawdown: 0,
      stopDay: false,
      stopDayReason: null,
    },
    positions: [],
    pendingSignals: [],
    lastMonitor: null,
    lastReport: null,
    balance: {
      total: 0,
      available: 0,
      unrealizedPnl: 0,
      lastUpdate: null,
    },
  };
}

let _state: CryptoState | null = null;

// ─── Файловые операции ────────────────────────────────────────

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function load(): CryptoState {
  ensureDataDir();
  if (fs.existsSync(STATE_FILE)) {
    try {
      _state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as CryptoState;
      const today = new Date().toISOString().slice(0, 10);
      if (_state.daily?.date !== today) {
        resetDaily();
      }
    } catch (e) {
      log.error(
        `Ошибка загрузки state.json: ${e instanceof Error ? e.message : String(e)}, создаю новый`,
      );
      _state = defaultState();
    }
  } else {
    _state = defaultState();
  }
  return _state;
}

export function save(): void {
  ensureDataDir();
  const state = get();
  state.lastUpdate = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

export function get(): CryptoState {
  if (!_state) load();
  return _state!;
}

// ─── Дневные операции ─────────────────────────────────────────

export function resetDaily(): void {
  const state = get();
  const today = new Date().toISOString().slice(0, 10);
  state.today = today;
  state.daily = {
    date: today,
    trades: 0,
    wins: 0,
    losses: 0,
    stops: 0,
    totalPnl: 0,
    realizedPnl: 0,
    fees: 0,
    maxDrawdown: 0,
    stopDay: false,
    stopDayReason: null,
  };
}

/**
 * Записать завершённую сделку.
 */
export function recordTrade(trade: TradeInput): void {
  const s = get();
  s.daily.trades++;
  const pnl = typeof trade.pnl === 'string' ? parseFloat(trade.pnl) : trade.pnl;
  const fee = typeof trade.fee === 'string' ? parseFloat(trade.fee) : (trade.fee ?? 0);
  s.daily.totalPnl += pnl;
  s.daily.realizedPnl += pnl - fee;
  s.daily.fees += fee;

  if (pnl > 0) {
    s.daily.wins++;
  } else {
    s.daily.losses++;
  }

  if (trade.isStop) {
    s.daily.stops++;
  }

  if (s.daily.totalPnl < s.daily.maxDrawdown) {
    s.daily.maxDrawdown = s.daily.totalPnl;
  }

  logEvent('trade', trade as unknown as EventData);
  checkDayLimits();
  save();
}

/**
 * Обновить баланс.
 */
export function updateBalance(balance: {
  totalEquity?: string | number;
  totalWalletBalance?: string | number;
  totalAvailableBalance?: string | number;
  totalPerpUPL?: string | number;
}): void {
  const s = get();
  s.balance = {
    total:
      parseFloat(String(balance.totalEquity ?? 0)) ||
      parseFloat(String(balance.totalWalletBalance ?? 0)) ||
      0,
    available: parseFloat(String(balance.totalAvailableBalance ?? 0)) || 0,
    unrealizedPnl: parseFloat(String(balance.totalPerpUPL ?? 0)) || 0,
    lastUpdate: new Date().toISOString(),
  };
  save();
}

/**
 * Обновить снапшот позиций.
 */
export function updatePositions(
  positions: Array<{
    symbol: string;
    side: string;
    size: string;
    entryPrice?: string;
    avgPrice?: string;
    markPrice: string;
    unrealisedPnl: string;
    leverage: string;
    stopLoss?: string;
    takeProfit?: string;
  }>,
): void {
  const s = get();
  s.positions = positions.map((p) => ({
    symbol: p.symbol,
    side: p.side,
    size: p.size,
    entryPrice: p.entryPrice ?? p.avgPrice ?? '0',
    markPrice: p.markPrice,
    unrealisedPnl: p.unrealisedPnl,
    leverage: p.leverage,
    stopLoss: p.stopLoss,
    takeProfit: p.takeProfit,
  }));
  save();
}

/**
 * Проверить дневные лимиты → stop-day.
 */
export function checkDayLimits(): boolean {
  const s = get();
  const d = s.daily;

  if (d.totalPnl <= -config.maxDailyLoss) {
    d.stopDay = true;
    d.stopDayReason = `Дневной убыток достиг $${Math.abs(d.totalPnl).toFixed(2)} (лимит $${config.maxDailyLoss})`;
    logEvent('stop_day', { reason: d.stopDayReason });
  }

  if (d.stops >= config.maxStopsPerDay) {
    d.stopDay = true;
    d.stopDayReason = `${d.stops} стопов (лимит ${config.maxStopsPerDay})`;
    logEvent('stop_day', { reason: d.stopDayReason });
  }

  return d.stopDay;
}

/**
 * Можно ли торговать?
 */
export function canTrade(): { allowed: boolean; reason: string } {
  const s = get();

  if (isKillSwitchActive()) {
    return { allowed: false, reason: 'KILL_SWITCH активен. Торговля остановлена.' };
  }

  if (s.daily.stopDay) {
    return { allowed: false, reason: `СТОП-ДЕНЬ: ${s.daily.stopDayReason}` };
  }

  if (config.mode !== 'execute') {
    return { allowed: false, reason: `Режим: ${config.mode}. Торговля отключена.` };
  }

  if (s.positions.length >= config.maxOpenPositions) {
    return {
      allowed: false,
      reason: `Макс позиций: ${s.positions.length}/${config.maxOpenPositions}`,
    };
  }

  return { allowed: true, reason: 'OK' };
}

/**
 * Рассчитать размер позиции.
 */
export function calcPositionSize(entryPrice: number, stopLoss: number): number {
  const s = get();
  const balance = s.balance.total || 0;
  if (balance === 0) return 0;

  const riskAmount = Math.min(balance * config.riskPerTrade, config.maxRiskPerTrade);
  const slDistance = Math.abs(entryPrice - stopLoss);
  if (slDistance === 0) return 0;

  return riskAmount / slDistance;
}

// ─── Kill Switch ──────────────────────────────────────────────

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
  logEvent('kill_switch_on', { reason });
}

export function deactivateKillSwitch(): void {
  if (fs.existsSync(KILL_SWITCH_FILE)) {
    fs.unlinkSync(KILL_SWITCH_FILE);
    logEvent('kill_switch_off', {});
  }
}

// ─── Events Log (JSONL) ──────────────────────────────────────

export function logEvent(type: string, data: EventData): void {
  ensureDataDir();
  const event = {
    ts: new Date().toISOString(),
    type,
    ...data,
  };
  fs.appendFileSync(EVENTS_FILE, JSON.stringify(event) + '\n', 'utf-8');
}

/**
 * Получить последние события.
 */
export function getRecentEvents(count: number = 50): StoredEvent[] {
  if (!fs.existsSync(EVENTS_FILE)) return [];
  const lines = fs.readFileSync(EVENTS_FILE, 'utf-8').trim().split('\n').filter(Boolean);
  return lines
    .slice(-count)
    .map((line: string) => {
      try {
        return JSON.parse(line) as StoredEvent;
      } catch {
        return null;
      }
    })
    .filter((e: StoredEvent | null): e is StoredEvent => e !== null);
}

/**
 * Получить сделки за сегодня.
 */
export function getTodayTrades(): StoredEvent[] {
  const today = new Date().toISOString().slice(0, 10);
  return getRecentEvents(200).filter((e) => e.type === 'trade' && e.ts?.startsWith(today));
}
