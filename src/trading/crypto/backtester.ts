import { getArg, hasFlag } from '../../utils/args.js';
import { loadEnv } from '../../utils/env.js';
import { createLogger } from '../../utils/logger.js';
import { runClaudeCli } from '../../utils/claude-cli.js';
import { buildSystemPrompt } from './claude-trader-context.js';

loadEnv();

import { calculateConfluenceScore, type ConfluenceInput } from '../shared/confluence.js';
import { buildMarketAnalysis } from '../shared/indicators.js';
import { detectMarketRegime, getRegimeThreshold } from '../shared/regime.js';
import type { ConfluenceScore, MarketRegime, OHLC } from '../shared/types.js';
import { getKlines } from './bybit-client.js';
import config from './config.js';
import { roundPrice } from './symbol-specs.js';

// Динамический R:R: в сильном тренде целим дальше, в боковике — быстрее забираем.
// strength = min(|confluenceScore| / 75, 1), итоговый RR = baseRR + (maxRR - baseRR) * strength
function getRegimeRR(regime: string, confluenceScore: number): number {
  const strength = Math.min(Math.abs(confluenceScore) / 75, 1);
  switch (regime as MarketRegime) {
    case 'STRONG_TREND':
      return 2.0 + (3.0 - 2.0) * strength; // 2.0–3.0R
    case 'WEAK_TREND':
      return 1.5 + (2.0 - 1.5) * strength; // 1.5–2.0R
    case 'RANGING':
      return 1.2 + (1.5 - 1.2) * strength; // 1.2–1.5R
    case 'VOLATILE':
      return 1.5 + (2.0 - 1.5) * strength; // 1.5–2.0R
    case 'CHOPPY':
      return 1.2 + (1.5 - 1.2) * strength; // 1.2–1.5R
  }
}

/**
 * Загружает >1000 свечей пагинацией по endTime.
 * Bybit отдаёт макс 1000 свечей за запрос, самые новые первыми.
 * Для 3 месяцев M15 нужно ~8640 свечей → 9 запросов.
 */
async function getKlinesPaginated(
  symbol: string,
  interval: string,
  totalBars: number,
): Promise<OHLC[]> {
  if (totalBars <= 1000) {
    return getKlines(symbol, interval, totalBars);
  }

  const allCandles: OHLC[] = [];
  let endTime: number | undefined;
  let remaining = totalBars;

  while (remaining > 0) {
    const batchSize = Math.min(remaining, 1000);

    // getKlines возвращает свечи отсортированные по времени ASC (oldest first)
    // Bybit API принимает end parameter — нужно использовать apiGet напрямую
    // Но getKlines не поддерживает endTime, поэтому используем хак:
    // загружаем 1000, берём самую старую timestamp, используем как endTime для следующего запроса
    const batch = await getKlinesBefore(symbol, interval, batchSize, endTime);

    if (batch.length === 0) break;

    // batch отсортирован ASC (oldest first)
    allCandles.unshift(...batch);

    // Следующий запрос до самой старой свечи из текущего батча
    const oldestTime = new Date(batch[0]!.time).getTime();
    endTime = oldestTime - 1; // -1ms чтобы не дублировать

    remaining -= batch.length;

    if (batch.length < batchSize) break; // API отдал меньше чем просили — данных больше нет

    log.info('Paginated fetch', {
      symbol,
      interval,
      loaded: allCandles.length,
      remaining,
      oldestDate: batch[0]!.time.slice(0, 10),
    });

    // Пауза чтобы не перегрузить rate limiter
    await new Promise((r) => setTimeout(r, 200));
  }

  return allCandles;
}

/**
 * Загрузка свечей до указанного timestamp (для пагинации).
 */
