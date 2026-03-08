import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../../utils/logger.js';
import { sendTelegram } from '../../utils/telegram.js';

const log = createLogger('llm-cost-tracker');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const COST_FILE = path.join(PROJECT_ROOT, 'data', 'llm-costs.jsonl');
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB

// Лимиты по умолчанию (гибрид: больше вызовов LLM для лучших решений)
const DEFAULT_DAILY_LIMIT_USD = 50.0;
const DEFAULT_MONTHLY_LIMIT_USD = 1500.0;

// Цены Claude Sonnet через OpenRouter (за 1M токенов)
const PROMPT_PRICE_PER_M = 3.0; // $3/1M prompt tokens
const COMPLETION_PRICE_PER_M = 15.0; // $15/1M completion tokens

export interface LLMCostEntry {
  timestamp: string;
  cycleId: string;
  promptTokens: number;
  completionTokens: number;
  costUSD: number;
  source: 'advisor' | 'chat' | 'other';
}

export interface CostSummary {
  todayCostUSD: number;
  todayCalls: number;
  monthCostUSD: number;
  monthCalls: number;
  dailyLimitUSD: number;
  monthlyLimitUSD: number;
  dailyRemaining: number;
  monthlyRemaining: number;
  isOverDailyLimit: boolean;
  isOverMonthlyLimit: boolean;
}

function getDailyLimit(): number {
  return parseFloat(process.env.LLM_DAILY_LIMIT_USD ?? '') || DEFAULT_DAILY_LIMIT_USD;
}

function getMonthlyLimit(): number {
  return parseFloat(process.env.LLM_MONTHLY_LIMIT_USD ?? '') || DEFAULT_MONTHLY_LIMIT_USD;
}

export function calculateCost(promptTokens: number, completionTokens: number): number {
  return (
    (promptTokens * PROMPT_PRICE_PER_M + completionTokens * COMPLETION_PRICE_PER_M) / 1_000_000
  );
}

function ensureDir(): void {
  const dir = path.dirname(COST_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function rotateIfNeeded(): void {
  try {
    if (fs.existsSync(COST_FILE) && fs.statSync(COST_FILE).size > MAX_FILE_BYTES) {
      const lines = fs.readFileSync(COST_FILE, 'utf8').trim().split('\n');
      const kept = lines.slice(-Math.floor(lines.length / 2));
      fs.writeFileSync(COST_FILE, kept.join('\n') + '\n', 'utf8');
    }
  } catch {
    // best effort
  }
}

export function recordLLMCall(
  cycleId: string,
  promptTokens: number,
  completionTokens: number,
  source: LLMCostEntry['source'] = 'advisor',
): LLMCostEntry {
  ensureDir();
  rotateIfNeeded();

  const costUSD = calculateCost(promptTokens, completionTokens);
  const entry: LLMCostEntry = {
    timestamp: new Date().toISOString(),
    cycleId,
    promptTokens,
    completionTokens,
    costUSD: Math.round(costUSD * 10000) / 10000,
    source,
  };

  fs.appendFileSync(COST_FILE, JSON.stringify(entry) + '\n', 'utf8');

  log.info('LLM cost recorded', {
    cycleId,
    costUSD: entry.costUSD,
    source,
    promptTokens,
    completionTokens,
  });

  return entry;
}

function loadEntries(): LLMCostEntry[] {
  if (!fs.existsSync(COST_FILE)) return [];
  const lines = fs.readFileSync(COST_FILE, 'utf8').trim().split('\n').filter(Boolean);
  const entries: LLMCostEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as LLMCostEntry);
    } catch {
      // skip malformed
    }
  }
  return entries;
}

export function getCostSummary(): CostSummary {
  const entries = loadEntries();
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7); // YYYY-MM

  const todayEntries = entries.filter((e) => e.timestamp.startsWith(today));
  const monthEntries = entries.filter((e) => e.timestamp.startsWith(month));

  const todayCost = todayEntries.reduce((sum, e) => sum + e.costUSD, 0);
  const monthCost = monthEntries.reduce((sum, e) => sum + e.costUSD, 0);

  const dailyLimit = getDailyLimit();
  const monthlyLimit = getMonthlyLimit();

  return {
    todayCostUSD: Math.round(todayCost * 10000) / 10000,
    todayCalls: todayEntries.length,
    monthCostUSD: Math.round(monthCost * 10000) / 10000,
    monthCalls: monthEntries.length,
    dailyLimitUSD: dailyLimit,
    monthlyLimitUSD: monthlyLimit,
    dailyRemaining: Math.max(0, dailyLimit - todayCost),
    monthlyRemaining: Math.max(0, monthlyLimit - monthCost),
    isOverDailyLimit: todayCost >= dailyLimit,
    isOverMonthlyLimit: monthCost >= monthlyLimit,
  };
}

/**
 * Проверяет лимиты и возвращает true если вызов LLM разрешён.
 * При превышении лимита отправляет уведомление в Telegram.
 */
export async function checkLLMBudget(): Promise<{ allowed: boolean; reason: string }> {
  const summary = getCostSummary();

  if (summary.isOverMonthlyLimit) {
    const msg = `Monthly LLM limit exceeded: $${summary.monthCostUSD.toFixed(2)} / $${summary.monthlyLimitUSD}`;
    log.warn(msg);
    await sendTelegram(`⚠️ ${msg}. LLM вызовы приостановлены до конца месяца.`).catch(() => {});
    return { allowed: false, reason: msg };
  }

  if (summary.isOverDailyLimit) {
    const msg = `Daily LLM limit exceeded: $${summary.todayCostUSD.toFixed(4)} / $${summary.dailyLimitUSD}`;
    log.warn(msg);
    return { allowed: false, reason: msg };
  }

  // Предупреждение при 80% дневного лимита
  if (summary.todayCostUSD >= summary.dailyLimitUSD * 0.8 && summary.todayCalls > 0) {
    log.info('LLM daily budget 80% used', {
      used: summary.todayCostUSD,
      limit: summary.dailyLimitUSD,
    });
  }

  return { allowed: true, reason: 'OK' };
}

/**
 * Форматирует отчёт по расходам LLM для Telegram.
 */
export function formatCostReport(): string {
  const summary = getCostSummary();
  const entries = loadEntries();
  const today = new Date().toISOString().slice(0, 10);
  const todayEntries = entries.filter((e) => e.timestamp.startsWith(today));

  const lines = [
    `📊 LLM Cost Report`,
    ``,
    `Сегодня: $${summary.todayCostUSD.toFixed(4)} / $${summary.dailyLimitUSD} (${summary.todayCalls} вызовов)`,
    `Месяц: $${summary.monthCostUSD.toFixed(4)} / $${summary.monthlyLimitUSD} (${summary.monthCalls} вызовов)`,
    ``,
  ];

  if (todayEntries.length > 0) {
    lines.push(`Последние вызовы:`);
    for (const e of todayEntries.slice(-5)) {
      const time = e.timestamp.slice(11, 19);
      lines.push(
        `  ${time} ${e.source}: $${e.costUSD.toFixed(4)} (${e.promptTokens}+${e.completionTokens} tok)`,
      );
    }
  }

  const avgCostPerCall = summary.monthCalls > 0 ? summary.monthCostUSD / summary.monthCalls : 0;
  if (avgCostPerCall > 0) {
    lines.push(``, `Средний вызов: $${avgCostPerCall.toFixed(4)}`);
  }

  return lines.join('\n');
}
