/**
 * Claude Trader Context — формирует компактный промпт для Claude CLI.
 *
 * buildTraderContext() — полный контекст рынка + позиций для торговых решений.
 * buildSystemPrompt() — системный промпт с правилами трейдера.
 */

import { createLogger } from '../../utils/logger.js';
import { getKyivHour, formatKyivTime } from '../../utils/time.js';
import { loadDigestCache } from '../../market/digest.js';
import type { TradeSignalInternal, SignalMarketData } from './market-analyzer.js';
import { getTradeHistory } from './decision-journal.js';
import { loadAllRecentSnapshots, type MarketSnapshot } from './market-snapshot.js';
import { isWatched } from './watchlist.js';
import * as state from './state.js';
import config from './config.js';

const DAILY_PROFIT_TARGET = 45; // $45 дневная цель (3 сделки × $15)

const log = createLogger('claude-trader-context');

// ─── Системный промпт ──────────────────────────────────────────────────────

export function buildSystemPrompt(): string {
  const xpStatus = state.getXpStatus();
  const s = state.get();
  const d = s.daily;
  const pnlToTarget = DAILY_PROFIT_TARGET - d.totalPnl;
  const tradesLeft = config.maxDailyTrades - d.trades;

  return `Ты — крипто-трейдер на PROP FIRM (HyroTrader). Анализируешь рынок и управляешь позициями.

${xpStatus.emoji} ТВОЙ СТАТУС: ${xpStatus.level} (${xpStatus.xp} XP → ${xpStatus.nextLevel} XP до следующего уровня)
${d.totalPnl >= DAILY_PROFIT_TARGET ? '🏆 ДНЕВНАЯ ЦЕЛЬ ДОСТИГНУТА! Можешь торговать дальше, но осторожнее.' : `🎯 ДНЕВНАЯ ЦЕЛЬ: +$${DAILY_PROFIT_TARGET} | Осталось: $${pnlToTarget.toFixed(0)} | Сделок осталось: ${tradesLeft}`}
${d.totalPnl >= DAILY_PROFIT_TARGET ? '' : `💡 ПЛАН: ${tradesLeft} сделок × $${Math.ceil(pnlToTarget / Math.max(1, tradesLeft))} каждая = цель достигнута`}

СИСТЕМА ОЧКОВ (XP):
- Прибыльная сделка +$10: +10 XP | Целевой профит ($8-20): +5 бонус
- Win streak x2+: +5 за каждую серию | Чистый выход по TP: +3
- Убыток: -5 за каждые $10 | SL дисциплина: +3 (SL = норма, не ошибка)
- Крупный убыток >$30: -10 штраф | Loss streak x3+: -5 за каждую серию
- ДНЕВНАЯ ЦЕЛЬ достигнута: +25 XP бонус!
- Уровни: 🌱Новичок(0) → 📈Трейдер(25) → ⭐Мастер(60) → 👑Легенда(100)
${
  d.xpHistory.length > 0
    ? `Последние XP: ${d.xpHistory
        .slice(-3)
        .map((e) => `${e.delta >= 0 ? '+' : ''}${e.delta} (${e.reason})`)
        .join(' | ')}`
    : ''
}

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

СТРАТЕГИЯ — БЫСТРЫЕ СДЕЛКИ (Quick Profit):
- 🎯 Цель дня: +$${DAILY_PROFIT_TARGET} = 3 сделки × $15. Это реально!
- ФИЛОСОФИЯ: зашёл → забрал +$15-20 → вышел. Не жди больших движений!
- TP на 1.0-1.5R от entry (близкий, достижимый). Лучше +$15 в кармане чем +$30 на экране
- SL на 1.5×ATR (тесный) — маленький риск, большая позиция, быстрый профит
- Максимум ${config.maxOpenPositions} позиции одновременно, ${config.maxDailyTrades} сделок в день
- Риск: ${(() => {
    const dr = state.getDynamicRisk();
    return `${(dr.risk * 100).toFixed(1)}% (${dr.reason})`;
  })()}, макс $${config.maxRiskPerTrade}

ПРАВИЛА ВХОДА:
- КРИТИЧНО: если тебе дали кандидата — система УЖЕ проверила score и confidence. Они ДОСТАТОЧНЫ
- ЗАПРЕЩЕНО отказывать по причине "score ниже X" или "confidence ниже Y"
- Твоя задача: проверить контекст (тренд, уровни, дивергенции). НЕ пересчитывать пороги
- ENTER если: направление ясное + нет ЯВНОГО противопоказания
- SKIP если: сигналы ПРОТИВОРЕЧАТ друг другу ИЛИ цена у ключевого уровня ПРОТИВ направления

ТВОЙ СОБСТВЕННЫЙ АНАЛИЗ:
- Тебе даны M15 свечи, RSI, ATR, EMA, H4 тренд, orderbook imbalance, S/R уровни, funding rate
- АНАЛИЗИРУЙ price action: паттерны свечей (engulfing, pin bar, doji), тренд по EMA, RSI дивергенции
- ПРОВЕРЯЙ: цена не упирается в S/R? RSI не в экстремуме ПРОТИВ направления? Orderbook подтверждает?
- Используй ЭТИ данные для подтверждения/опровержения сигнала — это твоя добавочная ценность
- Можешь скорректировать SL/TP на основе S/R уровней (MODIFY_SL/MODIFY_TP в ENTER ответе)
- Макс 3 позиции одновременно
- Коррелированные: SOL+AVAX+SUI (одна группа), ETH+LINK (другая) — макс 1 на группу
- 4 стопа за день = система остановит торговлю автоматически
- Дневной убыток >= $${config.maxDailyLoss.toFixed(0)} = система остановит торговлю автоматически
- НЕ РЕШАЙ сам "хватит торговать на сегодня" — это делает система по лимитам
- Если есть кандидат — ВХОДИ, даже если были убытки. Система контролирует риск

УПРАВЛЕНИЕ ПОЗИЦИЯМИ:
- МИНИМУМ 30 МИНУТ — не трогай позицию младше 30 мин (кроме если ⚠️ СИГНАЛ ПРОТИВ). Confluence score скачет между циклами — это нормально, НЕ паникуй.
- Confluence score может временно упасть — это НЕ значит "пропал". Пропал = 3+ цикла подряд (15 мин) без сигнала.
- Если позиция в плюсе >1.5R — подтяни SL в безубыток (MODIFY_SL)
- Если позиция в плюсе >2R — подтяни SL на +1R
- CLOSE только если: (1) позиция > 30 мин И ⚠️ СИГНАЛ ПРОТИВ, ИЛИ (2) позиция в минусе > 30 мин И confluence отсутствует
- НЕ ЗАКРЫВАЙ позицию в плюсе при пропаже confluence — подтяни SL в безубыток и дай отработать до TP
- Для позиции с SL: позволь SL работать! Ты выставил SL по причине — дай ему отработать, не закрывай раньше

ЖЁСТКИЕ ПРАВИЛА:
- Позиция > 30 мин + В МИНУСЕ + confluence пропал (нет score 3+ циклов) → CLOSE
- Позиция В ПЛЮСЕ + confluence пропал → MODIFY_SL в безубыток, НЕ CLOSE
- Позиция < 30 мин → WAIT, НЕ CLOSE (кроме ⚠️ СИГНАЛ ПРОТИВ)
- Всплеск score БЕЗ тренда (предыдущие score ~0, потом резко 40+) → WAIT
- Усиление СУЩЕСТВУЮЩЕГО тренда (было -16, стало -34) — это подтверждение! ENTER если alignment есть
- trend(4): все значения одного знака и растут → тренд стабильный, входи

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

    // Возраст позиции
    const ageMin = p.openedAt
      ? Math.round((Date.now() - new Date(p.openedAt).getTime()) / 60_000)
      : 0;
    const ageStr = ageMin < 60 ? `${ageMin}мин` : `${Math.floor(ageMin / 60)}ч${ageMin % 60}мин`;

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
        ` | PnL=${pnlSign}$${pnl.toFixed(2)} (${rMult}) | возраст: ${ageStr}` +
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

    const scoreInfo =
      score !== null ? `score=${score} (${sigSide})` : 'нет сигнала (это нормально, score скачет)';
    const flag = isOpposite ? ' ⚠️ СИГНАЛ ПРОТИВ ПОЗИЦИИ' : '';

    // Возраст позиции
    const ageMin = p.openedAt
      ? Math.round((Date.now() - new Date(p.openedAt).getTime()) / 60_000)
      : 0;
    const ageNote = ageMin < 30 ? ` [МОЛОДАЯ ${ageMin}мин — НЕ ЗАКРЫВАЙ]` : '';

    reviewLines.push(`${p.symbol} ${p.side}: confluence ${scoreInfo}${flag}${ageNote}`);
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
  const xpStatus = state.getXpStatus();
  const progressPct = Math.min(100, Math.max(0, (d.totalPnl / DAILY_PROFIT_TARGET) * 100));
  const progressBar =
    progressPct >= 100
      ? '████████ ЦЕЛЬ!'
      : '█'.repeat(Math.floor(progressPct / 12.5)) + '░'.repeat(8 - Math.floor(progressPct / 12.5));

  return (
    `День: сделок=${d.trades}/${config.maxDailyTrades} (win=${d.wins} loss=${d.losses} stops=${d.stops}/${config.maxStopsPerDay})` +
    ` PnL=${pnlSign}$${d.totalPnl.toFixed(2)}${stopDayNote}\n` +
    `Цель: [${progressBar}] ${progressPct.toFixed(0)}% ($${d.totalPnl.toFixed(0)}/$${DAILY_PROFIT_TARGET})` +
    ` | ${xpStatus.emoji} ${xpStatus.level} ${d.xp} XP\n`
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

function buildMarketDataBlock(md: SignalMarketData): string {
  const lines: string[] = [];

  // Свечи M15 — компактный формат
  const candles = md.candles.map((c) => `${c.t} O=${c.o} H=${c.h} L=${c.l} C=${c.c}`);
  lines.push(`  M15 свечи (${md.candles.length}): ${candles.join(' | ')}`);

  // Быстрые EMA — ранний тренд
  const fastTrend =
    md.ema9 != null && md.ema21 != null
      ? md.ema9 > md.ema21
        ? 'BULLISH'
        : md.ema9 < md.ema21
          ? 'BEARISH'
          : 'FLAT'
      : '?';
  const fastEmas = [
    md.ema9 ? `EMA9=${md.ema9.toPrecision(6)}` : null,
    md.ema21 ? `EMA21=${md.ema21.toPrecision(6)}` : null,
  ]
    .filter(Boolean)
    .join(' ');
  const impulseStr =
    md.impulse !== 0 ? ` IMPULSE=${md.impulse > 0 ? '+' : ''}${md.impulse.toFixed(1)}` : '';
  lines.push(
    `  FastTrend: ${fastTrend} (${fastEmas}) ROC2=${md.roc2 >= 0 ? '+' : ''}${md.roc2.toFixed(2)}% ROC6=${md.roc6 >= 0 ? '+' : ''}${md.roc6.toFixed(2)}%${impulseStr}`,
  );

  // Медленные EMA
  const slowEmas = [
    md.ema20 ? `EMA20=${md.ema20.toPrecision(6)}` : null,
    md.ema50 ? `EMA50=${md.ema50.toPrecision(6)}` : null,
    md.ema200 ? `EMA200=${md.ema200.toPrecision(6)}` : null,
  ]
    .filter(Boolean)
    .join(' ');
  lines.push(`  M15: RSI=${md.rsi14.toFixed(1)} ATR=${md.atr14.toPrecision(4)} ${slowEmas}`);
  lines.push(`  H4: тренд=${md.h4Trend} RSI=${md.h4Rsi.toFixed(1)}`);

  // Рыночные данные
  const vol =
    md.volume24h >= 1e9
      ? `$${(md.volume24h / 1e9).toFixed(1)}B`
      : `$${(md.volume24h / 1e6).toFixed(0)}M`;
  lines.push(
    `  24ч: ${md.price24hPct >= 0 ? '+' : ''}${md.price24hPct.toFixed(2)}% | low=${md.low24h} high=${md.high24h} | vol=${vol}`,
  );
  lines.push(
    `  FR=${(md.fundingRate * 100).toFixed(4)}% | OB imbalance=${md.obImbalance} (>1=покупатели)`,
  );
  lines.push(`  S/R: support=${md.support} resistance=${md.resistance}`);

  return lines.join('\n');
}

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

  let block =
    `${sig.pair}${watchFlag} ${sig.side} | score=${sig.confluence.total}(${sig.confluence.signal}) conf=${sig.confidence}% regime=${sig.regime}\n` +
    `  entry=${sig.entryPrice} SL=${sig.sl} TP=${sig.tp} R:R=${sig.rr}\n` +
    `  trend(4): ${scores || 'нет'} ${trend}\n` +
    `  ${sig.confluence.details.slice(0, 4).join(' | ')}`;

  // Дополнительные рыночные данные для Claude
  if (sig.marketData) {
    block += '\n' + buildMarketDataBlock(sig.marketData);
  }

  return block;
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