async function getKlinesBefore(
  symbol: string,
  interval: string,
  limit: number,
  endTimeMs?: number,
): Promise<OHLC[]> {
  // Используем getKlines если нет endTime (первый запрос — самые свежие)
  if (!endTimeMs) {
    return getKlines(symbol, interval, limit);
  }

  // Для пагинации нужен прямой вызов с end parameter
  // Реиспользуем getKlines через import bybit-client
  // Но getKlines не поддерживает end — нужно добавить или обойти
  // Обходим: Bybit kline API сортирует DESC, getKlines реверсит в ASC
  // Нам нужно вызвать API с end=endTimeMs
  const { getBybitBaseUrl } = await import('../../utils/config.js');
  const { TIMEFRAME_MAP } = await import('../shared/types.js');
  const baseUrl = getBybitBaseUrl();
  const mappedInterval = TIMEFRAME_MAP[interval] ?? interval;

  const url =
    `${baseUrl}/v5/market/kline?category=linear&symbol=${symbol}` +
    `&interval=${mappedInterval}&limit=${Math.min(limit, 1000)}&end=${endTimeMs}`;

  const resp = await fetch(url, {
    headers: { 'User-Agent': 'OpenClaw/1.0' },
    signal: AbortSignal.timeout(15_000),
  });

  const data = (await resp.json()) as { retCode: number; result?: { list?: string[][] } };
  if (data.retCode !== 0 || !data.result?.list) return [];

  const list = data.result.list;
  const rows: OHLC[] = [];

  for (const item of [...list].reverse()) {
    try {
      rows.push({
        time: new Date(parseInt(item[0] ?? '0')).toISOString(),
        open: parseFloat(item[1] ?? '0'),
        high: parseFloat(item[2] ?? '0'),
        low: parseFloat(item[3] ?? '0'),
        close: parseFloat(item[4] ?? '0'),
        volume: parseFloat(item[5] ?? '0'),
        turnover: parseFloat(item[6] ?? '0'),
      });
    } catch {
      continue;
    }
  }

  return rows;
}

const log = createLogger('backtester');

interface RawSignal {
  pair: string;
  side: 'Buy' | 'Sell';
  entry: number;
  sl: number;
  tp: number;
  rr: number;
  confluence: ConfluenceScore;
  regime: string;
  barIndex: number;
  entryTime: string;
  atr: number;
}

interface BacktestTrade {
  pair: string;
  side: 'Buy' | 'Sell';
  entryPrice: number;
  sl: number;
  tp: number;
  entryTime: string;
  exitTime: string;
  exitPrice: number;
  pnl: number;
  pnlPercent: number;
  rMultiple: number; // Фактический R-множитель (1R = риск на сделку)
  result: 'WIN' | 'LOSS' | 'OPEN';
  confluence: number;
  confidence: number;
  regime: string;
}

interface BacktestResult {
  pair: string;
  period: string;
  totalBars: number;
  signals: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnlPercent: number;
  avgWinPercent: number;
  avgLossPercent: number;
  maxDrawdownPercent: number;
  profitFactor: number;
  expectancy: number;
  trades_list: BacktestTrade[];
}

/**
 * Строит "фейковый" MarketAnalysis из OHLC данных для confluence scoring.
 * В бэктесте нет orderbook/OI/funding — используем нейтральные значения.
 */
