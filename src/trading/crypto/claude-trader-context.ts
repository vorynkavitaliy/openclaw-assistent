/**
 * Claude Trader Context — формирует компактный промпт для Claude CLI.
 *
 * buildTraderContext() — полный контекст рынка + позиций для торговых решений.
 * buildSystemPrompt() — системный промпт с правилами трейдера.
 */

import { createLogger } from '../../utils/logger.js';
import { getKyivHour, formatKyivTime } from '../../utils/time.js';
import { loadDigestCache } from '../../market/digest.js';
import type { TradeSignalInternal } from './market-analyzer.js';
import { getTradeHistory } from './decision-journal.js';
import { loadAllRecentSnapshots, type MarketSnapshot } from './market-snapshot.js';
import { isWatched } from './watchlist.js';
import * as state from './state.js';
import config from './config.js';

const log = createLogger('claude-trader-context');

// ─── Системный промпт ──────────────────────────────────────────────────────

export function buildSystemPrompt(): string {
  return `Ты — крипто-трейдер на PROP FIRM (HyroTrader). Анализируешь рынок и управляешь позициями.

PROP FIRM ПРАВИЛА (HyroTrader 2-Step Challenge):
- Аккаунт: $${config.accountBalance.toLocaleString()} | Цель: +${config.profitTargetPct}%
- Daily Drawdown лимит: ${config.maxDailyLossPct}% ($${((config.accountBalance * config.maxDailyLossPct) / 100).toFixed(0)})
- Max Total Drawdown: ${config.maxTotalDrawdownPct}% ($${((config.accountBalance * config.maxTotalDrawdownPct) / 100).toFixed(0)}) — TRAILING от пика
- Max risk per trade: ${config.maxRiskPerTradePct}% ($${((config.accountBalance * config.maxRiskPerTradePct) / 100).toFixed(0)})
- Одна сделка НЕ БОЛЬШЕ 40% общей прибыли (consistency rule)
- SL обязателен в течение 5 минут (Bybit TP/SL, не conditional)
- Мин 10 торговых дней для прохождения challenge
- НЕЛЬЗЯ: martingale, cross-account hedging

ДОСТУПНЫЕ ДЕЙСТВИЯ:
1. ENTER — открыть новую позицию (нужны pair, side, entry, sl, tp)
2. CLOSE — закрыть позицию (нужен pair и reason)
3. MODIFY_SL — подвинуть стоп-лосс (pair, newSl)
4. MODIFY_TP — подвинуть тейк-профит (pair, newTp)
5. SKIP — не входить в пару (pair, reason)
6. WAIT — наблюдать за парой (pair, reason)

СТРАТЕГИЯ ДЛЯ PROP FIRM:
- Цель: стабильно зарабатывать каждый день, НЕ одной большой сделкой
- Риск: ${(config.riskPerTrade * 100).toFixed(1)}% на сделку ($${(config.accountBalance * config.riskPerTrade).toFixed(0)}), макс $${config.maxRiskPerTrade}
- Цель: 3-8 сделок в день, активно ищи возможности
- Если confluence score ≥ 30 и confidence ≥ 40% — СКЛОНЯЙСЯ К ENTER
- Не жди идеальных условий — хороший сетап лучше чем бесконечное ожидание
- R:R мин 1.5 (лучше 2.0+), SL на 2×ATR от entry
- Макс 3 позиции одновременно
- Коррелированные: SOL+AVAX+SUI (одна группа), ETH+LINK (другая) — макс 1 на группу
- 4 стопа за день = стоп-день (оставляй запас до лимита drawdown)
- SKIP только если сигнал реально слабый (score < 20 или conf < 30%)
- При приближении к daily drawdown лимиту — снижай размер позиций или останавливайся

УПРАВЛЕНИЕ ПОЗИЦИЯМИ:
- Если тренд развернулся против позиции — CLOSE (не ждать SL)
- Если позиция в плюсе >1.5R — подтяни SL в безубыток (MODIFY_SL)
- Если позиция в плюсе >2R — можно подтянуть SL на +1R
- Забирай прибыль: лучше +1R в кармане чем -1R на стопе

ЖЁСТКИЕ ПРАВИЛА (из прошлых ошибок):
- Позиция В МИНУСЕ + confluence ПРОПАЛ → CLOSE НЕМЕДЛЕННО, НЕ WAIT. Нет confluence = нет причины держать позицию.
- Одноразовый всплеск score без тренда (score<25 на предыдущих циклах) → с осторожностью, лучше WAIT и подождать подтверждения
- Смотри на историю score в trend(4): если score нестабильный и прыгает — это шум, не сигнал
- Prop firm: каждый -$50 drawdown = минус к запасу. Лучше малый убыток (-$15) чем полный стоп (-$115)

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

function formatSession(kyivHour: number): string {
  // Лондон открывается в 10:00 Kyiv (8:00 UTC зимой, 7:00 UTC летом)
  // Нью-Йорк открывается в 16:30 Kyiv
  if (kyivHour >= 10 && kyivHour < 14) return 'Лондон';
  if (kyivHour >= 14 && kyivHour < 19) return 'Лондон+Нью-Йорк';
  if (kyivHour >= 19 && kyivHour < 24) return 'Нью-Йорк';
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

// ─── Обзор рынка (все ключевые пары) ─────────────────────────────────────

const KEY_PAIRS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT'];

function buildMarketOverview(snapshots: Map<string, MarketSnapshot[]>): string {
  const lines: string[] = ['ОБЗОР РЫНКА (все пары):'];

  // Топ-5 пар всегда показываем
  for (const pair of KEY_PAIRS) {
    const snaps = snapshots.get(pair) ?? [];
    const latest = snaps[snaps.length - 1];
    if (!latest) continue;
    const prev = snaps.length >= 2 ? snaps[snaps.length - 2] : null;
    const priceTrend = prev
      ? latest.price > prev.price
        ? '↑'
        : latest.price < prev.price
          ? '↓'
          : '→'
      : '?';
    const scoreTrend = prev
      ? latest.confluenceScore > prev.confluenceScore
        ? '↑'
        : latest.confluenceScore < prev.confluenceScore
          ? '↓'
          : '→'
      : '?';
    lines.push(
      `  ${pair}: $${latest.price} ${priceTrend} | score=${latest.confluenceScore}(${latest.confluenceSignal}) conf=${latest.confidence}% regime=${latest.regime} ${scoreTrend}`,
    );
  }

  // Остальные пары: только те с score >= 15 (потенциально интересные)
  const interestingPairs: string[] = [];
  for (const [pair, snaps] of snapshots) {
    if (KEY_PAIRS.includes(pair)) continue;
    const latest = snaps[snaps.length - 1];
    if (!latest || Math.abs(latest.confluenceScore) < 15) continue;
    interestingPairs.push(
      `${pair}:${latest.confluenceScore}/${latest.confidence}%/${latest.regime}`,
    );
  }
  if (interestingPairs.length > 0) {
    lines.push(`  Активные альты: ${interestingPairs.join('  ')}`);
  }

  return lines.join('\n') + '\n';
}

// ─── Секция времени и сессии ───────────────────────────────────────────────

function buildTimeSection(): string {
  const now = new Date();
  const kyivHour = getKyivHour(now);
  const kyivTime = formatKyivTime(now);
  const days = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
  // День недели в Kyiv timezone
  const kyivDayStr = now.toLocaleDateString('en-US', { timeZone: 'Europe/Kyiv', weekday: 'long' });
  const kyivDayIdx = [
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
  ].indexOf(kyivDayStr);
  const dayName = kyivDayIdx >= 0 ? days[kyivDayIdx] : kyivDayStr;
  const dateStr = now.toLocaleDateString('uk-UA', {
    timeZone: 'Europe/Kyiv',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
  return `Дата: ${dateStr} (${dayName}) | Время: ${kyivTime} Kyiv | Сессия: ${formatSession(kyivHour)}\n`;
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
    // Сильные пары (score >= 25 и conf >= 35%) показываем с полными деталями — Claude может по ним ENTER
    const strongOthers = otherSignals.filter(
      (s) => Math.abs(s.confluence.total) >= 25 && s.confidence >= 35,
    );
    const weakOthers = otherSignals.filter(
      (s) => Math.abs(s.confluence.total) < 25 || s.confidence < 35,
    );

    if (strongOthers.length > 0) {
      lines.push(`\nСильные пары вне основного списка (${strongOthers.length}):`);
      for (const sig of strongOthers) {
        lines.push(buildSignalBlock(sig, snapshots));
      }
    }

    if (weakOthers.length > 0) {
      lines.push(`\nОстальные пары (score/conf):`);
      const summary = weakOthers
        .map((s) => `${s.pair}:${s.confluence.total}/${s.confidence}%`)
        .join('  ');
      lines.push(`  ${summary}`);
    }
  }

  return lines.join('\n') + '\n';
}

// ─── Секция новостного фона ───────────────────────────────────────────────

function buildNewsSection(): string {
  const cache = loadDigestCache();
  if (!cache) return '';

  const lines: string[] = ['\n=== НОВОСТНОЙ ФОН ===\n'];

  if (cache.macro.length > 0) {
    const highImpact = cache.macro.filter((e) => e.impact === 'High' || e.impact === 'Medium');
    const events = highImpact.length > 0 ? highImpact.slice(0, 5) : cache.macro.slice(0, 3);
    for (const e of events) {
      const icon = e.impact === 'High' ? '⚠️' : '📅';
      const forecast = e.forecast ? ` прогноз=${e.forecast}` : '';
      const prev = e.previous ? ` пред=${e.previous}` : '';
      lines.push(`${icon} ${e.date} ${e.time} ${e.currency} ${e.title}${forecast}${prev}`);
    }
  }

  if (cache.news.length > 0) {
    lines.push('');
    for (const n of cache.news.slice(0, 5)) {
      lines.push(`📰 [${n.source}] ${n.title}`);
    }
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
    buildMarketOverview(snapshots),
    '\n',
    positionsSection,
    reviewSection,
    '\n',
    buildSignalsSection(signals, allSignals, snapshots),
    buildNewsSection(),
    '\n=== ИСТОРИЯ (последние 20 сделок) ===\n',
    tradeHistory,
    '\n',
  ];

  const context = parts.join('');

  log.info('Trader context built', { chars: context.length });

  return context;
}
