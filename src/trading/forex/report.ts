import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../../utils/logger.js';
import { fmt, sendTelegram } from '../../utils/telegram.js';
import { hasFlag } from '../../utils/args.js';
import { runMain } from '../../utils/process.js';
import { getBalance, getPositions, disconnect } from './client.js';
import config from './config.js';

const log = createLogger('forex-report');

const NO_SEND = hasFlag('no-send');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

// ── Типы состояния форекс ──────────────────────────────────────────────────

interface ForexDaily {
  trades: number;
  wins: number;
  losses: number;
  totalPnl: number;
  stops: number;
}

interface ForexState {
  daily?: ForexDaily;
  lastMonitor?: string;
  lastReport?: string;
}

// ── Тип данных отчёта ──────────────────────────────────────────────────────

interface PositionData {
  symbol: string;
  side: string;
  size: string;
  entryPrice: string;
  unrealisedPnl: string;
  stopLoss?: string | undefined;
  takeProfit?: string | undefined;
}

interface ReportData {
  balance: {
    equity: number;
    available: number;
    unrealisedPnl: number;
  };
  positions: PositionData[];
  daily: ForexDaily;
  killSwitch: boolean;
  lastMonitor: string | null;
}

// ── Утилиты ────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function readForexState(): ForexState {
  const statePath = path.join(PROJECT_ROOT, 'data', 'forex-state.json');
  try {
    if (fs.existsSync(statePath)) {
      const raw = fs.readFileSync(statePath, 'utf-8');
      return JSON.parse(raw) as ForexState;
    }
  } catch (err) {
    log.warn('Не удалось прочитать forex-state.json', { error: (err as Error).message });
  }
  return {};
}

function isKillSwitchActive(): boolean {
  return fs.existsSync(path.join(PROJECT_ROOT, 'data', 'FOREX_KILL_SWITCH'));
}

// ── Сбор данных ────────────────────────────────────────────────────────────

async function collectData(): Promise<ReportData> {
  const savedState = readForexState();

  let equity = 0;
  let available = 0;
  let unrealisedPnl = 0;
  let positions: PositionData[] = [];

  try {
    const balance = await getBalance();
    equity = balance.totalEquity;
    available = balance.availableBalance;
    unrealisedPnl = balance.unrealisedPnl;
  } catch (err) {
    log.warn('Не удалось получить баланс', { error: (err as Error).message });
  }

  try {
    const rawPositions = await getPositions();
    positions = rawPositions.map((p) => ({
      symbol: p.symbol,
      side: p.side,
      size: p.size,
      entryPrice: p.entryPrice,
      unrealisedPnl: p.unrealisedPnl,
      stopLoss: p.stopLoss,
      takeProfit: p.takeProfit,
    }));
  } catch (err) {
    log.warn('Не удалось получить позиции', { error: (err as Error).message });
  }

  const daily: ForexDaily = savedState.daily ?? {
    trades: 0,
    wins: 0,
    losses: 0,
    totalPnl: 0,
    stops: 0,
  };

  return {
    balance: { equity, available, unrealisedPnl },
    positions,
    daily,
    killSwitch: isKillSwitchActive(),
    lastMonitor: savedState.lastMonitor ?? null,
  };
}

// ── Форматирование отчёта ──────────────────────────────────────────────────

function formatReport(data: ReportData): string {
  const now = new Date();
  const timeStr = now.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const lines: string[] = [];

  lines.push(`<b>💱 Форекс-трейдер</b>  ${timeStr}`);

  if (data.killSwitch) {
    lines.push('');
    lines.push('🚨 <b>KILL SWITCH АКТИВЕН</b>');
  }

  // Баланс
  const drawdownPct =
    data.balance.equity > 0
      ? (((data.balance.equity - data.balance.available) / data.balance.equity) * 100).toFixed(1)
      : '0.0';

  lines.push('');
  lines.push('💰 <b>Баланс</b>');
  lines.push(`Equity: <code>$${fmt(data.balance.equity)}</code>`);
  lines.push(`Доступно: <code>$${fmt(data.balance.available)}</code>`);
  lines.push(`Drawdown: <code>${drawdownPct}%</code>`);

  // Позиции
  lines.push('');
  if (data.positions.length > 0) {
    lines.push(`📈 <b>Позиции: ${data.positions.length}</b>`);
    for (const p of data.positions) {
      const pnl = parseFloat(p.unrealisedPnl) || 0;
      const pnlSign = pnl >= 0 ? '+' : '';
      const lots = parseFloat(p.size);
      lines.push(
        `  <b>${esc(p.symbol)}</b> ${esc(p.side)} ${lots.toFixed(2)} @ <code>${esc(p.entryPrice)}</code>`,
      );
      lines.push(
        `  SL: <code>${esc(p.stopLoss ?? '—')}</code>  TP: <code>${esc(p.takeProfit ?? '—')}</code>`,
      );
      lines.push(`  P&amp;L: <code>${pnlSign}$${fmt(pnl)}</code>`);
    }
  } else {
    lines.push('📈 <b>Позиции:</b> нет открытых');
  }

  // Дневная статистика
  lines.push('');
  lines.push('📅 <b>День</b>');
  lines.push(
    `Сделок: ${data.daily.trades} (✅${data.daily.wins} ❌${data.daily.losses})  Стопов: ${data.daily.stops}/3`,
  );
  const pnlSign = data.daily.totalPnl >= 0 ? '+' : '';
  lines.push(`P&amp;L: <code>${pnlSign}$${fmt(data.daily.totalPnl)}</code>`);

  // Конфиг
  lines.push('');
  const modeLabel = config.mode === 'execute' ? 'AUTO' : 'DRY-RUN';
  const envLabel = config.environment === 'live' ? ' LIVE' : ' DEMO';
  lines.push(
    `⚙️ ${modeLabel}${envLabel}  Пар: ${config.pairs.length}  Риск: ${config.maxRiskPerTradePct}%`,
  );
  if (data.lastMonitor) {
    const ago = Math.round((Date.now() - new Date(data.lastMonitor).getTime()) / 60000);
    lines.push(`🔄 Мониторинг: ${ago} мин назад`);
  }

  return lines.join('\n');
}

// ── Точка входа ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log.info('Генерация форекс-отчёта...');

  const data = await collectData();
  const text = formatReport(data);

  if (NO_SEND) {
    process.stdout.write(text + '\n');
  } else {
    await sendTelegram(text, 'HTML');
    log.info('Отчёт отправлен в Telegram');
  }

  // Обновить время последнего отчёта в state
  const statePath = path.join(PROJECT_ROOT, 'data', 'forex-state.json');
  try {
    const current = readForexState();
    current.lastReport = new Date().toISOString();
    fs.writeFileSync(statePath, JSON.stringify(current, null, 2), 'utf-8');
  } catch (err) {
    log.warn('Не удалось обновить lastReport в forex-state.json', {
      error: (err as Error).message,
    });
  }
}

runMain(main, disconnect);
