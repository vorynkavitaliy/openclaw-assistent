/**
 * Claude Trader Context — формирует компактный промпт для Claude CLI.
 *
 * buildTraderContext() — полный контекст рынка + позиций для торговых решений.
 * buildSystemPrompt() — системный промпт с правилами трейдера.
 */

import { createLogger } from '../../utils/logger.js';
import type { TradeSignalInternal } from './market-analyzer.js';
import { getTradeHistory } from './decision-journal.js';
import { loadAllRecentSnapshots, type MarketSnapshot } from './market-snapshot.js';
import { isWatched } from './watchlist.js';
import * as state from './state.js';
import config from './config.js';

const log = createLogger('claude-trader-context');

// ─── Системный промпт ──────────────────────────────────────────────────────

export function buildSystemPrompt(): string {
  return `Ты — крипто-трейдер. Анализируешь рынок и управляешь позициями.

ДОСТУПНЫЕ ДЕЙСТВИЯ:
1. ENTER — открыть новую позицию (нужны pair, side, entry, sl, tp)
2. CLOSE — закрыть позицию (нужен pair и reason)
3. MODIFY_SL — подвинуть стоп-лосс (pair, newSl)
4. MODIFY_TP — подвинуть тейк-профит (pair, newTp)
5. SKIP — не входить в пару (pair, reason)
6. WAIT — наблюдать за парой (pair, reason)

ПРАВИЛА:
- Макс 3 позиции одновременно, 1% риска на сделку
- SL обязателен, R:R мин 1.5
- Коррелированные: SOL+AVAX+SUI (одна группа), ETH+LINK (другая) — макс 1 на группу
- 3 стопа за день = стоп-день
- Цель: 2-3 сделки в день
- Если тренд развернулся против позиции — CLOSE (не ждать SL)
- Если позиция в хорошем плюсе (>1.5R) — можно подтянуть SL в безубыток

ФОРМАТ ОТВЕТА — СТРОГО JSON:
{"summary": "краткий обзор решений", "actions": [{"type": "ENTER|CLOSE|MODIFY_SL|MODIFY_TP|SKIP|WAIT", "pair": "BTCUSDT", "reason": "причина", ...доп параметры}]}

Для ENTER: {"type":"ENTER","pair":"...","side":"Buy|Sell","reason":"...","confidence":0-100}
Для CLOSE: {"type":"CLOSE","pair":"...","reason":"..."}
Для MODIFY_SL: {"type":"MODIFY_SL","pair":"...","newSl":123.45,"reason":"..."}
Для MODIFY_TP: {"type":"MODIFY_TP","pair":"...","newTp":456.78,"reason":"..."}
Для SKIP: {"type":"SKIP","pair":"...","reason":"...","confidence":0-100}
Для WAIT: {"type":"WAIT","pair":"...","reason":"..."}`;
}

// ─── Вспомогательные функции ───────────────────────────────────────────────

function formatSession(hour: number): string {
  if (hour >= 8 && hour < 12) return 'Лондон';
  if (hour >= 12 && hour < 17) return 'Лондон+Нью-Йорк';
  if (hour >= 17 && hour < 22) return 'Нью-Йорк';
  return 'Азия (низкая ликвидность)';
}

/**
 * Вычисляет R-множитель позиции относительно её SL.
 * R = (mark - entry) / |entry - sl| для Long, инвертировано для Short.
 */
function calcRMultiplier(
  entryPrice: string,
  markPrice: string,
  stopLoss: string | undefined,
  side: string,
): string {
  const entry = parseFloat(entryPrice);
  const mark = parseFloat(markPrice);
  const sl = parseFloat(stopLoss ?? '0');
  if (!sl || !entry || entry === sl) return '?';

  const riskPerUnit = Math.abs(entry - sl);
  const priceDelta = side === 'Buy' ? mark - entry : entry - mark;
  const r = priceDelta / riskPerUnit;
  return r.toFixed(2) + 'R';
}

