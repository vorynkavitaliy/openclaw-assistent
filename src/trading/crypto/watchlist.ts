import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TradeSignalInternal } from './market-analyzer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const WATCHLIST_FILE = path.join(PROJECT_ROOT, 'data', 'watchlist.json');
const WATCH_EXPIRY_HOURS = 4;

export interface WatchlistEntry {
  addedAt: string;
  expiresAt: string;
  reason: string;
  confluenceScore: number;
  side: 'Buy' | 'Sell';
  price: number;
}

type Watchlist = Record<string, WatchlistEntry>;

function loadFile(): Watchlist {
  try {
    if (!fs.existsSync(WATCHLIST_FILE)) return {};
    return JSON.parse(fs.readFileSync(WATCHLIST_FILE, 'utf8')) as Watchlist;
  } catch {
    return {};
  }
}

function saveFile(wl: Watchlist): void {
  const dir = path.dirname(WATCHLIST_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(wl, null, 2), 'utf8');
}

export function addToWatchlist(pair: string, sig: TradeSignalInternal, reason: string): void {
  const wl = loadFile();
  const now = new Date();
  const expires = new Date(now.getTime() + WATCH_EXPIRY_HOURS * 3_600_000);
  wl[pair] = {
    addedAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    reason,
    confluenceScore: sig.confluence.total,
    side: sig.side,
    price: sig.entryPrice,
  };
  saveFile(wl);
}

export function removeFromWatchlist(pair: string): void {
  const wl = loadFile();
  if (pair in wl) {
    delete wl[pair];
    saveFile(wl);
  }
}

export function isWatched(pair: string): boolean {
  const entry = loadFile()[pair];
  if (!entry) return false;
  return new Date(entry.expiresAt) > new Date();
}

export function cleanExpired(): number {
  const wl = loadFile();
  const now = new Date();
  const before = Object.keys(wl).length;
  for (const [pair, entry] of Object.entries(wl)) {
    if (new Date(entry.expiresAt) <= now) delete wl[pair];
  }
  const removed = before - Object.keys(wl).length;
  if (removed > 0) saveFile(wl);
  return removed;
}

export function getWatchlist(): Watchlist {
  const wl = loadFile();
  const now = new Date();
  return Object.fromEntries(
    Object.entries(wl).filter(([, entry]) => new Date(entry.expiresAt) > now),
  );
}
