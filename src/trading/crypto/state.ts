import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../../utils/logger.js';
import type { PositionSide } from '../shared/types.js';
import config from './config.js';
import { logTradeOutcome } from './decision-journal.js';

const log = createLogger('crypto-state');

const STATE_FILE = config.stateFile;
const EVENTS_FILE = config.eventsFile;
const KILL_SWITCH_FILE = config.killSwitchFile;
const DATA_DIR = path.dirname(STATE_FILE);

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
  side: PositionSide;
  size: string;
  entryPrice: string;
  markPrice: string;
  unrealisedPnl: string;
  leverage: string;
  stopLoss?: string | undefined;
  takeProfit?: string | undefined;
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
  lastLLMCycleAt: string | null;
  balance: BalanceSnapshot;
  pairLastTrade: Record<string, string>; // symbol → ISO timestamp последнего трейда
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

export interface StoredEvent {
  ts: string;
  type: string;
  [key: string]: unknown;
}

/** Текущая дата в UTC+2 (Киев) */
function kyivDate(): string {
  const d = new Date();
  d.setUTCHours(d.getUTCHours() + 2);
  return d.toISOString().slice(0, 10);
}

function defaultState(): CryptoState {
  const today = kyivDate();
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
    lastLLMCycleAt: null,
    balance: {
      total: 0,
      available: 0,
      unrealizedPnl: 0,
      lastUpdate: null,
    },
    pairLastTrade: {},
  };
}

let _state: CryptoState | null = null;

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
      // Backward compatibility: поле могло отсутствовать в старом state.json
      if (!_state.pairLastTrade) _state.pairLastTrade = {};
      const today = kyivDate();
      if (_state.daily?.date !== today) {
        resetDaily();
      }
    } catch (e) {
      log.error(
        `Error loading state.json: ${e instanceof Error ? e.message : String(e)}, creating new`,
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
  // Atomic write: write to tmp → rename (предотвращает корруптацию при crash)
  const tmpFile = STATE_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2), 'utf-8');
  fs.renameSync(tmpFile, STATE_FILE);
}

export function get(): CryptoState {
  if (!_state) load();
  return _state!;
}

export function resetDaily(): void {
  const state = get();
  const today = kyivDate();
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
  save();
}

// Символы, уже закрытые через recordTrade в этом цикле (защита от двойного учёта)
const recentlyRecordedSymbols = new Map<string, number>(); // symbol → timestamp

export function recordTrade(trade: TradeInput): void {
  recentlyRecordedSymbols.set(trade.symbol, Date.now());
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

  // Записываем outcome в дневник трейдера для обучения LLM
  logTradeOutcome(
    trade.symbol,
    pnl,
    trade.side,
    trade.entryPrice ? parseFloat(String(trade.entryPrice)) : undefined,
    trade.exitPrice ? parseFloat(String(trade.exitPrice)) : undefined,
    trade.isStop,
  );

  checkDayLimits();
  save();
}

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

