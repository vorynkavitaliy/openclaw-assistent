import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TradeSignalInternal } from './market-analyzer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SNAPSHOTS_FILE = path.join(PROJECT_ROOT, 'data', 'market-snapshots.jsonl');
const MAX_SIZE_BYTES = 5 * 1024 * 1024;

export interface MarketSnapshot {
  timestamp: string;
  cycleId: string;
  pair: string;
  price: number;
  side: 'Buy' | 'Sell';
  regime: string;
  confluenceScore: number;
  confluenceSignal: string;
  confidence: number;
  sl: number;
  tp: number;
  rr: number;
  details: string[];
}

export function saveSnapshots(cycleId: string, signals: TradeSignalInternal[]): void {
  if (signals.length === 0) return;

  const dir = path.dirname(SNAPSHOTS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Rotate if too large
  try {
    if (fs.statSync(SNAPSHOTS_FILE).size > MAX_SIZE_BYTES) {
      fs.unlinkSync(SNAPSHOTS_FILE);
    }
  } catch {
    // File doesn't exist — OK
  }

  const timestamp = new Date().toISOString();
  const lines = signals.map((sig): string => {
    const snap: MarketSnapshot = {
      timestamp,
      cycleId,
      pair: sig.pair,
      price: sig.entryPrice,
      side: sig.side,
      regime: sig.regime,
      confluenceScore: sig.confluence.total,
      confluenceSignal: sig.confluence.signal,
      confidence: sig.confidence,
      sl: sig.sl,
      tp: sig.tp,
      rr: sig.rr,
      details: sig.confluence.details.slice(0, 5),
    };
    return JSON.stringify(snap);
  });

  fs.appendFileSync(SNAPSHOTS_FILE, lines.join('\n') + '\n', 'utf8');
}

export function loadRecentSnapshots(pair: string, maxCount = 12): MarketSnapshot[] {
  if (!fs.existsSync(SNAPSHOTS_FILE)) return [];

  const lines = fs.readFileSync(SNAPSHOTS_FILE, 'utf8').trim().split('\n').filter(Boolean);
  const result: MarketSnapshot[] = [];

  for (const line of lines) {
    try {
      const snap = JSON.parse(line) as MarketSnapshot;
      if (snap.pair === pair) result.push(snap);
    } catch {
      // skip malformed line
    }
  }

  return result.slice(-maxCount);
}

export function loadAllRecentSnapshots(maxAgeHours = 2): Map<string, MarketSnapshot[]> {
  if (!fs.existsSync(SNAPSHOTS_FILE)) return new Map();

  const lines = fs.readFileSync(SNAPSHOTS_FILE, 'utf8').trim().split('\n').filter(Boolean);
  const cutoff = Date.now() - maxAgeHours * 3_600_000;
  const result = new Map<string, MarketSnapshot[]>();

  for (const line of lines) {
    try {
      const snap = JSON.parse(line) as MarketSnapshot;
      if (new Date(snap.timestamp).getTime() < cutoff) continue;
      const list = result.get(snap.pair) ?? [];
      list.push(snap);
      result.set(snap.pair, list);
    } catch {
      // skip malformed line
    }
  }

  return result;
}
