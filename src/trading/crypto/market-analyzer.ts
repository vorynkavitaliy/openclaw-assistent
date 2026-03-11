import { createLogger } from '../../utils/logger.js';
import { calculateConfluenceScore, type ConfluenceInput } from '../shared/confluence.js';
import { detectMarketRegime, getRegimeThreshold } from '../shared/regime.js';
import type { ConfluenceScore } from '../shared/types.js';
import { analyzeSMC } from '../shared/smart-money.js';
import { buildVolumeProfile } from '../shared/volume-analysis.js';
import {
  getFundingHistory,
  getKlines,
  getMarketAnalysis,
  getMarketInfo,
  getOIHistory,
  getOrderbook,
  getRecentTrades,
} from './bybit-client.js';
import config from './config.js';
import { logDecision } from './decision-journal.js';
import { saveScore } from './market-snapshot.js';
import * as state from './state.js';
import { roundPrice } from './symbol-specs.js';

import type { MarketRegime } from '../shared/types.js';

const log = createLogger('market-analyzer');

// Динамический R:R: в сильном тренде целим дальше, в боковике — быстрее забираем.
// Чем сильнее confluence score — тем ближе к максимальному RR для данного режима.
// strength = min(|confluenceScore| / 75, 1), итоговый RR = baseRR + (maxRR - baseRR) * strength
// Quick profit strategy: быстрые TP, цель +$15-20 за сделку
// Низкий R:R но высокий winrate — 3 сделки × $15 = $45/день
function getRegimeRR(regime: string, confluenceScore: number): number {
  const strength = Math.min(Math.abs(confluenceScore) / 75, 1);
  switch (regime as MarketRegime) {
    case 'STRONG_TREND':
      return 1.2 + (1.8 - 1.2) * strength; // 1.2–1.8R (было 2.0–3.0)
    case 'WEAK_TREND':
      return 1.0 + (1.3 - 1.0) * strength; // 1.0–1.3R (было 1.5–2.0)
    case 'RANGING':
      return 1.0 + (1.2 - 1.0) * strength; // 1.0–1.2R (было 1.2–1.5)
    case 'VOLATILE':
      return 1.0 + (1.5 - 1.0) * strength; // 1.0–1.5R (было 1.5–2.0)
    case 'CHOPPY':
      return 1.0 + (1.2 - 1.0) * strength; // 1.0–1.2R (было 1.2–1.5)
  }
}

/**
 * Adaptive ATR SL multiplier по режиму рынка.
 * STRONG_TREND: тесный SL (тренд защищает позицию)
 * RANGING: тесный SL (торгуем от S/R)
 * VOLATILE: широкий SL (не стопит на шуме)
 * CHOPPY: стандартный (если вообще торгуем)
 */
function getAdaptiveSlMultiplier(regime: string, base: number): number {
  switch (regime as MarketRegime) {
    case 'STRONG_TREND':
      return base * 0.8; // Тесный SL: тренд защищает
    case 'WEAK_TREND':
      return base; // Стандартный
    case 'RANGING':
      return base * 0.7; // Очень тесный: торгуем от S/R
    case 'VOLATILE':
      return base * 1.4; // Широкий: не стопить на шуме
    case 'CHOPPY':
      return base; // Стандартный
  }
}

// Per-pair cooldown: не торгуем пару если недавно уже была сделка (персистентно через state)
function isPairOnCooldown(pair: string): boolean {
  return state.isPairCooldownActive(pair, config.pairCooldownMin * 60 * 1000);
}

function getPairCooldownRemaining(pair: string): number {
  const last = state.getPairLastTrade(pair);
  if (!last) return 0;
  const remaining = config.pairCooldownMin * 60 * 1000 - (Date.now() - new Date(last).getTime());
  return Math.max(0, Math.ceil(remaining / 60_000));
}

/** Компактные рыночные данные для Claude — чтобы он мог делать собственный анализ */
export interface SignalMarketData {
  /** Последние N M15 свечей (OHLC) */
  candles: Array<{ t: string; o: number; h: number; l: number; c: number }>;
  /** Ключевые индикаторы M15 */
  rsi14: number;
  atr14: number;
  ema9: number | null;
  ema21: number | null;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  ema3: number | null;
  roc6: number;
  roc2: number;
  impulse: number;
  /** H4 тренд */
  h4Trend: string;
  h4Rsi: number;
  /** Рыночная инфо */
  price24hPct: number;
  high24h: number;
  low24h: number;
  fundingRate: number;
  volume24h: number;
  /** Orderbook: bid/ask imbalance (>1 = больше покупателей) */
  obImbalance: number;
  /** S/R уровни */
  support: number;
  resistance: number;
}

