#!/usr/bin/env node
'use strict';
/**
 * Crypto Report — часовой отчёт в Telegram (каждый час в :10 UTC).
 *
 * Собирает:
 *   - Текущий баланс и equity
 *   - Открытые позиции с P&L
 *   - Дневную статистику (trades, wins, losses, PnL)
 *   - Рыночный обзор (top movers из наших пар)
 *   - Статус kill-switch / stop-day
 *
 * Отправляет:
 *   - JSON-отчёт в stdout (для OpenClaw routing → Telegram)
 *   - Или напрямую через Telegram API (fallback)
 *
 * Запуск:
 *   node scripts/crypto_report.js
 *   node scripts/crypto_report.js --format=text   # человеко-читаемый
 *   node scripts/crypto_report.js --format=json   # JSON для интеграций
 */

const { execSync } = require('child_process');
const path = require('path');
const config = require('./crypto_config');
const state = require('./crypto_state');

const SCRIPTS_DIR = path.resolve(__dirname);
const TRADE_JS = path.join(SCRIPTS_DIR, 'bybit_trade.js');
const DATA_PY = path.join(SCRIPTS_DIR, 'bybit_get_data.py');

// ─── CLI ──────────────────────────────────────────────────────

function getArg(name, def) {
  const p = `--${name}=`;
  const f = process.argv.find(a => a.startsWith(p));
  return f ? f.slice(p.length) : def;
}
const FORMAT = getArg('format', 'text');

// ─── Exec helpers ─────────────────────────────────────────────

function runTrade(args) {
  try {
    const out = execSync(`node "${TRADE_JS}" ${args}`, {
      timeout: 30000,
      encoding: 'utf-8',
      env: { ...process.env, HOME: process.env.HOME || '/root' },
    });
    return JSON.parse(out.trim());
  } catch (e) {
    try {
      return JSON.parse(e.stdout?.trim());
    } catch {
      return { status: 'ERROR', error: e.message };
    }
  }
}

function runData(args) {
  try {
    const out = execSync(`python3 "${DATA_PY}" ${args}`, {
      timeout: 15000,
      encoding: 'utf-8',
    });
    return JSON.parse(out.trim());
  } catch (e) {
    return { error: e.message };
  }
}

// ─── Сбор данных ──────────────────────────────────────────────

function collectData() {
  state.load();

  // Баланс
  const balRes = runTrade('--action=balance');
  if (balRes.status === 'OK') {
    state.updateBalance(balRes);
  }

  // Позиции
  const posRes = runTrade('--action=positions');
  if (posRes.status === 'OK') {
    state.updatePositions(posRes.positions || []);
  }

  // Рыночные данные для основных пар
  const marketData = {};
  const topPairs = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
  for (const pair of topPairs) {
    const mkt = runData(`--pair ${pair} --market-info`);
    if (mkt?.data) {
      marketData[pair] = {
        price: mkt.data.last_price,
        change24h: mkt.data.price_24h_pct,
        funding: mkt.data.funding_rate,
        volume24h: mkt.data.volume_24h,
      };
    }
  }

  // Дневные сделки
  const todayTrades = state.getTodayTrades();

  return {
    balance: state.get().balance,
    positions: state.get().positions,
    daily: state.get().daily,
    market: marketData,
    trades: todayTrades,
    killSwitch: state.isKillSwitchActive(),
    lastMonitor: state.get().lastMonitor,
  };
}

// ─── Форматирование: Telegram (text) ─────────────────────────

