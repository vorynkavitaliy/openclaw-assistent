import { createLogger } from '../../utils/logger.js';
import { getCandles, buildAnalysisFromCandles } from './price-provider.js';
import config from './config.js';
import { calculateConfluenceScore, type ConfluenceInput } from '../shared/confluence.js';
import { detectMarketRegime } from '../shared/regime.js';
import { calculateAtr } from '../shared/indicators.js';
import type { ConfluenceSignal, MarketRegime } from '../shared/types.js';

const log = createLogger('forex-analyzer');

export interface ForexAnalysisResult {
  pair: string;
  confluenceScore: number; // -100..+100
  confidence: number; // 0..100%
  regime: MarketRegime;
  signal: ConfluenceSignal; // STRONG_LONG, LONG, NEUTRAL, SHORT, STRONG_SHORT
  bias: string; // BULLISH, BEARISH, UNKNOWN
  atr: number; // ATR14 на entry TF для расчёта SL
  lastPrice: number;
  details: string[];
}

/**
 * Анализирует одну форекс пару.
 * Загружает данные по двум таймфреймам (H4 для тренда, M15 для входа),
 * определяет режим рынка и рассчитывает confluence score.
 */
export function analyzePair(pair: string): ForexAnalysisResult | null {
  log.debug(`Анализ пары ${pair}...`);

  const trendTf = config.trendTimeframe; // H4
  const entryTf = config.entryTimeframe; // M15

  const m15Candles = getCandles(pair, entryTf, 200);

  if (m15Candles.length < 50) {
    log.warn(`Недостаточно данных для ${pair} (${m15Candles.length} свечей < 50)`);
    return null;
  }

  const [h4Analysis, m15Analysis] = [
    buildAnalysisFromCandles(pair, trendTf, 200),
    buildAnalysisFromCandles(pair, entryTf, 200),
  ];

  if (!m15Analysis) {
    log.warn(`Нет данных M15 для ${pair} — пропускаем`);
    return null;
  }

  const candlesForRegime = m15Candles.length >= 50 ? m15Candles : [];
  const regime: MarketRegime =
    candlesForRegime.length >= 50 ? detectMarketRegime(candlesForRegime) : 'RANGING';

  const currentPrice = m15Analysis.currentPrice;

  // Форекс не имеет orderbook, OI, funding и volume profile —
  // передаём нулевые/пустые данные для корректной работы confluence scoring.
  const input: ConfluenceInput = {
    trendTF: h4Analysis,
    zonesTF: null,
    entryTF: m15Analysis,
    precisionTF: null,
    entryCandles: m15Candles,
    orderbook: {
      bids: [],
      asks: [],
      bidWallPrice: 0,
      askWallPrice: 0,
      imbalance: 0,
      spread: 0,
      timestamp: new Date().toISOString(),
    },
    oiHistory: [],
    fundingHistory: [],
    volumeProfile: null,
    regime,
    market: {
      lastPrice: currentPrice,
      price24hPct: 0,
      volume24h: 0,
      turnover24h: 0,
      high24h: 0,
      low24h: 0,
      fundingRate: 0,
      nextFundingTime: '',
      bid1: 0,
      ask1: 0,
    },
  };

  const score = calculateConfluenceScore(input);

  // ATR14 на entry TF для расчёта SL
  const atr =
    m15Candles.length >= 14
      ? calculateAtr(
          m15Candles.map((c) => c.high),
          m15Candles.map((c) => c.low),
          m15Candles.map((c) => c.close),
          14,
        )
      : m15Analysis.indicators.atr14;

  // Bias с trend TF (H4). Если H4 недоступен — используем M15.
  const emaTrend = (h4Analysis ?? m15Analysis).bias.emaTrend;
  const bias = emaTrend === 'BULLISH' ? 'BULLISH' : emaTrend === 'BEARISH' ? 'BEARISH' : 'UNKNOWN';

  const result: ForexAnalysisResult = {
    pair,
    confluenceScore: score.total,
    confidence: score.confidence,
    regime,
    signal: score.signal,
    bias,
    atr,
    lastPrice: currentPrice,
    details: score.details,
  };

  log.debug(
    `${pair}: score=${score.total} confidence=${score.confidence}% regime=${regime} signal=${score.signal}`,
  );

  return result;
}

/**
 * Анализирует все переданные пары.
 * Ошибки per-pair перехватываются, чтобы одна сломанная пара не остановила всё.
 */
export function analyzeAll(pairs: string[]): ForexAnalysisResult[] {
  const results: ForexAnalysisResult[] = [];

  for (const pair of pairs) {
    try {
      const result = analyzePair(pair);
      if (result) {
        results.push(result);
      }
    } catch (error: unknown) {
      log.error(`Ошибка анализа ${pair}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  log.info(`Анализ завершён: ${results.length}/${pairs.length} пар`);
  return results;
}