function buildInputFromCandles(
  pair: string,
  d1Candles: OHLC[],
  h4Candles: OHLC[],
  h1Candles: OHLC[],
  m15Candles: OHLC[],
  m5Candles: OHLC[],
  barIndex: number,
): ConfluenceInput | null {
  // Берём данные до текущего бара (look-ahead bias prevention)
  const m15Slice = m15Candles.slice(0, barIndex + 1);
  if (m15Slice.length < 50) return null;

  const currentPrice = m15Slice[m15Slice.length - 1]!.close;

  // Пропорциональные срезы для старших TF
  const h1Bars = Math.floor(m15Slice.length / 4);
  const h4Bars = Math.floor(m15Slice.length / 16);
  const d1Bars = Math.floor(m15Slice.length / 96);

  const h1Slice = h1Candles.slice(0, Math.min(h1Bars, h1Candles.length));
  const h4Slice = h4Candles.slice(0, Math.min(h4Bars, h4Candles.length));
  const d1Slice = d1Candles.slice(0, Math.min(d1Bars, d1Candles.length));
  const m5Slice = m5Candles.slice(0, Math.min(barIndex * 3, m5Candles.length));

  const entryTF = buildMarketAnalysis(m15Slice, { pair, timeframe: '15', source: 'BACKTEST' });
  if (!entryTF) return null;

  const trendTF =
    d1Slice.length >= 50
      ? buildMarketAnalysis(d1Slice, { pair, timeframe: 'D', source: 'BACKTEST' })
      : h4Slice.length >= 50
        ? buildMarketAnalysis(h4Slice, { pair, timeframe: '240', source: 'BACKTEST' })
        : null;

  const zonesTF =
    h1Slice.length >= 50
      ? buildMarketAnalysis(h1Slice, { pair, timeframe: '60', source: 'BACKTEST' })
      : null;

  const precisionTF =
    m5Slice.length >= 50
      ? buildMarketAnalysis(m5Slice, { pair, timeframe: '5', source: 'BACKTEST' })
      : null;

  const regime = h4Slice.length >= 50 ? detectMarketRegime(h4Slice) : 'RANGING';

  // В бэктесте нет реалтайм данных — используем нейтральные значения
  const neutralOrderbook = {
    bids: [{ price: currentPrice * 0.999, qty: 100 }],
    asks: [{ price: currentPrice * 1.001, qty: 100 }],
    bidWallPrice: currentPrice * 0.99,
    askWallPrice: currentPrice * 1.01,
    imbalance: 0,
    spread: currentPrice * 0.002,
    timestamp: m15Slice[m15Slice.length - 1]!.time,
  };

  const neutralMarket = {
    lastPrice: currentPrice,
    price24hPct: 0,
    volume24h: 0,
    turnover24h: 0,
    high24h: currentPrice * 1.02,
    low24h: currentPrice * 0.98,
    fundingRate: 0,
    nextFundingTime: '',
    bid1: currentPrice * 0.999,
    ask1: currentPrice * 1.001,
  };

  return {
    trendTF,
    zonesTF,
    entryTF,
    precisionTF,
    entryCandles: m15Slice.slice(-200),
    orderbook: neutralOrderbook,
    oiHistory: [],
    fundingHistory: [],
    volumeProfile: null,
    regime,
    market: neutralMarket,
  };
}

function simulateTrade(
  pair: string,
  side: 'Buy' | 'Sell',
  entry: number,
  sl: number,
  tp: number,
  entryTime: string,
  futureCandles: OHLC[],
  confluence: ConfluenceScore,
  regime: string,
): BacktestTrade {
  let exitPrice = entry;
  let exitTime = entryTime;
  let result: 'WIN' | 'LOSS' | 'OPEN' = 'OPEN';

  for (const candle of futureCandles) {
    if (side === 'Buy') {
      if (candle.low <= sl) {
        exitPrice = sl;
        exitTime = candle.time;
        result = 'LOSS';
        break;
      }
      if (candle.high >= tp) {
        exitPrice = tp;
        exitTime = candle.time;
        result = 'WIN';
        break;
      }
    } else {
      if (candle.high >= sl) {
        exitPrice = sl;
        exitTime = candle.time;
        result = 'LOSS';
        break;
      }
      if (candle.low <= tp) {
        exitPrice = tp;
        exitTime = candle.time;
        result = 'WIN';
        break;
      }
    }
  }

  if (result === 'OPEN' && futureCandles.length > 0) {
    const lastCandle = futureCandles[futureCandles.length - 1]!;
    exitPrice = lastCandle.close;
    exitTime = lastCandle.time;
  }

  const rawPnl = side === 'Buy' ? exitPrice - entry : entry - exitPrice;
  const pnlPercent = (rawPnl / entry) * 100;

  const riskPerUnit = Math.abs(entry - sl);
  const rMultiple = riskPerUnit > 0 ? rawPnl / riskPerUnit : 0;

  return {
    pair,
    side,
    entryPrice: roundPrice(entry, pair),
    sl,
    tp,
    entryTime,
    exitTime,
    exitPrice,
    pnl: rawPnl,
    pnlPercent,
    rMultiple,
    result,
    confluence: confluence.total,
    confidence: confluence.confidence,
    regime,
  };
}

