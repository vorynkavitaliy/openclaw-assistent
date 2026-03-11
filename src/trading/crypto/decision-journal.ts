import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../../utils/logger.js';
import config from './config.js';

const log = createLogger('decision-journal');

const JOURNAL_FILE = path.join(path.dirname(config.stateFile), 'decisions.jsonl');

// ─── Типы ────────────────────────────────────────────────────────

export type DecisionType = 'entry' | 'skip' | 'manage' | 'exit' | 'outcome';

export interface FilterResult {
  passed: boolean;
  value: string;
  threshold: string;
}

export interface MarketContext {
  price: number;
  ema200?: number;
  rsi14?: number;
  atr14?: number;
  fundingRate?: number;
  spread?: number;
}

export interface Decision {
  id: string;
  timestamp: string;
  cycle: string;
  type: DecisionType;
  symbol: string;
  action: string;
  reasoning: string[];
  data: {
    confluenceScore?: number;
    confluenceSignal?: string;
    confidence?: number;
    regime?: string;
    filters?: Record<string, FilterResult>;
    marketContext?: MarketContext;
    side?: string;
    entry?: number;
    sl?: number;
    tp?: number;
    qty?: string;
    rr?: number;
    orderId?: string;
    orderIds?: string[];
  };
  outcome?: {
    pnl?: number;
    result?: 'win' | 'loss' | 'breakeven';
  };
}

// ─── Генерация ID ────────────────────────────────────────────────

let cycleCounter = 0;

export function generateCycleId(): string {
  cycleCounter++;
  const ts = Date.now().toString(36);
  return `cycle-${ts}-${cycleCounter}`;
}

