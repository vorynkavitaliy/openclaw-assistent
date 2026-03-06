import { getArgOrDefault, hasFlag } from '../../utils/args.js';
import { createLogger } from '../../utils/logger.js';
import { runMain } from '../../utils/process.js';
import { fmt, fmtPrice, sendViaOpenClaw } from '../../utils/telegram.js';
import { getBalance, getMarketInfo, getPositions } from './bybit-client.js';
import config from './config.js';
import { generateSummary } from './decision-journal.js';
import * as state from './state.js';
import type { StoredEvent } from './state.js';

const log = createLogger('crypto-report');

const FORMAT = getArgOrDefault('format', 'text');

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
  const topPairs = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

  for (const pair of topPairs) {
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

function formatTelegramReport(data: ReportData): string {
  const now = new Date();
  const timeStr = now.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const lines: string[] = [];

  lines.push(`📊 *Часовой отчёт крипто-трейдера*`);
  lines.push(`🕐 ${timeStr}`);
  lines.push('');

  if (data.killSwitch) {
    lines.push('🚨 *KILL SWITCH АКТИВЕН — торговля остановлена!*');
    lines.push('');
  }
  if (data.daily.stopDay) {
    lines.push(`⛔ *СТОП-ДЕНЬ: ${data.daily.stopDayReason}*`);
    lines.push('');
  }

  lines.push('💰 *Баланс*');
  lines.push(`  Equity: $${fmt(data.balance.total)}`);
  lines.push(`  Доступно: $${fmt(data.balance.available)}`);
  lines.push(`  Unrealized P&L: $${fmt(data.balance.unrealizedPnl)}`);
  lines.push('');

  if (data.positions.length > 0) {
    lines.push(`📈 *Открытые позиции (${data.positions.length})*`);
    for (const p of data.positions) {
      const pnl = parseFloat(p.unrealisedPnl) || 0;
      const pnlEmoji = pnl >= 0 ? '🟢' : '🔴';
      lines.push(`  ${pnlEmoji} ${p.symbol} ${p.side} x${p.leverage}`);
      lines.push(`     Размер: ${p.size} | Вход: ${p.entryPrice}`);
      lines.push(`     P&L: $${fmt(pnl)} | SL: ${p.stopLoss ?? '—'} | TP: ${p.takeProfit ?? '—'}`);
    }
  } else {
    lines.push('📈 *Позиции*: нет открытых');
  }
  lines.push('');

  lines.push('📅 *Дневная статистика*');
  lines.push(`  Сделок: ${data.daily.trades} (✅ ${data.daily.wins} / ❌ ${data.daily.losses})`);
  lines.push(`  P&L: $${fmt(data.daily.totalPnl)}`);
  lines.push(`  Стопов: ${data.daily.stops}/${config.maxStopsPerDay}`);
  if (data.daily.trades > 0) {
    const winRate = ((data.daily.wins / data.daily.trades) * 100).toFixed(0);
    lines.push(`  Винрейт: ${winRate}%`);
  }
  lines.push('');

  const marketEntries = Object.entries(data.market);
  if (marketEntries.length > 0) {
    lines.push('🌐 *Рынок*');
    for (const [pair, m] of marketEntries) {
      const sym = pair.replace('USDT', '');
      const changeEmoji = m.change24h >= 0 ? '📈' : '📉';
      const fundingSign = m.funding >= 0 ? '+' : '';
      lines.push(
        `  ${changeEmoji} ${sym}: $${fmtPrice(m.price)} (${m.change24h >= 0 ? '+' : ''}${m.change24h.toFixed(2)}%) | FR: ${fundingSign}${(m.funding * 100).toFixed(4)}%`,
      );
    }
    lines.push('');
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
    lines.push('📋 *История за сутки*');
    if (orderEvents.length > 0) {
      lines.push(`  📥 Открыто ордеров: ${orderEvents.length}`);
      for (const e of orderEvents.slice(-3)) {
        const time = sv(e, 'ts', '').slice(11, 16);
        lines.push(
          `     [${time}] ${sv(e, 'symbol', '')} ${sv(e, 'side', '')} @ ${sv(e, 'entry')} | SL: ${sv(e, 'sl', '—')} | score: ${sv(e, 'confluenceScore')}`,
        );
      }
    }
    if (partialEvents.length > 0) lines.push(`  📤 Частичных закрытий: ${partialEvents.length}`);
    if (trailingEvents.length > 0)
      lines.push(`  🔄 Trailing SL обновлений: ${trailingEvents.length}`);
    if (slGuardEvents.length > 0) {
      lines.push(`  🛡 SL-Guard сработал: ${slGuardEvents.length} раз`);
      for (const e of slGuardEvents) {
        const time = sv(e, 'ts', '').slice(11, 16);
        lines.push(`     [${time}] ${sv(e, 'symbol', '')} — дефолтный SL: ${sv(e, 'defaultSl')}`);
      }
    }
    lines.push('');
  }

  // Ошибки API
  if (data.apiErrors.length > 0) {
    lines.push(`⚠️ *Ошибки API за сутки: ${data.apiErrors.length}*`);
    const byType: Record<string, number> = {};
    for (const e of data.apiErrors) {
      const t = sv(e, 'type', 'unknown');
      byType[t] = (byType[t] ?? 0) + 1;
    }
    for (const [t, cnt] of Object.entries(byType)) {
      lines.push(`  ${t}: ${cnt}`);
    }
    const last = data.apiErrors[data.apiErrors.length - 1];
    if (last) {
      const time = sv(last, 'ts', '').slice(11, 16);
      lines.push(`  Последняя [${time}]: ${sv(last, 'error').slice(0, 60)}`);
    }
    lines.push('');
  }

  // Дневник решений за 24ч
  const dj = generateSummary(24);
  if (dj.totalDecisions > 0) {
    lines.push('🧠 *Дневник решений (24ч)*');
    lines.push(`  Решений: ${dj.totalDecisions} (входы: ${dj.entries}, пропуски: ${dj.skips})`);
    if (dj.topSkipReason !== 'none') {
      lines.push(`  Топ причина пропуска: ${dj.topSkipReason}`);
    }
    if (dj.entrySymbols.length > 0) {
      lines.push(`  Входы: ${dj.entrySymbols.join(', ')}`);
    }
    lines.push('');
  }

  lines.push(`⚙️ Режим: *${config.mode === 'execute' ? 'FULL-AUTO 🤖' : 'DRY-RUN 🔍'}*`);
  if (data.lastMonitor) {
    const ago = Math.round((Date.now() - new Date(data.lastMonitor).getTime()) / 60000);
    lines.push(`🔄 Последний мониторинг: ${ago} мин назад`);
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
    if (!hasFlag('no-send')) {
      await sendViaOpenClaw(text);
    }
    log.info('Report (text)', { text });
  }
}

runMain(main, () => state.save());
