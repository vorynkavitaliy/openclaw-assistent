import { getArgOrDefault, hasFlag } from '../../utils/args.js';
import { createLogger } from '../../utils/logger.js';
import { runMain } from '../../utils/process.js';
import { fmt, fmtPrice, sendTelegram } from '../../utils/telegram.js';
import { getBalance, getMarketInfo, getPositions } from './bybit-client.js';
import config from './config.js';
import { generateSummary } from './decision-journal.js';
import * as state from './state.js';
import type { StoredEvent } from './state.js';

const log = createLogger('crypto-report');

const FORMAT = getArgOrDefault('format', 'text');
const NO_SEND = hasFlag('no-send');

interface MarketSnapshot {
  price: number;
  change24h: number;
  funding: number;
  volume24h: number;
}

interface ReportData {
  balance: { total: number; available: number; unrealizedPnl: number };
  positions: Array<{
    symbol: string;
    side: string;
    size: string;
    entryPrice: string;
    leverage: string;
    unrealisedPnl: string;
    stopLoss?: string | undefined;
    takeProfit?: string | undefined;
  }>;
  daily: {
    trades: number;
    wins: number;
    losses: number;
    totalPnl: number;
    stops: number;
    stopDay: boolean;
    stopDayReason: string | null;
  };
  market: Record<string, MarketSnapshot>;
  trades: unknown[];
  todayActivity: StoredEvent[];
  apiErrors: StoredEvent[];
  killSwitch: boolean;
  lastMonitor: string | null;
}

