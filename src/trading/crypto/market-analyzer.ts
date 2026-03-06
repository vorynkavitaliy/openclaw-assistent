import { createLogger } from '../../utils/logger.js';
import { calculateConfluenceScore, type ConfluenceInput } from '../shared/confluence.js';
import { detectMarketRegime, getRegimeThreshold } from '../shared/regime.js';
import type { ConfluenceScore } from '../shared/types.js';
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

// Динамический R:R: в сильном тренде целим дальше, в боковике — быстрее забираем
function getRegimeRR(regime: string): number {
  switch (regime as MarketRegime) {
    case 'STRONG_TREND':
      return 2.5;
    case 'WEAK_TREND':
      return 2.0;
    case 'RANGING':
      return 1.5;
    case 'VOLATILE':
      return 1.8;
    case 'CHOPPY':
      return 1.8; // не должен дойти сюда (блок в threshold)
  }
}

// Per-pair cooldown: не торгуем пару если недавно уже была сделка
const lastTradeTime = new Map<string, number>();

export function recordPairTrade(pair: string): void {
  lastTradeTime.set(pair, Date.now());
}

function isPairOnCooldown(pair: string): boolean {
  const last = lastTradeTime.get(pair);
  if (!last) return false;
  return Date.now() - last < config.pairCooldownMin * 60 * 1000;
}

function getPairCooldownRemaining(pair: string): number {
  const last = lastTradeTime.get(pair);
  if (!last) return 0;
  const remaining = config.pairCooldownMin * 60 * 1000 - (Date.now() - last);
  return Math.max(0, Math.ceil(remaining / 60_000));
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
}

// Параллельный анализ с ограничением пропускной способности
// Каждая пара делает ~12 API запросов, Bybit лимит ~20 req/sec
const ANALYSIS_CONCURRENCY = 3;

export async function analyzeMarket(
  cycleId: string,
  singlePair?: string,
): Promise<TradeSignalInternal[]> {
  const pairs = singlePair ? [singlePair.toUpperCase()] : config.pairs;
  const signals: TradeSignalInternal[] = [];

  // Батчи по ANALYSIS_CONCURRENCY пар
  for (let i = 0; i < pairs.length; i += ANALYSIS_CONCURRENCY) {
    const batch = pairs.slice(i, i + ANALYSIS_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (pair) => {
        try {
          return await analyzePairV2(pair, cycleId);
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

async function analyzePairV2(pair: string, cycleId: string): Promise<TradeSignalInternal | null> {
  // Per-pair cooldown
  if (isPairOnCooldown(pair)) {
    const remaining = getPairCooldownRemaining(pair);
    logDecision(cycleId, 'skip', pair, 'PAIR_COOLDOWN', [
      `Cooldown: ещё ${remaining} мин до следующей сделки`,
    ]);
    return null;
  }

  // Собираем все данные параллельно
  const [
    market,
    d1,
    h4,
    h1,
    m15,
    m5,
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
    getMarketAnalysis(pair, '5', 100).catch(() => null),
    getOrderbook(pair, 25).catch(() => null),
    getOIHistory(pair, 24).catch(() => []),
    getFundingHistory(pair, 20).catch(() => []),
    getRecentTrades(pair, 500).catch(() => []),
    getKlines(pair, '15', 200).catch(() => []),
    getKlines(pair, '240', 200).catch(() => []),
  ]);

  if (!m15 || !market || !orderbook) return null;

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

  // Confluence scoring
  const input: ConfluenceInput = {
    trendTF: d1 ?? h4,
    zonesTF: h1,
    entryTF: m15,
    precisionTF: m5,
    entryCandles: m15Candles,
    orderbook,
    oiHistory,
    fundingHistory,
    volumeProfile,
    regime,
    market,
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

  if (absScore < threshold) {
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

  // Фильтр: не торгуем против старшего тренда в сильном/слабом тренде
  // Если D1/H4 показывает BULLISH — не шортим, если BEARISH — не лонгим
  const trendBias = (d1 ?? h4)?.bias.emaTrend;
  if (regime === 'STRONG_TREND' || regime === 'WEAK_TREND') {
    if (trendBias === 'BULLISH' && side === 'Sell') {
      logDecision(cycleId, 'skip', pair, 'AGAINST_TREND', [
        `Sell сигнал при BULLISH тренде (${regime}) — пропускаем`,
      ]);
      return null;
    }
    if (trendBias === 'BEARISH' && side === 'Buy') {
      logDecision(cycleId, 'skip', pair, 'AGAINST_TREND', [
        `Buy сигнал при BEARISH тренде (${regime}) — пропускаем`,
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

  // SL: ATR * atrSlMultiplier от entry
  const slDistance = atr * config.atrSlMultiplier;

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

  // Динамический R:R в зависимости от режима рынка
  const rr = getRegimeRR(regime);

  // TP: используем динамический RR
  const tp = side === 'Buy' ? entry + slDistance * rr : entry - slDistance * rr;

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
  };
}