async function backtestPair(
  pair: string,
  m15Bars: number,
  btcM15?: OHLC[],
  collectSignals?: RawSignal[],
): Promise<BacktestResult> {
  log.info('Fetching candles', { pair, m15Bars });

  // M15 — основной TF, загружаем с пагинацией для больших периодов
  const m15Candles = await getKlinesPaginated(pair, '15', m15Bars);

  // Старшие TF — пропорционально, но не более 1000 (хватает для индикаторов)
  const h1Bars = Math.min(Math.ceil(m15Bars / 4), 1000);
  const h4Bars = Math.min(Math.ceil(m15Bars / 16), 1000);

  const [m5Candles, h1Candles, h4Candles, d1Candles] = await Promise.all([
    getKlinesPaginated(pair, '5', Math.min(m15Bars * 3, 3000)),
    getKlinesPaginated(pair, '60', h1Bars),
    getKlinesPaginated(pair, '240', h4Bars),
    getKlines(pair, 'D', 200),
  ]);

  log.info('Candles loaded', {
    pair,
    m15: m15Candles.length,
    m5: m5Candles.length,
    h1: h1Candles.length,
    h4: h4Candles.length,
    d1: d1Candles.length,
  });

  const trades: BacktestTrade[] = [];
  let signalCount = 0;

  // Шагаем по M15 свечам (каждую 3-ю для скорости, как ~15 мин интервал)
  const step = 3; // ~45 мин между проверками (аналог 5-мин мониторинга, но с M15 данными)
  const startBar = 100; // минимум 100 баров истории для индикаторов

  let lastTradeBar = 0;
  const minBarsBetweenTrades = Math.ceil(config.pairCooldownMin / 15); // cooldown в барах M15

  for (let i = startBar; i < m15Candles.length - 20; i += step) {
    // Не открываем если предыдущая сделка ещё не закрылась (simplification)
    if (i - lastTradeBar < minBarsBetweenTrades) continue;

    const input = buildInputFromCandles(
      pair,
      d1Candles,
      h4Candles,
      h1Candles,
      m15Candles,
      m5Candles,
      i,
    );
    if (!input) continue;

    const confluence = calculateConfluenceScore(input);
    const absScore = Math.abs(confluence.total);
    const regime = input.regime;
    const threshold = getRegimeThreshold(regime);

    if (absScore < threshold) continue;

    // Confidence filter (бэктест: порог ниже из-за отсутствия live-данных)
    if (confluence.confidence < config.backtestMinConfidence) continue;

    const side: 'Buy' | 'Sell' = confluence.total > 0 ? 'Buy' : 'Sell';

    // Фильтр: не торгуем против старшего тренда
    const trendBias = (input.trendTF ?? input.zonesTF)?.bias.emaTrend;
    if (regime === 'STRONG_TREND' || regime === 'WEAK_TREND') {
      if (trendBias === 'BULLISH' && side === 'Sell') continue;
      if (trendBias === 'BEARISH' && side === 'Buy') continue;
    }

    // BTC корреляция для альтов
    if (config.btcCorrelationFilter && pair !== 'BTCUSDT' && btcM15 && btcM15.length > i) {
      // Считаем BTC 24h change (96 баров M15 = 24ч)
      const lookback = Math.min(96, i);
      const btcNow = btcM15[i]?.close ?? 0;
      const btcPrev = btcM15[i - lookback]?.close ?? btcNow;
      const btc24hPct = btcPrev > 0 ? ((btcNow - btcPrev) / btcPrev) * 100 : 0;

      if (side === 'Buy' && btc24hPct < -3) continue; // BTC падает — не лонгуем альты
      if (side === 'Sell' && btc24hPct > 3) continue; // BTC растёт — не шортим альты
    }

    // Повышенный порог confidence для слабых пар
    if (config.weakPairs.includes(pair)) {
      const weakThreshold = config.backtestMinConfidence + config.weakPairConfidenceBonus;
      if (confluence.confidence < weakThreshold) continue;
    }

    signalCount++;

    const currentCandle = m15Candles[i]!;
    const price = currentCandle.close;
    const atr = input.entryTF.indicators.atr14;

    if (atr === 0 || price === 0) continue;

    const slDistance = atr * config.atrSlMultiplier;
    const entry = roundPrice(price, pair);
    const sl = roundPrice(side === 'Buy' ? entry - slDistance : entry + slDistance, pair);

    // Динамический R:R по режиму и силе confluence score
    const rr = getRegimeRR(regime, confluence.total);
    const tp = roundPrice(side === 'Buy' ? entry + slDistance * rr : entry - slDistance * rr, pair);

    if (collectSignals) {
      collectSignals.push({
        pair,
        side,
        entry,
        sl: roundPrice(sl, pair),
        tp: roundPrice(tp, pair),
        rr,
        confluence,
        regime,
        barIndex: i,
        entryTime: currentCandle.time,
        atr,
      });
    }

    // Simulate trade on future candles
    const futureCandles = m15Candles.slice(i + 1, i + 200); // max ~50 часов
    const trade = simulateTrade(
      pair,
      side,
      entry,
      sl,
      tp,
      currentCandle.time,
      futureCandles,
      confluence,
      regime,
    );

    trades.push(trade);
    lastTradeBar = i;

    // Skip ahead past this trade
    if (trade.result !== 'OPEN') {
      const exitBarIdx = m15Candles.findIndex((c) => c.time >= trade.exitTime);
      if (exitBarIdx > i) {
        // Перескакиваем к выходу из сделки
        const jump = Math.floor((exitBarIdx - i) / step) * step;
        if (jump > 0) i += jump - step; // -step потому что цикл добавит step
      }
    }
  }

  const wins = trades.filter((t) => t.result === 'WIN').length;
  const losses = trades.filter((t) => t.result === 'LOSS').length;
  const totalTrades = wins + losses;

  const winPnls = trades.filter((t) => t.result === 'WIN').map((t) => t.pnlPercent);
  const lossPnls = trades.filter((t) => t.result === 'LOSS').map((t) => t.pnlPercent);

  const avgWin = winPnls.length > 0 ? winPnls.reduce((a, b) => a + b, 0) / winPnls.length : 0;
  const avgLoss = lossPnls.length > 0 ? lossPnls.reduce((a, b) => a + b, 0) / lossPnls.length : 0;

  const totalPnl = trades.reduce((sum, t) => sum + t.pnlPercent, 0);
  const grossProfit = winPnls.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(lossPnls.reduce((a, b) => a + b, 0));

  // Max drawdown
  let maxDD = 0;
  let peak = 0;
  let cumPnl = 0;
  for (const t of trades) {
    cumPnl += t.pnlPercent;
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak - cumPnl;
    if (dd > maxDD) maxDD = dd;
  }

  const firstBar = m15Candles[startBar]?.time ?? '';
  const lastBar = m15Candles[m15Candles.length - 1]?.time ?? '';

  return {
    pair,
    period: `${firstBar.slice(0, 10)} — ${lastBar.slice(0, 10)}`,
    totalBars: m15Candles.length,
    signals: signalCount,
    trades: totalTrades,
    wins,
    losses,
    winRate: totalTrades > 0 ? (wins / totalTrades) * 100 : 0,
    totalPnlPercent: totalPnl,
    avgWinPercent: avgWin,
    avgLossPercent: avgLoss,
    maxDrawdownPercent: maxDD,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    expectancy: totalTrades > 0 ? totalPnl / totalTrades : 0,
    trades_list: trades,
  };
}

