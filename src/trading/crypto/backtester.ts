import { getArg, hasFlag } from '../../utils/args.js';
import { loadEnv } from '../../utils/env.js';
import { createLogger } from '../../utils/logger.js';

loadEnv();

import { calculateConfluenceScore, type ConfluenceInput } from '../shared/confluence.js';
import { buildMarketAnalysis } from '../shared/indicators.js';
import { detectMarketRegime, getRegimeThreshold } from '../shared/regime.js';
import type { ConfluenceScore, OHLC } from '../shared/types.js';
import { getKlines } from './bybit-client.js';
import config from './config.js';
import { roundPrice } from './symbol-specs.js';

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

  // Если сделка не закрылась, закрываем по последней цене
  if (result === 'OPEN' && futureCandles.length > 0) {
    const lastCandle = futureCandles[futureCandles.length - 1]!;
    exitPrice = lastCandle.close;
    exitTime = lastCandle.time;
  }

  const pnl = side === 'Buy' ? exitPrice - entry : entry - exitPrice;
  const pnlPercent = (pnl / entry) * 100;

  return {
    pair,
    side,
    entryPrice: entry,
    sl,
    tp,
    entryTime,
    exitTime,
    exitPrice,
    pnl,
    pnlPercent,
    result,
    confluence: confluence.total,
    confidence: confluence.confidence,
    regime,
  };
}

async function backtestPair(pair: string, m15Bars: number): Promise<BacktestResult> {
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
  const minBarsBetweenTrades = 4; // минимум 1 час между входами

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

    signalCount++;

    const side: 'Buy' | 'Sell' = confluence.total > 0 ? 'Buy' : 'Sell';
    const currentCandle = m15Candles[i]!;
    const price = currentCandle.close;
    const atr = input.entryTF.indicators.atr14;

    if (atr === 0 || price === 0) continue;

    const slDistance = atr * config.atrSlMultiplier;
    const entry = roundPrice(price, pair);
    const sl = roundPrice(side === 'Buy' ? entry - slDistance : entry + slDistance, pair);
    const tp = roundPrice(
      side === 'Buy' ? entry + slDistance * config.minRR : entry - slDistance * config.minRR,
      pair,
    );

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

  const pairsToTest = allPairs ? config.pairs : [pair.toUpperCase()];

  log.info('Starting backtest', { pairs: pairsToTest.length, bars });

  const allResults: BacktestResult[] = [];

  for (const p of pairsToTest) {
    try {
      const result = await backtestPair(p, bars);
      allResults.push(result);
      console.log(formatResult(result, verbose));
      console.log('');
    } catch (err) {
      log.error('Backtest failed', { pair: p, error: (err as Error).message });
    }
  }

  if (allResults.length > 1) {
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
  }
}

main().catch((err) => {
  log.error('Backtester crashed', { error: (err as Error).message });
  process.exit(1);
});
