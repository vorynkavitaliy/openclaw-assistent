import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ForexAnalysisResult } from './market-analyzer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../../../');
const SNAPSHOTS_FILE = path.join(PROJECT_ROOT, 'data', 'forex-snapshots.jsonl');
const MAX_SIZE_BYTES = 5 * 1024 * 1024;

export interface ForexSnapshot {
  timestamp: string;
  cycleId: string;
  pair: string;
  price: number;
  side: 'Buy' | 'Sell';
  regime: string;
  confluenceScore: number;
  confluenceSignal: string;
  confidence: number;
  bias: string;
  atr: number;
  details: string[];
}

function ensureDir(): void {
  const dir = path.dirname(SNAPSHOTS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function rotateIfNeeded(): void {
  try {
    if (fs.existsSync(SNAPSHOTS_FILE) && fs.statSync(SNAPSHOTS_FILE).size > MAX_SIZE_BYTES) {
      fs.unlinkSync(SNAPSHOTS_FILE);
    }
  } catch {
    // Файл не существует или нет прав — ОК
  }
}

export function saveForexSnapshots(cycleId: string, analyses: ForexAnalysisResult[]): void {
  if (analyses.length === 0) return;

  ensureDir();
  rotateIfNeeded();

  const timestamp = new Date().toISOString();
  const lines = analyses.map((analysis): string => {
    const snap: ForexSnapshot = {
      timestamp,
      cycleId,
      pair: analysis.pair,
      price: analysis.lastPrice,
      side: analysis.confluenceScore >= 0 ? 'Buy' : 'Sell',
      regime: analysis.regime,
      confluenceScore: analysis.confluenceScore,
      confluenceSignal: analysis.signal,
      confidence: analysis.confidence,
      bias: analysis.bias,
      atr: analysis.atr,
      details: analysis.details.slice(0, 5),
    };
    return JSON.stringify(snap);
  });

  fs.appendFileSync(SNAPSHOTS_FILE, lines.join('\n') + '\n', 'utf8');
}

/**
 * Сохраняет confluence score для любой пары (даже если ниже порога).
 * Используется для истории scores и калибровки.
 */
export function saveForexScore(
  cycleId: string,
  pair: string,
  price: number,
  regime: string,
  confluenceScore: number,
  confluenceSignal: string,
  confidence: number,
  bias = 'UNKNOWN',
  atr = 0,
): void {
  ensureDir();
  rotateIfNeeded();

  const snap: ForexSnapshot = {
    timestamp: new Date().toISOString(),
    cycleId,
    pair,
    price,
    side: confluenceScore >= 0 ? 'Buy' : 'Sell',
    regime,
    confluenceScore,
    confluenceSignal,
    confidence,
    bias,
    atr,
    details: [],
  };
  fs.appendFileSync(SNAPSHOTS_FILE, JSON.stringify(snap) + '\n', 'utf8');
}

export function loadRecentForexSnapshots(pair: string, maxCount = 12): ForexSnapshot[] {
  if (!fs.existsSync(SNAPSHOTS_FILE)) return [];

  const lines = fs.readFileSync(SNAPSHOTS_FILE, 'utf8').trim().split('\n').filter(Boolean);
  const result: ForexSnapshot[] = [];

  for (const line of lines) {
    try {
      const snap = JSON.parse(line) as ForexSnapshot;
      if (snap.pair === pair) result.push(snap);
    } catch {
      // пропускаем повреждённые строки
    }
  }

  return result.slice(-maxCount);
}

export function loadAllRecentForexSnapshots(maxAgeHours = 2): Map<string, ForexSnapshot[]> {
  if (!fs.existsSync(SNAPSHOTS_FILE)) return new Map();

  const lines = fs.readFileSync(SNAPSHOTS_FILE, 'utf8').trim().split('\n').filter(Boolean);
  const cutoff = Date.now() - maxAgeHours * 3_600_000;
  const result = new Map<string, ForexSnapshot[]>();

  for (const line of lines) {
    try {
      const snap = JSON.parse(line) as ForexSnapshot;
      if (new Date(snap.timestamp).getTime() < cutoff) continue;
      const list = result.get(snap.pair) ?? [];
      list.push(snap);
      result.set(snap.pair, list);
    } catch {
      // пропускаем повреждённые строки
    }
  }

  return result;
}