function formatResult(r: BacktestResult, verbose: boolean): string {
  const lines = [
    `═══ Backtest: ${r.pair} ═══`,
    `Период: ${r.period}`,
    `Баров: ${r.totalBars} (M15) | Сигналов: ${r.signals} | Сделок: ${r.trades}`,
    ``,
    `Win rate: ${r.winRate.toFixed(1)}% (${r.wins}W / ${r.losses}L)`,
    `Total P&L: ${r.totalPnlPercent >= 0 ? '+' : ''}${r.totalPnlPercent.toFixed(2)}%`,
    `Avg Win: +${r.avgWinPercent.toFixed(2)}% | Avg Loss: ${r.avgLossPercent.toFixed(2)}%`,
    `Max Drawdown: ${r.maxDrawdownPercent.toFixed(2)}%`,
    `Profit Factor: ${r.profitFactor === Infinity ? '∞' : r.profitFactor.toFixed(2)}`,
    `Expectancy: ${r.expectancy >= 0 ? '+' : ''}${r.expectancy.toFixed(3)}% per trade`,
  ];

  if (verbose && r.trades_list.length > 0) {
    lines.push(``, `--- Сделки ---`);
    for (const t of r.trades_list) {
      const pnlStr =
        t.pnlPercent >= 0 ? `+${t.pnlPercent.toFixed(2)}%` : `${t.pnlPercent.toFixed(2)}%`;
      lines.push(
        `  ${t.entryTime.slice(5, 16)} ${t.side} ${t.result} ${pnlStr} conf=${t.confluence} regime=${t.regime}`,
      );
    }
  }

  return lines.join('\n');
}