export interface TradeSignalInternal {
  pair: string;
  side: 'Buy' | 'Sell';
  entryPrice: number;
  sl: number;
  tp: number;
  rr: number;
  reason: string;
  confluence: ConfluenceScore;
  regime: string;
  confidence: number;
  recentCloses?: number[]; // M15 closes за 24ч для корреляционного фильтра
  marketData?: SignalMarketData; // Доп. данные для Claude
}

// Параллельный анализ с ограничением пропускной способности
// Каждая пара делает ~12 API запросов, Bybit лимит ~20 req/sec
const ANALYSIS_CONCURRENCY = 27; // Все пары параллельно — rate limiter контролирует API

/**
 * Фильтр торговых сессий — не торгуем в неликвидное время.
 * Asia dead zone: 21:00-01:00 UTC (переход из US в Asia)
 * Лучшее время: London 07:00-16:00 UTC, US 13:00-21:00 UTC
 */
function isTradingSessionActive(): boolean {
  const utcHour = new Date().getUTCHours();
  // Блокируем 21:00-05:00 UTC (Asia dead zone + ранняя Asia)
  // Это Kyiv 23:00-07:00 — ночь, объёмы минимальны
  if (utcHour >= 21 || utcHour < 5) return false;
  return true;
}

export async function analyzeMarket(
  cycleId: string,
  singlePair?: string,
): Promise<TradeSignalInternal[]> {
  // Session filter — не генерируем сигналы в мёртвое время
  if (!isTradingSessionActive()) {
    const utcHour = new Date().getUTCHours();
    log.info('Trading session inactive — skipping signal generation', {
      utcHour,
      note: 'Active: 05:00-21:00 UTC (London+US sessions)',
    });
    logDecision(cycleId, 'skip', 'ALL', 'SESSION_INACTIVE', [
      `UTC ${utcHour}:00 — неактивная сессия (Asia dead zone 21-05 UTC)`,
    ]);
    return [];
  }

  // Max daily trades — не перетрейдим
  const dailyTrades = state.get().daily.trades;
  if (dailyTrades >= config.maxDailyTrades) {
    log.info('Max daily trades reached — skipping new entries', {
      trades: dailyTrades,
      max: config.maxDailyTrades,
    });
    logDecision(cycleId, 'skip', 'ALL', 'MAX_DAILY_TRADES', [
      `${dailyTrades} сделок сегодня >= лимит ${config.maxDailyTrades} — хватит торговать`,
    ]);
    return [];
  }

  const pairs = singlePair ? [singlePair.toUpperCase()] : config.pairs;
  const signals: TradeSignalInternal[] = [];

  // Получаем BTC данные один раз перед циклом по парам (экономия API запросов)
  const btcMarket = config.btcCorrelationFilter
    ? await getMarketInfo('BTCUSDT').catch(() => null)
    : null;

  // Батчи по ANALYSIS_CONCURRENCY пар
  for (let i = 0; i < pairs.length; i += ANALYSIS_CONCURRENCY) {
    const batch = pairs.slice(i, i + ANALYSIS_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (pair) => {
        try {
          return await analyzePairV2(pair, cycleId, btcMarket);
        } catch (err) {
          state.logEvent('analysis_error', { pair, error: (err as Error).message });
          return null;
        }
      }),
    );
    for (const signal of batchResults) {
      if (signal) signals.push(signal);
    }
  }

  // Сортируем по силе confluence score (лучшие сигналы первыми)
  signals.sort((a, b) => Math.abs(b.confluence.total) - Math.abs(a.confluence.total));

  return signals;
}

