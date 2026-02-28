import { createLogger } from '../../utils/logger.js';
import { sendViaOpenClaw } from '../../utils/telegram.js';
import { getBalance, getMarketInfo, getPositions } from './bybit-client.js';
import config from './config.js';
import * as state from './state.js';

const log = createLogger('crypto-report');

function getArg(name: string, def: string): string {
  const prefix = `--${name}=`;
  const found = process.argv.find((a: string) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : def;
}

const FORMAT = getArg('format', 'text');

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
    stopLoss?: string;
    takeProfit?: string;
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
  const s = state.get();

  return {
    balance: s.balance,
    positions: s.positions,
    daily: s.daily,
    market,
    trades: todayTrades,
    killSwitch: state.isKillSwitchActive(),
    lastMonitor: s.lastMonitor,
  };
}

function fmt(val: number | string): string {
  const n = typeof val === 'string' ? parseFloat(val) : val;
  if (isNaN(n)) return '0.00';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPrice(val: number): string {
  if (val >= 1000)
    return val.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  if (val >= 1)
    return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return val.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
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
    console.log(JSON.stringify(formatJsonReport(data), null, 2));
  } else {
    const text = formatTelegramReport(data);
    await sendViaOpenClaw(text, 'crypto-trader');
    console.log(text);
  }
}

main().catch((err) => {
  log.error(`Report generation error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