export function updatePositions(
  positions: Array<{
    symbol: string;
    side: string;
    size: string;
    entryPrice?: string | undefined;
    avgPrice?: string | undefined;
    markPrice: string;
    unrealisedPnl: string;
    leverage: string;
    stopLoss?: string | undefined;
    takeProfit?: string | undefined;
  }>,
): void {
  const s = get();
  const newSymbols = new Set(positions.map((p) => p.symbol));

  // Детекция закрытых позиций (SL/TP на Bybit или ликвидация)
  for (const old of s.positions) {
    if (!newSymbols.has(old.symbol)) {
      // Пропускаем если уже записано через recordTrade (Claude CLOSE) — защита от двойного учёта
      const recentTs = recentlyRecordedSymbols.get(old.symbol);
      if (recentTs && Date.now() - recentTs < 5 * 60_000) {
        log.info('Skipping duplicate recordTrade (already closed by bot)', { symbol: old.symbol });
        recentlyRecordedSymbols.delete(old.symbol);
        continue;
      }
      const entryPrice = parseFloat(old.entryPrice) || 0;
      const markPrice = parseFloat(old.markPrice) || 0;
      const slPrice = parseFloat(old.stopLoss ?? '0') || 0;
      const tpPrice = parseFloat(old.takeProfit ?? '0') || 0;
      const size = parseFloat(old.size) || 0;

      // Определяем: SL или TP по последнему markPrice
      const isStop =
        slPrice > 0 &&
        ((old.side === 'long' && markPrice <= slPrice * 1.002) ||
          (old.side === 'short' && markPrice >= slPrice * 0.998));

      const isTp =
        !isStop &&
        tpPrice > 0 &&
        ((old.side === 'long' && markPrice >= tpPrice * 0.998) ||
          (old.side === 'short' && markPrice <= tpPrice * 1.002));

      // Реальная цена выхода: SL/TP цена (не stale markPrice)
      const exitPrice = isStop && slPrice > 0 ? slPrice : isTp && tpPrice > 0 ? tpPrice : markPrice;

      // Пересчитываем P&L по реальной цене выхода
      const pnl =
        old.side === 'long' ? (exitPrice - entryPrice) * size : (entryPrice - exitPrice) * size;

      log.info('Position closed externally', {
        symbol: old.symbol,
        side: old.side,
        pnl: pnl.toFixed(2),
        entryPrice,
        exitPrice,
        markPrice,
        slPrice,
        tpPrice,
        trigger: isStop ? 'STOP_LOSS' : isTp ? 'TAKE_PROFIT' : 'UNKNOWN',
      });

      recordTrade({
        symbol: old.symbol,
        side: old.side,
        pnl,
        entryPrice,
        exitPrice,
        isStop,
      });

      logEvent('position_closed_by_exchange', {
        symbol: old.symbol,
        side: old.side,
        size: old.size,
        entryPrice: old.entryPrice,
        exitPrice,
        markPrice: old.markPrice,
        pnl,
        isStop,
        trigger: isStop ? 'STOP_LOSS' : isTp ? 'TAKE_PROFIT' : 'UNKNOWN',
      });
    }
  }

  s.positions = positions.map((p) => ({
    symbol: p.symbol,
    side: p.side as PositionSide,
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

export function checkDayLimits(): boolean {
  const s = get();
  const d = s.daily;

  if (d.stops >= config.maxStopsPerDay) {
    d.stopDay = true;
    d.stopDayReason = `${d.stops} stops hit (limit ${config.maxStopsPerDay})`;
    logEvent('stop_day', { reason: d.stopDayReason });
  }

  return d.stopDay;
}

export function canTrade(): { allowed: boolean; reason: string } {
  const s = get();

  if (isKillSwitchActive()) {
    return { allowed: false, reason: 'KILL_SWITCH active. Trading stopped.' };
  }

  if (s.daily.stopDay) {
    return { allowed: false, reason: `STOP_DAY: ${s.daily.stopDayReason}` };
  }

  if (config.mode !== 'execute') {
    return { allowed: false, reason: `Mode: ${config.mode}. Trading disabled.` };
  }

  if (s.positions.length >= config.maxOpenPositions) {
    return {
      allowed: false,
      reason: `Max positions: ${s.positions.length}/${config.maxOpenPositions}`,
    };
  }

  // Aggregate risk: суммарный SL-риск по всем открытым позициям
  const totalRisk = s.positions.reduce((sum, p) => {
    const entry = parseFloat(p.entryPrice) || 0;
    const sl = parseFloat(p.stopLoss ?? '0') || 0;
    const size = parseFloat(p.size) || 0;
    if (sl === 0) return sum + entry * size * 0.02; // fallback 2% если нет SL
    return sum + Math.abs(entry - sl) * size;
  }, 0);

  const maxTotalRisk = config.maxDailyLoss * 0.8; // max 80% дневного лимита в открытых позициях
  if (totalRisk >= maxTotalRisk) {
    return {
      allowed: false,
      reason: `Aggregate risk $${totalRisk.toFixed(2)} >= limit $${maxTotalRisk.toFixed(2)}`,
    };
  }

  return { allowed: true, reason: 'OK' };
}

export function calcPositionSize(entryPrice: number, stopLoss: number): number {
  const s = get();
  const balance = s.balance.total || 0;
  if (balance === 0) return 0;

  const riskAmount = Math.min(balance * config.riskPerTrade, config.maxRiskPerTrade);
  const slDistance = Math.abs(entryPrice - stopLoss);
  if (slDistance === 0) return 0;

  return riskAmount / slDistance;
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
  logEvent('kill_switch_on', { reason });
}

export function deactivateKillSwitch(): void {
  if (fs.existsSync(KILL_SWITCH_FILE)) {
    fs.unlinkSync(KILL_SWITCH_FILE);
    logEvent('kill_switch_off', {});
  }
}

const MAX_EVENTS_FILE_BYTES = 5 * 1024 * 1024;

export function logEvent(type: string, data: EventData): void {
  ensureDataDir();
  const event = {
    ts: new Date().toISOString(),
    type,
    ...data,
  };
  fs.appendFileSync(EVENTS_FILE, JSON.stringify(event) + '\n', 'utf-8');
  rotateEventsIfNeeded();
}

function rotateEventsIfNeeded(): void {
  try {
    const stats = fs.statSync(EVENTS_FILE);
    if (stats.size > MAX_EVENTS_FILE_BYTES) {
      const lines = fs.readFileSync(EVENTS_FILE, 'utf-8').trim().split('\n');
      const kept = lines.slice(-Math.floor(lines.length / 2));
      fs.writeFileSync(EVENTS_FILE, kept.join('\n') + '\n', 'utf-8');
      log.info(`Events file rotated: ${lines.length} → ${kept.length} entries`);
    }
  } catch {
    /* rotation is best-effort */
  }
}

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

export function getTodayTrades(): StoredEvent[] {
  const today = kyivDate();
  return getRecentEvents(200).filter((e) => e.type === 'trade' && e.ts?.startsWith(today));
}

export function getTodayEvents(types?: string[]): StoredEvent[] {
  const today = kyivDate();
  return getRecentEvents(500).filter((e) => {
    if (!e.ts?.startsWith(today)) return false;
    return types ? types.includes(e.type) : true;
  });
}

export function recordPairTrade(symbol: string): void {
  const s = get();
  if (!s.pairLastTrade) s.pairLastTrade = {};
  s.pairLastTrade[symbol] = new Date().toISOString();
  save();
}

export function getPairLastTrade(symbol: string): string | null {
  const s = get();
  return s.pairLastTrade?.[symbol] ?? null;
}

export function isPairCooldownActive(symbol: string, cooldownMs: number): boolean {
  const last = get().pairLastTrade?.[symbol];
  if (!last) return false;
  return Date.now() - new Date(last).getTime() < cooldownMs;
}
