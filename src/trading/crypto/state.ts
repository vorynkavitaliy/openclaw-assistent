import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../../utils/logger.js';
import type { PositionSide } from '../shared/types.js';
import config from './config.js';
import { logTradeOutcome } from './decision-journal.js';
import { closeAllPositions } from './bybit-client.js';

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
  winStreak: number;
  lossStreak: number;
  // Gamification — XP система мотивации
  xp: number; // Дневные очки (за качество сделок)
  xpHistory: XpEvent[]; // Лог начислений (макс 30 записей)
}

interface XpEvent {
  ts: string;
  delta: number;
  reason: string;
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
  openedAt?: string | undefined; // ISO timestamp когда позиция была открыта
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
  peakBalance: number; // Максимальный баланс за всё время (для trailing max drawdown)
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

/** Текущая дата по Киевскому времени (корректная DST) */
function kyivDate(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' });
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
      winStreak: 0,
      lossStreak: 0,
      xp: 0,
      xpHistory: [],
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
    peakBalance: config.accountBalance,
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
      if (!_state.peakBalance) _state.peakBalance = _state.balance?.total || config.accountBalance;
      _state.daily.winStreak ??= 0;
      _state.daily.lossStreak ??= 0;
      _state.daily.xp ??= 0;
      _state.daily.xpHistory ??= [];
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
    winStreak: 0,
    lossStreak: 0,
    xp: 0,
    xpHistory: [],
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
    s.daily.winStreak++;
    s.daily.lossStreak = 0;
  } else {
    s.daily.losses++;
    s.daily.lossStreak++;
    s.daily.winStreak = 0;
  }

  if (trade.isStop) {
    s.daily.stops++;
  }

  if (s.daily.totalPnl < s.daily.maxDrawdown) {
    s.daily.maxDrawdown = s.daily.totalPnl;
  }

  logEvent('trade', trade as unknown as EventData);

  // XP система: начисляем очки за качество сделки
  awardTradeXP(trade);

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
  // Обновляем peak balance для trailing max drawdown (только при положительном балансе)
  if (s.balance.total > 0) {
    s.peakBalance = Math.max(s.peakBalance || s.balance.total, s.balance.total);
  }
  checkDayLimits();
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

  // Сохраняем openedAt из предыдущих позиций, для новых — текущее время
  const oldPositionMap = new Map(s.positions.map((p) => [p.symbol, p]));
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
    openedAt: oldPositionMap.get(p.symbol)?.openedAt ?? new Date().toISOString(),
  }));
  save();
}

export function checkDayLimits(): boolean {
  const s = get();
  const d = s.daily;

  if (d.stopDay) return true; // Уже остановлен

  if (d.stops >= config.maxStopsPerDay) {
    d.stopDay = true;
    d.stopDayReason = `${d.stops} стопов (лимит ${config.maxStopsPerDay})`;
    logEvent('stop_day', { reason: d.stopDayReason });
    log.warn('STOP DAY: достигнут лимит стопов', {
      stops: d.stops,
      maxStopsPerDay: config.maxStopsPerDay,
    });
    void triggerStopDayClose(d.stopDayReason);
  }

  if (d.stopDay) return true; // Проверяем снова после первого if

  // Equity DD: realized убыток + текущие unrealized убытки (open positions)
  const equityLoss =
    Math.abs(Math.min(0, d.realizedPnl)) + Math.max(0, -(s.balance.unrealizedPnl ?? 0));

  if (equityLoss >= config.maxDailyLoss) {
    d.stopDay = true;
    d.stopDayReason = `Equity убыток $${equityLoss.toFixed(2)} >= дневного лимита $${config.maxDailyLoss.toFixed(0)}`;
    logEvent('stop_day', {
      reason: d.stopDayReason,
      realizedPnl: d.realizedPnl,
      unrealizedPnl: s.balance.unrealizedPnl,
      equityLoss,
    });
    log.warn('STOP DAY: equity убыток достиг дневного лимита', {
      equityLoss: equityLoss.toFixed(2),
      realizedPnl: d.realizedPnl,
      unrealizedPnl: s.balance.unrealizedPnl,
      maxDailyLoss: config.maxDailyLoss,
    });
    void triggerStopDayClose(d.stopDayReason);
  }

  if (d.stopDay) return true; // Проверяем снова после второго if

  // Trailing Max Drawdown: peak equity - current equity >= maxTotalDrawdownPct %
  const currentEquity = s.balance.total;
  const peakBalance = s.peakBalance || config.accountBalance;
  const drawdown = peakBalance - currentEquity;
  const maxDrawdownAmount = config.accountBalance * (config.maxTotalDrawdownPct / 100);

  if (currentEquity > 0 && drawdown >= maxDrawdownAmount) {
    d.stopDay = true;
    d.stopDayReason = `Trailing drawdown $${drawdown.toFixed(2)} >= лимита $${maxDrawdownAmount.toFixed(0)} (${config.maxTotalDrawdownPct}% от $${config.accountBalance})`;
    logEvent('stop_day', {
      reason: d.stopDayReason,
      peakBalance,
      currentEquity,
      drawdown,
      maxDrawdownAmount,
    });
    log.warn('STOP DAY: trailing max drawdown достиг лимита — активирую kill switch', {
      peakBalance: peakBalance.toFixed(2),
      currentEquity: currentEquity.toFixed(2),
      drawdown: drawdown.toFixed(2),
      maxDrawdownAmount: maxDrawdownAmount.toFixed(2),
    });
    activateKillSwitch(d.stopDayReason);
    void triggerStopDayClose(d.stopDayReason);
  }

  return d.stopDay;
}