// ─── Секция позиций ────────────────────────────────────────────────────────

function buildPositionsSection(allSignals: TradeSignalInternal[]): string {
  const s = state.get();
  if (s.positions.length === 0) return 'Позиции: нет\n';

  const signalMap = new Map(allSignals.map((sig) => [sig.pair, sig]));

  const lines: string[] = [`Позиции (${s.positions.length}/${config.maxOpenPositions}):`];

  for (const p of s.positions) {
    const pnl = parseFloat(p.unrealisedPnl);
    const pnlSign = pnl >= 0 ? '+' : '';
    const rMult = calcRMultiplier(p.entryPrice, p.markPrice, p.stopLoss, p.side);
    const sig = signalMap.get(p.symbol);

    let conflictNote = '';
    if (sig) {
      const score = sig.confluence.total;
      const isOpposite = (p.side === 'long' && score < -25) || (p.side === 'short' && score > 25);
      if (isOpposite) {
        conflictNote = ` ⚠️ СИГНАЛ ПРОТИВ (score=${score})`;
      }
    }

    lines.push(
      `  ${p.symbol} ${p.side} x${p.size} | entry=${p.entryPrice} mark=${p.markPrice}` +
        ` | PnL=${pnlSign}$${pnl.toFixed(2)} (${rMult})` +
        ` | SL=${p.stopLoss ?? 'нет'} TP=${p.takeProfit ?? 'нет'}${conflictNote}`,
    );
  }

  return lines.join('\n') + '\n';
}

// ─── Секция review позиций ─────────────────────────────────────────────────

export function buildPositionReviewContext(allSignals: TradeSignalInternal[]): string {
  const s = state.get();
  if (s.positions.length === 0) return '';

  const signalMap = new Map(allSignals.map((sig) => [sig.pair, sig]));
  const reviewLines: string[] = [];

  for (const p of s.positions) {
    const sig = signalMap.get(p.symbol);
    const score = sig ? sig.confluence.total : null;
    const sigSide = sig ? sig.side : null;

    const isOpposite =
      score !== null && ((p.side === 'long' && score < -25) || (p.side === 'short' && score > 25));

    const scoreInfo = score !== null ? `score=${score} (${sigSide})` : 'нет сигнала';
    const flag = isOpposite ? ' ⚠️ СИГНАЛ ПРОТИВ ПОЗИЦИИ' : '';

    reviewLines.push(`${p.symbol} ${p.side}: текущий confluence ${scoreInfo}${flag}`);
  }

  if (reviewLines.length === 0) return '';

  return `\nREVIEW ПОЗИЦИЙ:\n${reviewLines.map((l) => `  ${l}`).join('\n')}\n`;
}

// ─── Секция баланса ────────────────────────────────────────────────────────

function buildBalanceSection(): string {
  const s = state.get();
  const b = s.balance;
  const uPnl =
    b.unrealizedPnl >= 0
      ? `+$${b.unrealizedPnl.toFixed(2)}`
      : `-$${Math.abs(b.unrealizedPnl).toFixed(2)}`;
  return `Баланс: $${b.total.toFixed(0)} (доступно $${b.available.toFixed(0)}, unrealized ${uPnl})\n`;
}

// ─── Секция дневной статистики ─────────────────────────────────────────────

function buildDailySection(): string {
  const s = state.get();
  const d = s.daily;
  const pnlSign = d.totalPnl >= 0 ? '+' : '';
  const stopDayNote = d.stopDay ? ' 🛑 СТОП-ДЕНЬ' : '';
  return (
    `День: сделок=${d.trades} (win=${d.wins} loss=${d.losses} stops=${d.stops}/${config.maxStopsPerDay})` +
    ` PnL=${pnlSign}$${d.totalPnl.toFixed(2)}${stopDayNote}\n`
  );
}

// ─── Секция времени и сессии ───────────────────────────────────────────────