async function main(): Promise<void> {
  const pair = getArg('pair') ?? 'BTCUSDT';
  const bars = parseInt(getArg('bars') ?? '500');
  const verbose = hasFlag('verbose') || hasFlag('v');
  const allPairs = hasFlag('all');
  const withLlm = hasFlag('with-llm');
  const llmTopN = parseInt(getArg('llm-top') ?? '15');
  const startBalance = parseFloat(getArg('balance') ?? '10000');
  const fixedRisk = hasFlag('fixed-risk'); // Prop-firm: риск от начального баланса, без compound

  const pairsToTest = allPairs ? config.pairs : [pair.toUpperCase()];

  log.info('Starting backtest', { pairs: pairsToTest.length, bars });

  // Загружаем BTC свечи для корреляционного фильтра
  let btcM15: OHLC[] | undefined;
  if (config.btcCorrelationFilter) {
    log.info('Loading BTC candles for correlation filter');
    btcM15 = await getKlinesPaginated('BTCUSDT', '15', bars);
  }

  const allResults: BacktestResult[] = [];

  for (const p of pairsToTest) {
    try {
      const result = await backtestPair(p, bars, btcM15);
      allResults.push(result);
      console.log(formatResult(result, verbose));
      console.log('');
    } catch (err) {
      log.error('Backtest failed', { pair: p, error: (err as Error).message });
    }
  }

  if (allResults.length > 0) {
    // Summary
    const totalTrades = allResults.reduce((s, r) => s + r.trades, 0);
    const totalWins = allResults.reduce((s, r) => s + r.wins, 0);
    const avgPnl =
      allResults.length > 0
        ? allResults.reduce((s, r) => s + r.totalPnlPercent, 0) / allResults.length
        : 0;
    const avgWR = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;

    console.log(`═══ SUMMARY (${allResults.length} пар) ═══`);
    console.log(`Всего сделок: ${totalTrades} | Win rate: ${avgWR.toFixed(1)}%`);
    console.log(`Средний P&L на пару: ${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(2)}%`);

    // ─── Долларовая симуляция equity curve ──────────────────────────
    // Собираем ВСЕ сделки со всех пар, сортируем по времени входа
    const allTrades = allResults
      .flatMap((r) => r.trades_list)
      .sort((a, b) => a.entryTime.localeCompare(b.entryTime));

    if (allTrades.length > 0) {
      let balance = startBalance;
      let peakBalance = startBalance;
      let maxDollarDD = 0;
      const monthlyPnl = new Map<string, number>(); // "YYYY-MM" → $pnl

      console.log(`\n═══ EQUITY CURVE ($${startBalance.toLocaleString()} start) ═══`);
      console.log(
        `Risk per trade: ${(config.riskPerTrade * 100).toFixed(1)}% (max $${config.maxRiskPerTrade})${fixedRisk ? ' [FIXED — prop mode]' : ''}\n`,
      );

      for (const t of allTrades) {
        if (t.result === 'OPEN') continue;

        // Prop-firm: фиксированный риск от начального баланса (без compound)
        // Обычный режим: риск от текущего баланса (compound)
        const riskBase = fixedRisk ? startBalance : balance;
        const riskAmount = Math.min(riskBase * config.riskPerTrade, config.maxRiskPerTrade);
        // Долларовый P&L = riskAmount * R-множитель
        const dollarPnl = riskAmount * t.rMultiple;

        balance += dollarPnl;
        if (balance > peakBalance) peakBalance = balance;
        const dd = peakBalance - balance;
        if (dd > maxDollarDD) maxDollarDD = dd;

        // Месячная статистика
        const month = t.entryTime.slice(0, 7); // "YYYY-MM"
        monthlyPnl.set(month, (monthlyPnl.get(month) ?? 0) + dollarPnl);

        if (verbose) {
          const sign = dollarPnl >= 0 ? '+' : '';
          console.log(
            `  ${t.entryTime.slice(5, 16)} ${t.pair.padEnd(10)} ${t.side.padEnd(4)} ${t.result.padEnd(4)} ` +
              `${sign}$${dollarPnl.toFixed(2).padStart(8)} | R=${t.rMultiple >= 0 ? '+' : ''}${t.rMultiple.toFixed(2)} ` +
              `| bal=$${balance.toFixed(0)}`,
          );
        }
      }

      const totalDollarPnl = balance - startBalance;
      const totalReturn = ((balance - startBalance) / startBalance) * 100;
      const months = monthlyPnl.size || 1;
      const avgMonthlyReturn = totalReturn / months;

      console.log(`\n--- Итог ---`);
      console.log(`Начальный баланс: $${startBalance.toLocaleString()}`);
      console.log(`Конечный баланс:  $${balance.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`);
      console.log(
        `Прибыль/убыток:   ${totalDollarPnl >= 0 ? '+' : ''}$${totalDollarPnl.toFixed(0)} (${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(1)}%)`,
      );
      console.log(
        `Max Drawdown:     $${maxDollarDD.toFixed(0)} (${((maxDollarDD / peakBalance) * 100).toFixed(1)}%)`,
      );
      console.log(
        `Месяцев: ${months} | Средний возврат/мес: ${avgMonthlyReturn >= 0 ? '+' : ''}${avgMonthlyReturn.toFixed(1)}%`,
      );

      if (monthlyPnl.size > 0) {
        console.log(`\n--- По месяцам ---`);
        for (const [month, pnl] of [...monthlyPnl.entries()].sort()) {
          const balAtMonth =
            startBalance +
            [...monthlyPnl.entries()].filter(([m]) => m <= month).reduce((s, [, p]) => s + p, 0);
          console.log(
            `  ${month}: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0).padStart(6)} | bal=$${balAtMonth.toFixed(0)}`,
          );
        }
      }
    }
  }

  if (withLlm) {
    // Собираем все сигналы заново с collectSignals
    console.log(`\n═══ LLM EVALUATION (top ${llmTopN} signals) ═══\n`);

    const allSignals: RawSignal[] = [];
    for (const p of pairsToTest) {
      try {
        await backtestPair(p, bars, btcM15, allSignals);
      } catch {
        // ignore
      }
    }

    // Сортируем по абсолютному confluence score, берём топ
    allSignals.sort((a, b) => Math.abs(b.confluence.total) - Math.abs(a.confluence.total));
    const topSignals = allSignals.slice(0, llmTopN);

    console.log(`Всего сигналов: ${allSignals.length}, отправляем ${topSignals.length} в Claude\n`);

    let llmApproved = 0;
    let llmRejected = 0;
    const llmResults: Array<{ signal: RawSignal; decision: string; approved: boolean }> = [];

    for (const sig of topSignals) {
      const prompt = `${buildSystemPrompt()}

=== СИГНАЛ ДЛЯ ОЦЕНКИ (БЭКТЕСТ) ===

${sig.pair} ${sig.side} | score=${sig.confluence.total} conf=${sig.confluence.confidence}% regime=${sig.regime}
entry=${sig.entry} SL=${sig.sl} TP=${sig.tp} R:R=${sig.rr.toFixed(1)}
Время: ${sig.entryTime}
ATR: ${sig.atr.toFixed(4)}
Детали: ${sig.confluence.details.slice(0, 5).join(' | ')}

Баланс: $5000 (тест)
Позиции: нет

Оцени этот сигнал. Ответь СТРОГО JSON:
{"summary": "...", "actions": [{"type": "ENTER|SKIP", "pair": "${sig.pair}", "reason": "...", "confidence": 0-100}]}`;

      try {
        console.log(`  Claude оценивает: ${sig.pair} ${sig.side} score=${sig.confluence.total}...`);
        const response = await runClaudeCli(prompt, {
          timeoutMs: 120_000,
          stream: false,
          useSession: false,
        });

        // Парсим ответ Claude
        const jsonMatch = response.match(/\{[\s\S]*"actions"[\s\S]*\}/);
        let approved = false;
        let decision = 'PARSE_ERROR';

        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0]) as {
              actions?: Array<{ type: string; reason?: string }>;
            };
            const action = parsed.actions?.[0];
            if (action) {
              approved = action.type === 'ENTER';
              decision = `${action.type}: ${action.reason ?? ''}`;
            }
          } catch {
            decision = response.slice(0, 200);
          }
        } else {
          decision = response.slice(0, 200);
        }

        if (approved) llmApproved++;
        else llmRejected++;

        llmResults.push({ signal: sig, decision, approved });
        console.log(`    -> ${approved ? 'ENTER' : 'SKIP'}: ${decision.slice(0, 100)}`);
      } catch (err) {
        console.log(`    -> Ошибка: ${(err as Error).message}`);
      }

      // Пауза между вызовами чтобы не перегрузить
      await new Promise((r) => setTimeout(r, 2000));
    }

    console.log(`\n═══ LLM RESULTS ═══`);
    if (topSignals.length > 0) {
      console.log(
        `Одобрено: ${llmApproved}/${topSignals.length} (${((llmApproved / topSignals.length) * 100).toFixed(0)}%)`,
      );
    } else {
      console.log(`Одобрено: 0/0`);
    }
    console.log(`Отклонено: ${llmRejected}/${topSignals.length}`);

    // Показываем какие сделки были бы с LLM фильтром
    const approvedSignals = llmResults.filter((r) => r.approved);
    if (approvedSignals.length > 0) {
      console.log(`\nОдобренные сигналы:`);
      for (const r of approvedSignals) {
        console.log(
          `  ${r.signal.pair} ${r.signal.side} score=${r.signal.confluence.total} conf=${r.signal.confluence.confidence}% | ${r.decision.slice(0, 80)}`,
        );
      }
    }
  }
}

main().catch((err) => {
  log.error('Backtester crashed', { error: (err as Error).message });
  process.exit(1);
});