function generateDecisionId(): string {
  return `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// ─── Запись и чтение ─────────────────────────────────────────────

function ensureDir(): void {
  const dir = path.dirname(JOURNAL_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function logDecision(
  cycle: string,
  type: DecisionType,
  symbol: string,
  action: string,
  reasoning: string[],
  data: Decision['data'] = {},
): Decision {
  ensureDir();
  const decision: Decision = {
    id: generateDecisionId(),
    timestamp: new Date().toISOString(),
    cycle,
    type,
    symbol,
    action,
    reasoning,
    data,
  };
  fs.appendFileSync(JOURNAL_FILE, JSON.stringify(decision) + '\n', 'utf-8');
  return decision;
}

function readAllDecisions(maxLines: number = 50000): Decision[] {
  if (!fs.existsSync(JOURNAL_FILE)) return [];
  const lines = fs.readFileSync(JOURNAL_FILE, 'utf-8').trim().split('\n').filter(Boolean);
  return lines
    .slice(-maxLines)
    .map((line) => {
      try {
        return JSON.parse(line) as Decision;
      } catch {
        return null;
      }
    })
    .filter((d): d is Decision => d !== null);
}

// ─── Запросы ─────────────────────────────────────────────────────

export function getRecentDecisions(count: number = 50): Decision[] {
  return readAllDecisions(count);
}

export function getDecisionsByCycle(cycleId: string): Decision[] {
  return readAllDecisions().filter((d) => d.cycle === cycleId);
}

export function getDecisionsBySymbol(symbol: string, hours: number = 24): Decision[] {
  const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  return readAllDecisions().filter((d) => d.symbol === symbol && d.timestamp >= cutoff);
}

export function getDecisionsByType(type: DecisionType, hours: number = 24): Decision[] {
  const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  return readAllDecisions().filter((d) => d.type === type && d.timestamp >= cutoff);
}

// ─── Отчёт ───────────────────────────────────────────────────────

export interface DecisionSummary {
  period: string;
  totalDecisions: number;
  entries: number;
  skips: number;
  manages: number;
  exits: number;
  skipReasons: Record<string, number>;
  entrySymbols: string[];
  topSkipReason: string;
}

export function generateSummary(hours: number = 24): DecisionSummary {
  const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const decisions = readAllDecisions().filter((d) => d.timestamp >= cutoff);

  const skipReasons: Record<string, number> = {};
  const entrySymbols: string[] = [];

  for (const d of decisions) {
    if (d.type === 'skip') {
      const reason = d.action;
      skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
    }
    if (d.type === 'entry') {
      entrySymbols.push(d.symbol);
    }
  }

  let topSkipReason = 'none';
  let topCount = 0;
  for (const [reason, count] of Object.entries(skipReasons)) {
    if (count > topCount) {
      topSkipReason = reason;
      topCount = count;
    }
  }

  return {
    period: `${hours}h`,
    totalDecisions: decisions.length,
    entries: decisions.filter((d) => d.type === 'entry').length,
    skips: decisions.filter((d) => d.type === 'skip').length,
    manages: decisions.filter((d) => d.type === 'manage').length,
    exits: decisions.filter((d) => d.type === 'exit').length,
    skipReasons,
    entrySymbols,
    topSkipReason,
  };
}

// ─── Форматирование для вывода ──────────────────────────────────

export function formatDecision(d: Decision): string {
  const lines: string[] = [];
  lines.push(`=== ${d.type.toUpperCase()}: ${d.action} ${d.symbol} ===`);
  lines.push(`Время: ${d.timestamp}`);
  lines.push(`Цикл: ${d.cycle}`);
  lines.push('');

  if (d.reasoning.length > 0) {
    lines.push('ОБОСНОВАНИЕ:');
    for (const r of d.reasoning) {
      lines.push(`  - ${r}`);
    }
    lines.push('');
  }

  if (d.data.confluenceScore !== undefined) {
    lines.push(`Confluence: ${d.data.confluenceScore} (${d.data.confluenceSignal ?? '?'})`);
    lines.push(`Confidence: ${d.data.confidence ?? '?'}%`);
    lines.push(`Regime: ${d.data.regime ?? '?'}`);
    lines.push('');
  }

  if (d.data.filters) {
    lines.push('ФИЛЬТРЫ:');
    for (const [name, f] of Object.entries(d.data.filters)) {
      const icon = f.passed ? '+' : '-';
      lines.push(`  ${icon} ${name}: ${f.value} (порог: ${f.threshold})`);
    }
    lines.push('');
  }

  if (d.data.entry !== undefined) {
    lines.push('ПАРАМЕТРЫ:');
    lines.push(`  Entry: ${d.data.entry}`);
    if (d.data.sl !== undefined) lines.push(`  SL: ${d.data.sl}`);
    if (d.data.tp !== undefined) lines.push(`  TP: ${d.data.tp}`);
    if (d.data.qty) lines.push(`  Qty: ${d.data.qty}`);
    if (d.data.rr !== undefined) lines.push(`  R:R: ${d.data.rr}`);
    lines.push('');
  }

  return lines.join('\n');
}

export function formatSummary(summary: DecisionSummary): string {
  const lines: string[] = [];
  lines.push(`=== Дневник решений (${summary.period}) ===`);
  lines.push(`Всего решений: ${summary.totalDecisions}`);
  lines.push(`  Входы: ${summary.entries}`);
  lines.push(`  Пропуски: ${summary.skips}`);
  lines.push(`  Управление: ${summary.manages}`);
  lines.push(`  Выходы: ${summary.exits}`);
  lines.push('');

  if (Object.keys(summary.skipReasons).length > 0) {
    lines.push('Причины пропусков:');
    const sorted = Object.entries(summary.skipReasons).sort((a, b) => b[1] - a[1]);
    for (const [reason, count] of sorted) {
      lines.push(`  ${reason}: ${count}`);
    }
    lines.push('');
  }

  if (summary.entrySymbols.length > 0) {
    lines.push(`Входы: ${summary.entrySymbols.join(', ')}`);
  }

  return lines.join('\n');
}

// ─── Outcome tracking ────────────────────────────────────────────

export function logTradeOutcome(
  symbol: string,
  pnl: number,
  side: string,
  entryPrice?: number,
  exitPrice?: number,
  isStop?: boolean,
): void {
  const result: 'win' | 'loss' | 'breakeven' = pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'breakeven';

  logDecision(
    'outcome',
    'exit',
    symbol,
    isStop ? 'STOPPED_OUT' : 'CLOSED',
    [
      `PnL: $${pnl.toFixed(2)} (${result})`,
      `Side: ${side}`,
      ...(entryPrice ? [`Entry: ${entryPrice}`] : []),
      ...(exitPrice ? [`Exit: ${exitPrice}`] : []),
    ],
    {
      side,
      ...(entryPrice !== undefined ? { entry: entryPrice } : {}),
    },
  );

  // Обновляем outcome в последнем entry решении по этому символу
  try {
    if (!fs.existsSync(JOURNAL_FILE)) return;
    const lines = fs.readFileSync(JOURNAL_FILE, 'utf-8').trim().split('\n').filter(Boolean);
    let updated = false;

    // Ищем с конца — последний entry для этого символа
    for (let i = lines.length - 1; i >= 0 && !updated; i--) {
      try {
        const d = JSON.parse(lines[i]!) as Decision;
        if (d.type === 'entry' && d.symbol === symbol && !d.outcome) {
          d.outcome = { pnl, result };
          lines[i] = JSON.stringify(d);
          updated = true;
        }
      } catch {
        /* skip bad lines */
      }
    }

    if (updated) {
      fs.writeFileSync(JOURNAL_FILE, lines.join('\n') + '\n', 'utf-8');
    }
  } catch {
    /* best effort */
  }
}

/**
 * Возвращает историю последних сделок (entry + outcome) для LLM промпта.
 */
export function getTradeHistory(count: number = 20): string {
  const decisions = readAllDecisions(500);

  // Собираем entry с outcome
  const entries = decisions.filter((d) => d.type === 'entry' && d.outcome);
  const recent = entries.slice(-count);

  if (recent.length === 0) return 'Нет истории сделок.';

  const wins = recent.filter((d) => d.outcome?.result === 'win').length;
  const losses = recent.filter((d) => d.outcome?.result === 'loss').length;
  const totalPnl = recent.reduce((sum, d) => sum + (d.outcome?.pnl ?? 0), 0);

  const lines: string[] = [
    `Win/Loss: ${wins}/${losses} (${recent.length} сделок), PnL: $${totalPnl.toFixed(2)}`,
    '',
  ];

  // Последние 10 для деталей
  for (const d of recent.slice(-10)) {
    const pnl = d.outcome?.pnl ?? 0;
    const icon = pnl > 0 ? '+' : '';
    const regime = d.data.regime ?? '?';
    const time = d.timestamp?.slice(5, 16) ?? '';
    lines.push(
      `${time} ${d.symbol} ${d.data.side ?? '?'} | ${d.outcome?.result} ${icon}$${pnl.toFixed(2)} | score=${d.data.confluenceScore ?? '?'} conf=${d.data.confidence ?? '?'}% regime=${regime} | ${d.reasoning[0] ?? ''}`,
    );
  }

  // Анализ: какие режимы/score дают wins vs losses
  if (recent.length >= 5) {
    const winTrades = recent.filter((d) => d.outcome?.result === 'win');
    const lossTrades = recent.filter((d) => d.outcome?.result === 'loss');
    const avgWinScore =
      winTrades.length > 0
        ? winTrades.reduce((s, d) => s + Math.abs(d.data.confluenceScore ?? 0), 0) /
          winTrades.length
        : 0;
    const avgLossScore =
      lossTrades.length > 0
        ? lossTrades.reduce((s, d) => s + Math.abs(d.data.confluenceScore ?? 0), 0) /
          lossTrades.length
        : 0;
    const avgWinConf =
      winTrades.length > 0
        ? winTrades.reduce((s, d) => s + (d.data.confidence ?? 0), 0) / winTrades.length
        : 0;
    const avgLossConf =
      lossTrades.length > 0
        ? lossTrades.reduce((s, d) => s + (d.data.confidence ?? 0), 0) / lossTrades.length
        : 0;
    lines.push('');
    lines.push(
      `ПАТТЕРНЫ: wins avg score=${avgWinScore.toFixed(0)} conf=${avgWinConf.toFixed(0)}% | losses avg score=${avgLossScore.toFixed(0)} conf=${avgLossConf.toFixed(0)}%`,
    );

    // Какие пары чаще убыточны
    const lossPairs: Record<string, number> = {};
    for (const d of lossTrades) lossPairs[d.symbol] = (lossPairs[d.symbol] ?? 0) + 1;
    const worstPairs = Object.entries(lossPairs)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
    if (worstPairs.length > 0) {
      lines.push(`Проблемные пары: ${worstPairs.map(([p, n]) => `${p}(${n} loss)`).join(', ')}`);
    }
  }

  // Анализ паттернов
  const skipDecisions = decisions.filter((d) => d.type === 'skip').slice(-100);
  const skipReasons: Record<string, number> = {};
  for (const d of skipDecisions) {
    skipReasons[d.action] = (skipReasons[d.action] ?? 0) + 1;
  }
  const topSkips = Object.entries(skipReasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason, cnt]) => `${reason}: ${cnt}`)
    .join(', ');

  if (topSkips) {
    lines.push('');
    lines.push(`Частые причины SKIP: ${topSkips}`);
  }

  return lines.join('\n');
}

// ─── Ротация ─────────────────────────────────────────────────────

const MAX_JOURNAL_BYTES = 10 * 1024 * 1024;

export function rotateIfNeeded(): void {
  try {
    if (!fs.existsSync(JOURNAL_FILE)) return;
    const stats = fs.statSync(JOURNAL_FILE);
    if (stats.size > MAX_JOURNAL_BYTES) {
      const lines = fs.readFileSync(JOURNAL_FILE, 'utf-8').trim().split('\n');
      const kept = lines.slice(-Math.floor(lines.length / 2));
      fs.writeFileSync(JOURNAL_FILE, kept.join('\n') + '\n', 'utf-8');
      log.info(`Journal rotated: ${lines.length} -> ${kept.length} entries`);
    }
  } catch {
    /* rotation is best-effort */
  }
}