async function collectData(): Promise<ReportData> {
  state.load();

  try {
    const balance = await getBalance();
    state.updateBalance({
      totalEquity: String(balance.totalEquity),
      totalAvailableBalance: String(balance.availableBalance),
      totalPerpUPL: String(balance.unrealisedPnl),
    });
  } catch (err) {
    log.warn('Failed to get balance', { error: (err as Error).message });
  }

  try {
    const positions = await getPositions();
    state.updatePositions(
      positions.map((p) => ({
        symbol: p.symbol,
        side: p.side,
        size: p.size,
        entryPrice: p.entryPrice,
        markPrice: p.markPrice,
        unrealisedPnl: p.unrealisedPnl,
        leverage: p.leverage,
        stopLoss: p.stopLoss,
        takeProfit: p.takeProfit,
      })),
    );
  } catch (err) {
    log.warn('Failed to get positions', { error: (err as Error).message });
  }

  const market: Record<string, MarketSnapshot> = {};

  for (const pair of config.pairs) {
    try {
      const info = await getMarketInfo(pair);
      if (info) {
        market[pair] = {
          price: info.lastPrice,
          change24h: info.price24hPct,
          funding: info.fundingRate,
          volume24h: info.volume24h,
        };
      }
    } catch {
      /* ignored */
    }
  }

  const todayTrades = state.getTodayTrades();
  const todayActivity = state.getTodayEvents([
    'order_opened',
    'partial_close',
    'trailing_sl',
    'sl_guard',
    'trade',
    'monitor',
  ]);
  const apiErrors = state.getTodayEvents(['api_error', 'analysis_error']);
  const s = state.get();

  return {
    balance: s.balance,
    positions: s.positions,
    daily: s.daily,
    market,
    trades: todayTrades,
    todayActivity,
    apiErrors,
    killSwitch: state.isKillSwitchActive(),
    lastMonitor: s.lastMonitor,
  };
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatTelegramReport(data: ReportData): string {
  const now = new Date();
  const timeStr = now.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const lines: string[] = [];

  lines.push(`<b>Крипто-трейдер</b>  ${timeStr}`);

  if (data.killSwitch) {
    lines.push('');
    lines.push('🚨 <b>KILL SWITCH АКТИВЕН</b>');
  }
  if (data.daily.stopDay) {
    lines.push('');
    lines.push(`⛔ <b>СТОП-ДЕНЬ:</b> ${esc(data.daily.stopDayReason ?? '')}`);
  }

  // Баланс
  lines.push('');
  lines.push(`💰 <b>Баланс</b>`);
  lines.push(`Equity: <code>$${fmt(data.balance.total)}</code>`);
  lines.push(`Доступно: <code>$${fmt(data.balance.available)}</code>`);
  lines.push(`Unrealized: <code>$${fmt(data.balance.unrealizedPnl)}</code>`);

  // Позиции
  lines.push('');
  if (data.positions.length > 0) {
    lines.push(`📈 <b>Позиции (${data.positions.length})</b>`);
    for (const p of data.positions) {
      const pnl = parseFloat(p.unrealisedPnl) || 0;
      const icon = pnl >= 0 ? '🟢' : '🔴';
      const sym = p.symbol.replace('USDT', '');
      lines.push(
        `${icon} <b>${sym}</b> ${p.side} x${p.leverage}  <code>${p.size} @ ${p.entryPrice}</code>`,
      );
      lines.push(
        `    P&amp;L: <code>$${fmt(pnl)}</code>  SL: <code>${p.stopLoss ?? '—'}</code>  TP: <code>${p.takeProfit ?? '—'}</code>`,
      );
    }
  } else {
    lines.push('📈 <b>Позиции:</b> нет открытых');
  }

  // Дневная статистика
  lines.push('');
  lines.push(`📅 <b>День</b>`);
  const statsLine = `Сделок: ${data.daily.trades} (✅${data.daily.wins} ❌${data.daily.losses})  Стопов: ${data.daily.stops}/${config.maxStopsPerDay}`;
  lines.push(statsLine);
  const pnlSign = data.daily.totalPnl >= 0 ? '+' : '';
  lines.push(`P&amp;L: <code>${pnlSign}$${fmt(data.daily.totalPnl)}</code>`);
  if (data.daily.trades > 0) {
    const winRate = ((data.daily.wins / data.daily.trades) * 100).toFixed(0);
    lines.push(`Винрейт: <code>${winRate}%</code>`);
  }

  // Рынок
  const marketEntries = Object.entries(data.market);
  if (marketEntries.length > 0) {
    lines.push('');
    lines.push('🌐 <b>Рынок</b>');
    for (const [pair, m] of marketEntries) {
      const sym = pair.replace('USDT', '');
      const icon = m.change24h >= 0 ? '📈' : '📉';
      const chSign = m.change24h >= 0 ? '+' : '';
      const frSign = m.funding >= 0 ? '+' : '';
      lines.push(
        `${icon} <b>${sym}</b> <code>$${fmtPrice(m.price)}</code> ${chSign}${m.change24h.toFixed(1)}%  FR: ${frSign}${(m.funding * 100).toFixed(3)}%`,
      );
    }
  }

  // Безопасное извлечение строкового значения из StoredEvent
  const sv = (e: StoredEvent, key: string, fallback = '?'): string => {
    const v = e[key];
    if (v === null || v === undefined) return fallback;
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return fallback;
  };

  // Активность за сутки
  const orderEvents = data.todayActivity.filter((e) => e.type === 'order_opened');
  const slGuardEvents = data.todayActivity.filter((e) => e.type === 'sl_guard');
  const partialEvents = data.todayActivity.filter((e) => e.type === 'partial_close');
  const trailingEvents = data.todayActivity.filter((e) => e.type === 'trailing_sl');

  if (data.todayActivity.length > 0) {
    lines.push('');
    lines.push('📋 <b>История</b>');
    if (orderEvents.length > 0) {
      lines.push(`📥 Ордеров: ${orderEvents.length}`);
      for (const e of orderEvents.slice(-3)) {
        const time = sv(e, 'ts', '').slice(11, 16);
        lines.push(
          `  <code>${time}</code> ${esc(sv(e, 'symbol', ''))} ${sv(e, 'side', '')} @ ${sv(e, 'entry')} score:${sv(e, 'confluenceScore')}`,
        );
      }
    }
    if (partialEvents.length > 0) lines.push(`📤 Частичных закрытий: ${partialEvents.length}`);
    if (trailingEvents.length > 0) lines.push(`🔄 Trailing SL: ${trailingEvents.length}`);
    if (slGuardEvents.length > 0) {
      lines.push(`🛡 SL-Guard: ${slGuardEvents.length}`);
      for (const e of slGuardEvents) {
        const time = sv(e, 'ts', '').slice(11, 16);
        lines.push(`  <code>${time}</code> ${esc(sv(e, 'symbol', ''))} SL: ${sv(e, 'defaultSl')}`);
      }
    }
  }

  // Ошибки API
  if (data.apiErrors.length > 0) {
    lines.push('');
    lines.push(`⚠️ <b>Ошибки API: ${data.apiErrors.length}</b>`);
    const byType: Record<string, number> = {};
    for (const e of data.apiErrors) {
      const t = sv(e, 'type', 'unknown');
      byType[t] = (byType[t] ?? 0) + 1;
    }
    for (const [t, cnt] of Object.entries(byType)) {
      lines.push(`${esc(t)}: ${cnt}`);
    }
    const last = data.apiErrors[data.apiErrors.length - 1];
    if (last) {
      const time = sv(last, 'ts', '').slice(11, 16);
      lines.push(`Последняя <code>${time}</code>: ${esc(sv(last, 'error').slice(0, 60))}`);
    }
  }

  // Дневник решений
  const dj = generateSummary(24);
  if (dj.totalDecisions > 0) {
    lines.push('');
    lines.push('🧠 <b>Решения 24ч</b>');
    lines.push(`Всего: ${dj.totalDecisions} (входы: ${dj.entries}, пропуски: ${dj.skips})`);
    if (dj.topSkipReason !== 'none') {
      lines.push(`Пропуск: ${esc(dj.topSkipReason)}`);
    }
    if (dj.entrySymbols.length > 0) {
      lines.push(`Входы: ${dj.entrySymbols.join(', ')}`);
    }
  }

  // Режим и мониторинг
  lines.push('');
  const modeLabel = config.mode === 'execute' ? 'AUTO' : 'DRY-RUN';
  const demoLabel = config.demoTrading ? ' DEMO' : '';
  lines.push(
    `⚙️ ${modeLabel}${demoLabel}  Пар: ${config.pairs.length}  Риск: ${(config.riskPerTrade * 100).toFixed(0)}%`,
  );
  if (data.lastMonitor) {
    const ago = Math.round((Date.now() - new Date(data.lastMonitor).getTime()) / 60000);
    lines.push(`🔄 Мониторинг: ${ago} мин назад`);
  }

  return lines.join('\n');
}

function formatJsonReport(data: ReportData): Record<string, unknown> {
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

async function main(): Promise<void> {
  const data = await collectData();

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
    log.info('Report (json)', { report: formatJsonReport(data) });
  } else {
    const text = formatTelegramReport(data);
    if (NO_SEND) {
      process.stdout.write(text + '\n');
    } else {
      await sendTelegram(text, 'HTML');
      log.info('Report sent to Telegram');
    }
  }
}

runMain(main, () => state.save());