function formatTelegramReport(data) {
  const now = new Date();
  const timeStr = now.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const lines = [];

  // Заголовок
  lines.push(`📊 *Часовой отчёт крипто-трейдера*`);
  lines.push(`🕐 ${timeStr}`);
  lines.push('');

  // Статус
  if (data.killSwitch) {
    lines.push('🚨 *KILL SWITCH АКТИВЕН — торговля остановлена!*');
    lines.push('');
  }
  if (data.daily.stopDay) {
    lines.push(`⛔ *СТОП-ДЕНЬ: ${data.daily.stopDayReason}*`);
    lines.push('');
  }

  // Баланс
  lines.push('💰 *Баланс*');
  lines.push(`  Equity: $${fmt(data.balance.total)}`);
  lines.push(`  Доступно: $${fmt(data.balance.available)}`);
  lines.push(`  Unrealized P&L: $${fmt(data.balance.unrealizedPnl)}`);
  lines.push('');

  // Позиции
  if (data.positions.length > 0) {
    lines.push(`📈 *Открытые позиции (${data.positions.length})*`);
    for (const p of data.positions) {
      const pnl = parseFloat(p.unrealisedPnl) || 0;
      const pnlEmoji = pnl >= 0 ? '🟢' : '🔴';
      lines.push(`  ${pnlEmoji} ${p.symbol} ${p.side} x${p.leverage}`);
      lines.push(`     Размер: ${p.size} | Вход: ${p.entryPrice}`);
      lines.push(`     P&L: $${fmt(pnl)} | SL: ${p.stopLoss || '—'} | TP: ${p.takeProfit || '—'}`);
    }
  } else {
    lines.push('📈 *Позиции*: нет открытых');
  }
  lines.push('');

  // Дневная статистика
  lines.push('📅 *Дневная статистика*');
  lines.push(`  Сделок: ${data.daily.trades} (✅ ${data.daily.wins} / ❌ ${data.daily.losses})`);
  lines.push(`  P&L: $${fmt(data.daily.totalPnl)}`);
  lines.push(`  Стопов: ${data.daily.stops}/${config.maxStopsPerDay}`);
  if (data.daily.trades > 0) {
    const winRate = ((data.daily.wins / data.daily.trades) * 100).toFixed(0);
    lines.push(`  Винрейт: ${winRate}%`);
  }
  lines.push('');

  // Рынок
  if (Object.keys(data.market).length > 0) {
    lines.push('🌐 *Рынок*');
    for (const [pair, m] of Object.entries(data.market)) {
      const sym = pair.replace('USDT', '');
      const changeEmoji = m.change24h >= 0 ? '📈' : '📉';
      const fundingSign = m.funding >= 0 ? '+' : '';
      lines.push(
        `  ${changeEmoji} ${sym}: $${fmtPrice(m.price)} (${m.change24h >= 0 ? '+' : ''}${m.change24h?.toFixed(2)}%) | FR: ${fundingSign}${(m.funding * 100).toFixed(4)}%`
      );
    }
    lines.push('');
  }

  // Режим
  lines.push(`⚙️ Режим: *${config.mode === 'execute' ? 'FULL-AUTO 🤖' : 'DRY-RUN 🔍'}*`);
  if (data.lastMonitor) {
    const ago = Math.round((Date.now() - new Date(data.lastMonitor).getTime()) / 60000);
    lines.push(`🔄 Последний мониторинг: ${ago} мин назад`);
  }

  return lines.join('\n');
}

// ─── Форматирование: JSON ─────────────────────────────────────

function formatJsonReport(data) {
  return {
    timestamp: new Date().toISOString(),
    type: 'hourly_report',
    ...data,
    config: {
      mode: config.mode,
      riskPerTrade: config.riskPerTrade,
      maxDailyLoss: config.maxDailyLoss,
      maxStopsPerDay: config.maxStopsPerDay,
      pairs: config.pairs.length,
    },
  };
}

// ─── Отправка через OpenClaw ──────────────────────────────────

function sendViaOpenClaw(message) {
  // OpenClaw gateway routing: пишем в stdout, агент отправит в Telegram через routing
  // Этот скрипт запускается из cron, вывод перехватывается и отправляется через
  // `openclaw agent --agent crypto-trader --message "...report..."` → который ответит в Telegram
  console.log(message);
}

// ─── Utils ────────────────────────────────────────────────────

function fmt(val) {
  const n = parseFloat(val) || 0;
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPrice(val) {
  const n = parseFloat(val) || 0;
  if (n >= 1000)
    return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  if (n >= 1)
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
}

// ─── Main ─────────────────────────────────────────────────────

async function main() {
  const data = collectData();

  // Обновить lastReport
  const s = state.get();
  s.lastReport = new Date().toISOString();
  state.save();

  state.logEvent('report', {
    balance: data.balance.total,
    positions: data.positions.length,
    dailyPnl: data.daily.totalPnl,
    dailyTrades: data.daily.trades,
  });

  if (FORMAT === 'json') {
    console.log(JSON.stringify(formatJsonReport(data), null, 2));
  } else {
    const text = formatTelegramReport(data);
    sendViaOpenClaw(text);
  }
}

main().catch(err => {
  console.error(JSON.stringify({ status: 'ERROR', error: err.message }));
  process.exit(1);
});