function buildTimeSection(): string {
  const now = new Date();
  const hour = now.getUTCHours();
  const min = now.getUTCMinutes().toString().padStart(2, '0');
  return `Время UTC: ${hour}:${min} | Сессия: ${formatSession(hour)}\n`;
}

// ─── Секция сигналов ───────────────────────────────────────────────────────

function buildSignalBlock(
  sig: TradeSignalInternal,
  snapshots: Map<string, MarketSnapshot[]>,
): string {
  const snaps = (snapshots.get(sig.pair) ?? []).slice(-4);
  const scores = snaps.map((s) => `${s.confluenceScore}@${s.timestamp.slice(11, 16)}`).join(',');
  const trend =
    snaps.length >= 2
      ? (snaps[snaps.length - 1]?.confluenceScore ?? 0) > (snaps[0]?.confluenceScore ?? 0)
        ? '↑'
        : '↓'
      : '?';

  const watchFlag = isWatched(sig.pair) ? ' [WATCHED]' : '';

  return (
    `${sig.pair}${watchFlag} ${sig.side} | score=${sig.confluence.total}(${sig.confluence.signal}) conf=${sig.confidence}% regime=${sig.regime}\n` +
    `  entry=${sig.entryPrice} SL=${sig.sl} TP=${sig.tp} R:R=${sig.rr}\n` +
    `  trend(4): ${scores || 'нет'} ${trend}\n` +
    `  ${sig.confluence.details.slice(0, 4).join(' | ')}`
  );
}

function buildSignalsSection(
  signals: TradeSignalInternal[],
  allSignals: TradeSignalInternal[],
  snapshots: Map<string, MarketSnapshot[]>,
): string {
  if (signals.length === 0 && allSignals.length === 0) return 'Сигналов нет\n';

  const lines: string[] = [];

  if (signals.length > 0) {
    lines.push(`Сигналы (${signals.length} кандидатов):`);
    for (const sig of signals) {
      lines.push(buildSignalBlock(sig, snapshots));
    }
  }

  // Остальные пары (из allSignals, не вошедшие в основные сигналы)
  const signalPairs = new Set(signals.map((s) => s.pair));
  const otherSignals = allSignals.filter((s) => !signalPairs.has(s.pair));
  if (otherSignals.length > 0) {
    lines.push(`\nОстальные пары (score/conf):`);
    const summary = otherSignals
      .map((s) => `${s.pair}:${s.confluence.total}/${s.confidence}%`)
      .join('  ');
    lines.push(`  ${summary}`);
  }

  return lines.join('\n') + '\n';
}

// ─── Основная функция ──────────────────────────────────────────────────────

/**
 * Формирует компактный контекст для Claude CLI (~3000 символов).
 *
 * @param signals — пары-кандидаты для входа (прошедшие фильтрацию)
 * @param allSignals — все проанализированные пары (для review позиций и обзора рынка)
 */
export function buildTraderContext(
  signals: TradeSignalInternal[],
  allSignals: TradeSignalInternal[],
): string {
  log.info('Building trader context', {
    candidates: signals.length,
    total: allSignals.length,
  });

  const snapshots = loadAllRecentSnapshots(2);
  const tradeHistory = getTradeHistory(20);
  const positionsSection = buildPositionsSection(allSignals);
  const reviewSection = buildPositionReviewContext(allSignals);

  const parts: string[] = [
    '=== КОНТЕКСТ РЫНКА ===\n',
    buildTimeSection(),
    buildBalanceSection(),
    buildDailySection(),
    '\n',
    positionsSection,
    reviewSection,
    '\n',
    buildSignalsSection(signals, allSignals, snapshots),
    '\n=== ИСТОРИЯ (последние 20 сделок) ===\n',
    tradeHistory,
    '\n',
  ];

  const context = parts.join('');

  log.info('Trader context built', { chars: context.length });

  return context;
}
