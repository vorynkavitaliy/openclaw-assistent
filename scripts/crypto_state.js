#!/usr/bin/env node
'use strict';
/**
 * Crypto State Manager — управление состоянием между запусками.
 *
 * Хранит:
 *   - Дневная статистика: trades, stops, PnL
 *   - Kill-switch / stop-day
 *   - Открытые позиции snapshot
 *   - События (events.jsonl)
 *
 * Использование:
 *   const state = require('./crypto_state');
 *   state.load();
 *   state.recordTrade({ ... });
 *   state.checkDayLimits();
 *   state.save();
 */

const fs = require('fs');
const path = require('path');
const config = require('./crypto_config');

// ─── Пути ─────────────────────────────────────────────────────

const STATE_FILE = config.stateFile;
const EVENTS_FILE = config.eventsFile;
const KILL_SWITCH_FILE = config.killSwitchFile;
const DATA_DIR = path.dirname(STATE_FILE);

// ─── Инициализация ────────────────────────────────────────────

function defaultState() {
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
    positions: [], // snapshot открытых позиций
    pendingSignals: [], // сигналы на ожидании
    lastMonitor: null, // timestamp последнего мониторинга
    lastReport: null, // timestamp последнего отчёта
    balance: {
      total: 0,
      available: 0,
      unrealizedPnl: 0,
      lastUpdate: null,
    },
  };
}

let _state = null;

// ─── Файловые операции ────────────────────────────────────────

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function load() {
  ensureDataDir();
  if (fs.existsSync(STATE_FILE)) {
    try {
      _state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      // Проверяем что дата совпадает, если нет — ресет дневных
      const today = new Date().toISOString().slice(0, 10);
      if (_state.daily?.date !== today) {
        resetDaily();
      }
    } catch (e) {
      console.error(`[state] Ошибка загрузки state.json: ${e.message}, создаю новый`);
      _state = defaultState();
    }
  } else {
    _state = defaultState();
  }
  return _state;
}

function save() {
  ensureDataDir();
  _state.lastUpdate = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(_state, null, 2), 'utf-8');
}

function get() {
  if (!_state) load();
  return _state;
}

// ─── Дневные операции ─────────────────────────────────────────

function resetDaily() {
  const today = new Date().toISOString().slice(0, 10);
  _state.today = today;
  _state.daily = {
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
 * Записать завершённую сделку
 * @param {Object} trade - { symbol, side, pnl, fee, isStop, entryPrice, exitPrice, qty }
 */
function recordTrade(trade) {
  const s = get();
  s.daily.trades++;
  const pnl = parseFloat(trade.pnl) || 0;
  const fee = parseFloat(trade.fee) || 0;
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

  // Обновить maxDrawdown
  if (s.daily.totalPnl < s.daily.maxDrawdown) {
    s.daily.maxDrawdown = s.daily.totalPnl;
  }

  // Записать событие
  logEvent('trade', trade);

  // Проверить лимиты
  checkDayLimits();
  save();
}

/**
 * Обновить баланс
 */
function updateBalance(balance) {
  const s = get();
  s.balance = {
    total: parseFloat(balance.totalEquity) || parseFloat(balance.totalWalletBalance) || 0,
    available: parseFloat(balance.totalAvailableBalance) || 0,
    unrealizedPnl: parseFloat(balance.totalPerpUPL) || 0,
    lastUpdate: new Date().toISOString(),
  };
  save();
}

/**
 * Обновить снапшот позиций
 */
function updatePositions(positions) {
  const s = get();
  s.positions = positions.map(p => ({
    symbol: p.symbol,
    side: p.side,
    size: p.size,
    entryPrice: p.entryPrice || p.avgPrice,
    markPrice: p.markPrice,
    unrealisedPnl: p.unrealisedPnl,
    leverage: p.leverage,
    stopLoss: p.stopLoss,
    takeProfit: p.takeProfit,
  }));
  save();
}

/**
 * Проверить дневные лимиты → stop-day
 */
function checkDayLimits() {
  const s = get();
  const d = s.daily;

  // Проверка 1: макс дневной убыток
  if (d.totalPnl <= -config.maxDailyLoss) {
    d.stopDay = true;
    d.stopDayReason = `Дневной убыток достиг $${Math.abs(d.totalPnl).toFixed(2)} (лимит $${config.maxDailyLoss})`;
    logEvent('stop_day', { reason: d.stopDayReason });
  }

  // Проверка 2: кол-во стопов
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
function canTrade() {
  const s = get();

  // Kill-switch
  if (isKillSwitchActive()) {
    return { allowed: false, reason: 'KILL_SWITCH активен. Торговля остановлена.' };
  }

  // Stop-day
  if (s.daily.stopDay) {
    return { allowed: false, reason: `СТОП-ДЕНЬ: ${s.daily.stopDayReason}` };
  }

  // Режим dry-run
  if (config.mode !== 'execute') {
    return { allowed: false, reason: `Режим: ${config.mode}. Торговля отключена.` };
  }

  // Макс позиций
  if (s.positions.length >= config.maxOpenPositions) {
    return {
      allowed: false,
      reason: `Макс позиций: ${s.positions.length}/${config.maxOpenPositions}`,
    };
  }

  return { allowed: true, reason: 'OK' };
}

/**
 * Рассчитать размер позиции
 */
function calcPositionSize(entryPrice, stopLoss) {
  const s = get();
  const balance = s.balance.total || 0;
  if (balance === 0) return 0;

  const riskAmount = Math.min(balance * config.riskPerTrade, config.maxRiskPerTrade);
  const slDistance = Math.abs(entryPrice - stopLoss);
  if (slDistance === 0) return 0;

  return riskAmount / slDistance;
}

// ─── Kill Switch ──────────────────────────────────────────────

function isKillSwitchActive() {
  return fs.existsSync(KILL_SWITCH_FILE);
}

function activateKillSwitch(reason = 'manual') {
  ensureDataDir();
  const content = JSON.stringify({
    activated: new Date().toISOString(),
    reason,
  });
  fs.writeFileSync(KILL_SWITCH_FILE, content, 'utf-8');
  logEvent('kill_switch_on', { reason });
}

function deactivateKillSwitch() {
  if (fs.existsSync(KILL_SWITCH_FILE)) {
    fs.unlinkSync(KILL_SWITCH_FILE);
    logEvent('kill_switch_off', {});
  }
}

// ─── Events Log (JSONL) ──────────────────────────────────────

function logEvent(type, data) {
  ensureDataDir();
  const event = {
    ts: new Date().toISOString(),
    type,
    ...data,
  };
  fs.appendFileSync(EVENTS_FILE, JSON.stringify(event) + '\n', 'utf-8');
}

/**
 * Получить последние события
 */
function getRecentEvents(count = 50) {
  if (!fs.existsSync(EVENTS_FILE)) return [];
  const lines = fs.readFileSync(EVENTS_FILE, 'utf-8').trim().split('\n').filter(Boolean);
  return lines
    .slice(-count)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Получить сделки за сегодня
 */
function getTodayTrades() {
  const today = new Date().toISOString().slice(0, 10);
  return getRecentEvents(200).filter(e => e.type === 'trade' && e.ts?.startsWith(today));
}

// ─── Экспорт ──────────────────────────────────────────────────

module.exports = {
  load,
  save,
  get,
  resetDaily,
  recordTrade,
  updateBalance,
  updatePositions,
  checkDayLimits,
  canTrade,
  calcPositionSize,
  isKillSwitchActive,
  activateKillSwitch,
  deactivateKillSwitch,
  logEvent,
  getRecentEvents,
  getTodayTrades,
};