async function analyzePairV2(
  pair: string,
  cycleId: string,
  cachedBtcMarket: Awaited<ReturnType<typeof getMarketInfo>> | null,
): Promise<TradeSignalInternal | null> {
  // Per-pair cooldown
  if (isPairOnCooldown(pair)) {
    const remaining = getPairCooldownRemaining(pair);
    logDecision(cycleId, 'skip', pair, 'PAIR_COOLDOWN', [
      `Cooldown: ещё ${remaining} мин до следующей сделки`,
    ]);
    return null;
  }

  // Собираем все данные параллельно (M5 не загружаем — экономия API запросов)
  const [
    market,
    d1,
    h4,
    h1,
    m15,
    orderbook,
    oiHistory,
    fundingHistory,
    recentTrades,
    m15Candles,
    h4Candles,
  ] = await Promise.all([
    getMarketInfo(pair).catch(() => null),
    getMarketAnalysis(pair, 'D', 200).catch(() => null),
    getMarketAnalysis(pair, '240', 200).catch(() => null),
    getMarketAnalysis(pair, '60', 200).catch(() => null),
    getMarketAnalysis(pair, '15', 200).catch(() => null),
    getOrderbook(pair, 25).catch(() => null),
    getOIHistory(pair, 24).catch(() => []),
    getFundingHistory(pair, 20).catch(() => []),
    getRecentTrades(pair, 500).catch(() => []),
    getKlines(pair, '15', 200).catch(() => []),
    getKlines(pair, '240', 200).catch(() => []),
  ]);

  if (!m15 || !market || !orderbook) return null;

  // Минимальный 24h объём — отсеиваем неликвидные инструменты
  const MIN_VOLUME_24H = 5_000_000; // $5M минимум (снижен — фильтр отсекал слишком много пар)
  if (market.turnover24h < MIN_VOLUME_24H) {
    logDecision(cycleId, 'skip', pair, 'LOW_VOLUME', [
      `24h volume $${(market.turnover24h / 1_000_000).toFixed(1)}M < min $${MIN_VOLUME_24H / 1_000_000}M`,
    ]);
    return null;
  }

  // Пустой orderbook — API вернул ошибку или данных нет
  if (orderbook.bids.length === 0 || orderbook.asks.length === 0) {
    log.debug('Empty orderbook: skip', { pair });
    logDecision(cycleId, 'skip', pair, 'EMPTY_ORDERBOOK', [
      'Orderbook пуст — нет данных для анализа',
    ]);
    return null;
  }

  // Спред-фильтр — отклоняем вход при аномальном спреде
  const spreadPct = market.lastPrice > 0 ? (orderbook.spread / market.lastPrice) * 100 : 0;
  if (spreadPct > config.maxSpreadPercent) {
    log.debug('Spread filter: skip', {
      pair,
      spreadPct: spreadPct.toFixed(4),
      max: config.maxSpreadPercent,
    });
    logDecision(
      cycleId,
      'skip',
      pair,
      'SPREAD_TOO_HIGH',
      [`Спред ${spreadPct.toFixed(4)}% > лимит ${config.maxSpreadPercent}%`],
      {
        filters: {
          spread: {
            passed: false,
            value: spreadPct.toFixed(4) + '%',
            threshold: config.maxSpreadPercent + '%',
          },
        },
        marketContext: { price: market.lastPrice, spread: spreadPct },
      },
    );
    return null;
  }

  // Funding rate фильтр — контекстный по направлению
  // Extreme positive funding → опасно для LONG (рынок перегрет лонгами)
  // Extreme negative funding → опасно для SHORT (рынок перегрет шортами)
  // Но НЕ блокируем противоположное направление: negative funding хорош для LONG
  const fr = market.fundingRate;

  // Volume profile from M15 candles + recent trades (fallback при отсутствии данных)
  const volumeProfile = m15Candles.length > 0 ? buildVolumeProfile(m15Candles, recentTrades) : null;
  if (!volumeProfile) {
    log.debug('No volume profile data, using neutral fallback', { pair });
  }

  // Market regime from H4 candles
  const regime = h4Candles.length >= 50 ? detectMarketRegime(h4Candles) : 'RANGING';

  // Smart Money Concepts analysis
  const smcAnalysis = m15Candles.length >= 30 ? analyzeSMC(m15Candles, market.lastPrice) : null;

  // Confluence scoring (precisionTF=null — M5 не загружаем для экономии API запросов)
  const input: ConfluenceInput = {
    trendTF: d1 ?? h4,
    zonesTF: h1,
    entryTF: m15,
    precisionTF: null,
    entryCandles: m15Candles,
    orderbook,
    oiHistory,
    fundingHistory,
    volumeProfile,
    regime,
    market,
    smcAnalysis,
  };
  const confluence = calculateConfluenceScore(input);

  // Проверяем минимальный порог для режима рынка
  const threshold = getRegimeThreshold(regime);
  const absScore = Math.abs(confluence.total);

  // Логируем и сохраняем ВСЕ confluence scores для калибровки и истории
  log.info('Confluence score', {
    pair,
    cycleId,
    score: confluence.total,
    absScore,
    threshold,
    regime,
    confidence: confluence.confidence,
    signal: confluence.signal,
    pass: absScore >= threshold,
  });
  saveScore(
    cycleId,
    pair,
    market.lastPrice,
    regime,
    confluence.total,
    confluence.signal,
    confluence.confidence,
  );

  // Momentum breakout bypass: сильный momentum может пропустить слабый confluence
  // Это ловит ранние развороты когда EMA ещё bearish, но MACD/RSI уже bullish
  const momentumBreakout = Math.abs(confluence.momentum) >= 8;

  if (absScore < threshold && !momentumBreakout) {
    logDecision(
      cycleId,
      'skip',
      pair,
      'CONFLUENCE_BELOW_THRESHOLD',
      [
        `Confluence ${confluence.total} (|${absScore}|) < порог ${threshold} для ${regime}`,
        ...confluence.details.slice(0, 3),
      ],
      {
        confluenceScore: confluence.total,
        confluenceSignal: confluence.signal,
        confidence: confluence.confidence,
        regime,
        marketContext: {
          price: market.lastPrice,
          rsi14: m15.indicators.rsi14,
          atr14: m15.indicators.atr14,
          fundingRate: fr,
        },
      },
    );
    return null;
  }

  if (momentumBreakout && absScore < threshold) {
    log.info('Momentum breakout bypass', {
      pair,
      momentum: confluence.momentum,
      score: confluence.total,
      threshold,
      regime,
    });
  }

  // Фильтр минимального confidence
  if (confluence.confidence < config.minConfidence) {
    logDecision(
      cycleId,
      'skip',
      pair,
      'LOW_CONFIDENCE',
      [
        `Confidence ${confluence.confidence}% < минимум ${config.minConfidence}%`,
        `Score ${confluence.total}, regime ${regime}`,
      ],
      {
        confluenceScore: confluence.total,
        confidence: confluence.confidence,
        regime,
      },
    );
    return null;
  }

  // Определяем сторону сделки
  const side: 'Buy' | 'Sell' = confluence.total > 0 ? 'Buy' : 'Sell';
  const atr = m15.indicators.atr14;
  const price = market.lastPrice;

  if (atr === 0 || price === 0) return null;

  // H4 RSI extreme filter: не шортить в oversold, не лонгить в overbought на старшем ТФ
  const h4Rsi = h4?.indicators.rsi14 ?? 50;
  if (side === 'Sell' && h4Rsi < 33) {
    logDecision(cycleId, 'skip', pair, 'H4_RSI_OVERSOLD', [
      `Short при H4 RSI=${h4Rsi.toFixed(1)} (oversold < 33) — высокий риск отскока`,
    ]);
    return null;
  }
  if (side === 'Buy' && h4Rsi > 67) {
    logDecision(cycleId, 'skip', pair, 'H4_RSI_OVERBOUGHT', [
      `Long при H4 RSI=${h4Rsi.toFixed(1)} (overbought > 67) — высокий риск отката`,
    ]);
    return null;
  }

  // 24h Low/High proximity filter: не шортить у дна дня, не лонгить у вершины
  const distTo24hLow = ((price - market.low24h) / price) * 100;
  const distTo24hHigh = ((market.high24h - price) / price) * 100;
  if (side === 'Sell' && distTo24hLow < 1.0) {
    logDecision(cycleId, 'skip', pair, 'NEAR_24H_LOW', [
      `Short при цене ${distTo24hLow.toFixed(2)}% от 24h low (${market.low24h}) — риск отскока от дна`,
    ]);
    return null;
  }
  if (side === 'Buy' && distTo24hHigh < 1.0) {
    logDecision(cycleId, 'skip', pair, 'NEAR_24H_HIGH', [
      `Long при цене ${distTo24hHigh.toFixed(2)}% от 24h high (${market.high24h}) — риск отката от вершины`,
    ]);
    return null;
  }

  // SMC Entry Gate: не входим ВНУТРИ antagonist Order Block
  if (smcAnalysis) {
    if (side === 'Buy' && smcAnalysis.nearestBearishOB) {
      const ob = smcAnalysis.nearestBearishOB;
      if (price >= ob.low && price <= ob.high) {
        logDecision(cycleId, 'skip', pair, 'SMC_INSIDE_BEARISH_OB', [
          `Long внутри Bearish OB [${ob.low}–${ob.high}] — институциональная зона продажи`,
        ]);
        return null;
      }
    }
    if (side === 'Sell' && smcAnalysis.nearestBullishOB) {
      const ob = smcAnalysis.nearestBullishOB;
      if (price >= ob.low && price <= ob.high) {
        logDecision(cycleId, 'skip', pair, 'SMC_INSIDE_BULLISH_OB', [
          `Short внутри Bullish OB [${ob.low}–${ob.high}] — институциональная зона покупки`,
        ]);
        return null;
      }
    }
  }

  // Жёсткий intraday фильтр: не торгуем ПРОТИВ дневного движения > 3%
  // Если пара +3%+ за 24ч — не шортим. Если -3%+ — не лонгим
  const pct24h = market.price24hPct;
  if (side === 'Sell' && pct24h > 3) {
    logDecision(cycleId, 'skip', pair, 'INTRADAY_BULLISH', [
      `Short при +${pct24h.toFixed(1)}% за 24ч — не шортим растущий актив`,
    ]);
    return null;
  }
  if (side === 'Buy' && pct24h < -3) {
    logDecision(cycleId, 'skip', pair, 'INTRADAY_BEARISH', [
      `Long при ${pct24h.toFixed(1)}% за 24ч — не лонгуем падающий актив`,
    ]);
    return null;
  }

  // Фильтр: не торгуем против старшего тренда в сильном/слабом тренде
  // Если D1/H4 показывает BULLISH — не шортим, если BEARISH — не лонгим
  const trendBias = (d1 ?? h4)?.bias.emaTrend;
  if (regime === 'STRONG_TREND' || regime === 'WEAK_TREND') {
    const absScore = Math.abs(confluence.total);
    if (trendBias === 'BULLISH' && side === 'Sell') {
      if (absScore >= 30) {
        logDecision(cycleId, 'entry', pair, 'AGAINST_TREND_OVERRIDE', [
          `Sell против BULLISH тренда (${regime}), но score=${confluence.total} достаточно сильный — разрешаем`,
        ]);
      } else {
        logDecision(cycleId, 'skip', pair, 'AGAINST_TREND', [
          `Sell сигнал при BULLISH тренде (${regime}), score=${confluence.total} < 30 — пропускаем`,
        ]);
        return null;
      }
    }
    if (trendBias === 'BEARISH' && side === 'Buy') {
      if (absScore >= 30) {
        logDecision(cycleId, 'entry', pair, 'AGAINST_TREND_OVERRIDE', [
          `Buy против BEARISH тренда (${regime}), но score=${confluence.total} достаточно сильный — разрешаем`,
        ]);
      } else {
        logDecision(cycleId, 'skip', pair, 'AGAINST_TREND', [
          `Buy сигнал при BEARISH тренде (${regime}), score=${confluence.total} < 30 — пропускаем`,
        ]);
        return null;
      }
    }
  }

  // BTC корреляция: альты следуют за BTC
  // Если BTC в bearish тренде, не открываем лонги на альтах
  // Если BTC в bullish тренде, не открываем шорты на альтах
  if (config.btcCorrelationFilter && pair !== 'BTCUSDT' && cachedBtcMarket) {
    const btc24h = cachedBtcMarket.price24hPct;
    // BTC падает больше 3% за 24ч — не лонгуем альты
    if (side === 'Buy' && btc24h < -3) {
      logDecision(cycleId, 'skip', pair, 'BTC_BEARISH', [
        `BTC 24h: ${btc24h.toFixed(2)}% — не лонгуем альты при падающем BTC`,
      ]);
      return null;
    }
    // BTC растёт больше 3% за 24ч — не шортим альты (они летят за BTC)
    if (side === 'Sell' && btc24h > 3) {
      logDecision(cycleId, 'skip', pair, 'BTC_BULLISH', [
        `BTC 24h: +${btc24h.toFixed(2)}% — не шортим альты при растущем BTC`,
      ]);
      return null;
    }
  }

  // Повышенный порог confidence для "слабых" пар
  if (config.weakPairs.includes(pair)) {
    const weakThreshold = config.minConfidence + config.weakPairConfidenceBonus;
    if (confluence.confidence < weakThreshold) {
      logDecision(cycleId, 'skip', pair, 'WEAK_PAIR_LOW_CONFIDENCE', [
        `Слабая пара: confidence ${confluence.confidence}% < повышенный порог ${weakThreshold}%`,
      ]);
      return null;
    }
  }

  // Direction-aware funding filter:
  // Extreme positive FR → блокируем LONG (лонги перегреты)
  // Extreme negative FR → блокируем SHORT (шорты перегреты)
  const EXTREME_FR = 0.01; // 1% — действительно экстремальный
  if (side === 'Buy' && fr > config.maxFundingRate) {
    logDecision(cycleId, 'skip', pair, 'FUNDING_BLOCKS_LONG', [
      `Funding rate ${(fr * 100).toFixed(3)}% слишком высокий для LONG (лимит ${(config.maxFundingRate * 100).toFixed(2)}%)`,
    ]);
    return null;
  }
  if (side === 'Sell' && fr < -EXTREME_FR) {
    logDecision(cycleId, 'skip', pair, 'FUNDING_BLOCKS_SHORT', [
      `Funding rate ${(fr * 100).toFixed(3)}% слишком отрицательный для SHORT (шорты перегреты)`,
    ]);
    return null;
  }

  // Entry: Limit ордер (bid1 для Buy, ask1 для Sell)
  const entry =
    side === 'Buy' ? (orderbook.bids[0]?.price ?? price) : (orderbook.asks[0]?.price ?? price);

  // Sanity check: entry не должен отклоняться от lastPrice более чем на 5%
  const entryDeviation = Math.abs(entry - price) / price;
  if (entryDeviation > 0.05) {
    log.warn('Entry price sanity check failed', {
      pair,
      entry,
      lastPrice: price,
      deviationPct: (entryDeviation * 100).toFixed(2),
    });
    return null;
  }

  // SL: ATR * adaptive SL multiplier (зависит от режима рынка)
  const slMultiplier = getAdaptiveSlMultiplier(regime, config.atrSlMultiplier);
  const slDistance = atr * slMultiplier;

  // Sanity check: SL distance должен быть в разумных пределах (0.1%-20% от entry)
  const slDistancePct = slDistance / entry;
  if (slDistancePct < 0.001 || slDistancePct > 0.2) {
    log.warn('SL distance sanity check failed', {
      pair,
      slDistance,
      entry,
      slDistancePct: (slDistancePct * 100).toFixed(4),
    });
    return null;
  }

  const sl = side === 'Buy' ? entry - slDistance : entry + slDistance;

  // Динамический R:R в зависимости от режима рынка и силы confluence score
  const rr = getRegimeRR(regime, confluence.total);

  // TP: используем динамический RR
  const tp = side === 'Buy' ? entry + slDistance * rr : entry - slDistance * rr;

  // Последние 96 M15 свечей = 24ч closes для корреляционного фильтра
  const recentCloses = m15Candles.slice(-96).map((c) => c.close);

  // Orderbook imbalance: сумма bid volume / сумма ask volume (top 10 уровней)
  const bidVol = orderbook.bids.slice(0, 10).reduce((s, b) => s + b.qty, 0);
  const askVol = orderbook.asks.slice(0, 10).reduce((s, a) => s + a.qty, 0);
  const obImbalance = askVol > 0 ? bidVol / askVol : 1;

  // Компактные рыночные данные для Claude
  const marketData: SignalMarketData = {
    candles: m15Candles.slice(-12).map((c) => ({
      t: c.time.slice(11, 16),
      o: c.open,
      h: c.high,
      l: c.low,
      c: c.close,
    })),
    rsi14: m15.indicators.rsi14,
    atr14: m15.indicators.atr14,
    ema9: m15.indicators.ema9,
    ema21: m15.indicators.ema21,
    ema20: m15.indicators.ema20,
    ema50: m15.indicators.ema50,
    ema200: m15.indicators.ema200,
    ema3: m15.indicators.ema3,
    roc6: m15.indicators.roc6,
    roc2: m15.indicators.roc2,
    impulse: m15.indicators.impulse,
    h4Trend: h4?.bias.emaTrend ?? 'UNKNOWN',
    h4Rsi: h4?.indicators.rsi14 ?? 50,
    price24hPct: market.price24hPct,
    high24h: market.high24h,
    low24h: market.low24h,
    fundingRate: fr,
    volume24h: market.turnover24h,
    obImbalance: Math.round(obImbalance * 100) / 100,
    support: m15.levels.support,
    resistance: m15.levels.resistance,
  };

  return {
    pair,
    side,
    entryPrice: roundPrice(entry, pair),
    sl: roundPrice(sl, pair),
    tp: roundPrice(tp, pair),
    rr,
    reason: `${confluence.signal} score=${confluence.total} confidence=${confluence.confidence}% regime=${regime} [${confluence.details.slice(0, 3).join('; ')}]`,
    confluence,
    regime,
    confidence: confluence.confidence,
    recentCloses,
    marketData,
  };
}