/** Закрывает все позиции при наступлении stop day (fire-and-forget, не блокирует синхронный код) */
async function triggerStopDayClose(reason: string): Promise<void> {
  try {
    log.warn('Закрываю все позиции из-за stop day', { reason });
    const result = await closeAllPositions();
    logEvent('stop_day_close_all', { reason, closed: result.closed, total: result.total });
    log.warn('Позиции закрыты по stop day', { closed: result.closed, total: result.total });
  } catch (error: unknown) {
    log.error('Ошибка при закрытии позиций после stop day', {
      error: error instanceof Error ? error.message : String(error),
      reason,
    });
  }
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

  // Stale balance guard: блокировать если баланс не обновлялся > 10 мин
  const STALE_BALANCE_MS = 10 * 60_000;
  if (s.balance.lastUpdate) {
    const balanceAge = Date.now() - new Date(s.balance.lastUpdate).getTime();
    if (balanceAge > STALE_BALANCE_MS) {
      return {
        allowed: false,
        reason: `Stale balance: обновлялся ${Math.round(balanceAge / 60_000)} мин назад`,
      };
    }
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

  // Aggregate risk: оставшийся бюджет с учётом уже реализованных убытков
  const remainingBudget = Math.max(
    0,
    config.maxDailyLoss - Math.abs(Math.min(0, s.daily.realizedPnl)),
  );
  const maxTotalRisk = remainingBudget * 0.9; // max 90% оставшегося дневного бюджета
  if (totalRisk >= maxTotalRisk) {
    return {
      allowed: false,
      reason: `Aggregate risk $${totalRisk.toFixed(2)} >= limit $${maxTotalRisk.toFixed(2)}`,
    };
  }

  return { allowed: true, reason: 'OK' };
}

/**
 * Возвращает адаптивный riskPerTrade на основе текущего состояния.
 *
 * Приоритет (от высшего к низшему):
 *   1. DD лимит приближается   → снизить риск (защита)
 *   2. Loss streak 2+          → снизить риск
 *   3. Profit target близко    → увеличить риск (агрессия)
 *   4. Win streak 3+           → увеличить риск
 *
 * Жёсткий cap: maxRiskPerTradePct / 100 (из конфига, обычно 3%)
 * Минимум: 0.005 (0.5%)
 */
export function getDynamicRisk(): { risk: number; reason: string } {
  const base = config.riskPerTrade; // 0.01
  const s = get();
  const d = s.daily;
  const balance = s.balance.total || config.accountBalance;

  const hardCap = config.maxRiskPerTradePct / 100; // 0.03
  const minRisk = 0.005;

  // 1. DD лимит: если осталось < 2% баланса до maxDailyLoss — срочно снижаем
  const equityLoss =
    Math.abs(Math.min(0, d.realizedPnl)) + Math.max(0, -(s.balance.unrealizedPnl ?? 0));
  const remainingDDRoom = config.maxDailyLoss - equityLoss; // в долларах
  const remainingDDPct = (remainingDDRoom / balance) * 100; // в %

  if (remainingDDPct < 2) {
    const adjusted = Math.max(minRisk, base * 0.5);
    log.info('Dynamic risk: DD лимит', {
      base,
      adjusted,
      reason: `Осталось ${remainingDDPct.toFixed(1)}% до DD лимита`,
    });
    return { risk: adjusted, reason: `dd_limit (${remainingDDPct.toFixed(1)}% room)` };
  }

  // 2. Loss streak 2+
  if (d.lossStreak >= 2) {
    const adjusted = Math.max(minRisk, base * 0.5);
    log.info('Dynamic risk: loss streak', {
      base,
      adjusted,
      reason: `Loss streak ${d.lossStreak}`,
    });
    return { risk: adjusted, reason: `loss_streak_${d.lossStreak}` };
  }

  // 3. Profit target близко (текущий P&L > 7% баланса)
  const profitTargetAmount = balance * (config.profitTargetPct / 100); // 10% target
  const profitThreshold = balance * 0.07; // 7% от баланса = 70% от цели (если цель 10%)
  const currentDayPnl = d.totalPnl;

  if (currentDayPnl >= profitThreshold && currentDayPnl < profitTargetAmount) {
    const progressRatio = currentDayPnl / profitTargetAmount; // 0.7..1.0
    // Линейная интерполяция: 1.5× при 70% прогресса → 2.0× при 100%
    const multiplier = 1.5 + (progressRatio - 0.7) * (0.5 / 0.3);
    const adjusted = Math.min(hardCap, Math.max(minRisk, base * multiplier));
    log.info('Dynamic risk: profit target', {
      base,
      adjusted,
      reason: `P&L ${currentDayPnl.toFixed(2)} / target ${profitTargetAmount.toFixed(2)} (${(progressRatio * 100).toFixed(0)}%)`,
    });
    return {
      risk: adjusted,
      reason: `profit_target_${(progressRatio * 100).toFixed(0)}pct`,
    };
  }

  // 4. Win streak 3+
  if (d.winStreak >= 3) {
    const adjusted = Math.min(hardCap, base * 1.5);
    log.info('Dynamic risk: win streak', {
      base,
      adjusted,
      reason: `Win streak ${d.winStreak}`,
    });
    return { risk: adjusted, reason: `win_streak_${d.winStreak}` };
  }

  // Базовый риск
  log.info('Dynamic risk: базовый', { base, adjusted: base, reason: 'base' });
  return { risk: base, reason: 'base' };
}

export function calcPositionSize(entryPrice: number, stopLoss: number): number {
  const s = get();
  const balance = s.balance.total || 0;
  if (balance === 0) return 0;

  const { risk } = getDynamicRisk();
  const riskAmount = Math.min(balance * risk, config.maxRiskPerTrade);
  const slDistance = Math.abs(entryPrice - stopLoss);
  if (slDistance === 0) return 0;

  let qty = riskAmount / slDistance;

  // Cap: маржа не должна превышать баланс / maxOpenPositions (гарантия что все слоты влезут)
  const maxMarginPerPos = balance / config.maxOpenPositions;
  const requiredMargin = (entryPrice * qty) / config.defaultLeverage;
  if (requiredMargin > maxMarginPerPos) {
    qty = (maxMarginPerPos * config.defaultLeverage) / entryPrice;
    log.info('Position size capped by margin limit', {
      original: riskAmount / slDistance,
      capped: qty,
      maxMargin: maxMarginPerPos,
    });
  }

  return qty;
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

// ═══ XP Gamification System ═══
// Очки начисляются за качество сделок, не только за прибыль.
// Цель: мотивировать Claude на качественные сделки, а не на количество.

/**
 * Начисляет XP за завершённую сделку.
 * Формула учитывает: прибыль, R-множитель, качество решения.
 */
export function awardTradeXP(trade: TradeInput): void {
  const s = get();
  const pnl = typeof trade.pnl === 'string' ? parseFloat(trade.pnl) : trade.pnl;
  const entry = parseFloat(String(trade.entryPrice ?? 0));
  const exit = parseFloat(String(trade.exitPrice ?? 0));

  let xpDelta = 0;
  const reasons: string[] = [];

  // === Прибыльная сделка ===
  if (pnl > 0) {
    // Базовые очки за прибыль: +10 за каждые $10
    xpDelta += Math.min(30, Math.round((pnl / 10) * 10));
    reasons.push(`прибыль +$${pnl.toFixed(1)}`);

    // Бонус за "идеальную" сделку: $8-15 прибыли (цель ~$10)
    if (pnl >= 8 && pnl <= 20) {
      xpDelta += 5;
      reasons.push('целевой профит');
    }

    // Бонус за TP hit (не ручное закрытие, а автоматический TP)
    if (!trade.isStop && entry > 0 && exit > 0) {
      xpDelta += 3;
      reasons.push('чистый выход');
    }

    // Бонус за win streak
    if (s.daily.winStreak >= 2) {
      xpDelta += 5 * Math.min(s.daily.winStreak - 1, 3);
      reasons.push(`серия побед x${s.daily.winStreak}`);
    }
  }

  // === Убыточная сделка ===
  if (pnl < 0) {
    const absPnl = Math.abs(pnl);

    // Штраф за убыток: -5 за каждые $10 (мягче чем награда)
    xpDelta -= Math.min(20, Math.round((absPnl / 10) * 5));
    reasons.push(`убыток -$${absPnl.toFixed(1)}`);

    // Мягкий штраф за SL hit (система сработала, это нормально)
    if (trade.isStop) {
      xpDelta += 3; // Частичная компенсация: SL = дисциплина, не ошибка
      reasons.push('SL дисциплина');
    }

    // Жёсткий штраф за большой убыток (>$30 = плохой вход)
    if (absPnl > 30) {
      xpDelta -= 10;
      reasons.push('крупный убыток');
    }

    // Штраф за loss streak
    if (s.daily.lossStreak >= 3) {
      xpDelta -= 5 * Math.min(s.daily.lossStreak - 2, 3);
      reasons.push(`серия потерь x${s.daily.lossStreak}`);
    }
  }

  // Бонус за достижение дневной цели
  const DAILY_TARGET = 45; // $45 дневная цель
  const prevPnl = s.daily.totalPnl - pnl;
  if (prevPnl < DAILY_TARGET && s.daily.totalPnl >= DAILY_TARGET) {
    xpDelta += 25;
    reasons.push('ДНЕВНАЯ ЦЕЛЬ ДОСТИГНУТА!');
    logEvent('daily_target_reached', { pnl: s.daily.totalPnl, target: DAILY_TARGET });
  }

  // Применяем XP
  s.daily.xp += xpDelta;
  s.daily.xpHistory.push({
    ts: new Date().toISOString(),
    delta: xpDelta,
    reason: reasons.join(', '),
  });
  // Лимит истории
  if (s.daily.xpHistory.length > 30) {
    s.daily.xpHistory = s.daily.xpHistory.slice(-30);
  }

  log.info('XP awarded', { symbol: trade.symbol, xpDelta, totalXp: s.daily.xp, reasons });
}

/**
 * Возвращает текущий уровень и прогресс.
 * Уровни: Новичок → Трейдер → Мастер → Легенда
 */
export function getXpStatus(): {
  level: string;
  xp: number;
  nextLevel: number;
  rank: string;
  emoji: string;
} {
  const xp = get().daily.xp;

  if (xp >= 100) return { level: 'Легенда', xp, nextLevel: 999, rank: '4/4', emoji: '👑' };
  if (xp >= 60) return { level: 'Мастер', xp, nextLevel: 100, rank: '3/4', emoji: '⭐' };
  if (xp >= 25) return { level: 'Трейдер', xp, nextLevel: 60, rank: '2/4', emoji: '📈' };
  return { level: 'Новичок', xp, nextLevel: 25, rank: '1/4', emoji: '🌱' };
}
