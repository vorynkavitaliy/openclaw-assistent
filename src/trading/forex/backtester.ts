/**
 * Forex Backtester — тестирование стратегии на исторических данных.
 *
 * Загружает исторические свечи через Twelve Data API,
 * прогоняет confluence scoring по каждому бару,
 * симулирует входы/выходы с SL/TP по ATR.
 *
 * Запуск:
 *   npx tsx src/trading/forex/backtester.ts --pair EURUSD --period 3m
 *   npx tsx src/trading/forex/backtester.ts --all --period 6m
 *   npx tsx src/trading/forex/backtester.ts --all --period 1y --verbose
 */

import { getArg, hasFlag } from '../../utils/args.js';
import { loadEnv } from '../../utils/env.js';

loadEnv();

import { createLogger } from '../../utils/logger.js';
import { buildMarketAnalysis } from '../shared/indicators.js';
import { calculateConfluenceScore, type ConfluenceInput } from '../shared/confluence.js';
import { detectMarketRegime, getRegimeThreshold } from '../shared/regime.js';
import type { ConfluenceScore, MarketRegime, OHLC } from '../shared/types.js';
import { calculateAtr } from '../shared/indicators.js';
import config from './config.js';
import { prefetchForBacktest } from './history-provider.js';

const log = createLogger('forex-backtester');

// ─── Настройки бэктеста ───────────────────────────────────────────

const INITIAL_BALANCE = 10_000; // $10,000
const RISK_PER_TRADE_PCT = 3.0; // 3% от текущего баланса

// ─── Типы ─────────────────────────────────────────────────────────

interface BacktestTrade {
  pair: string;
  side: 'Buy' | 'Sell';
  entryPrice: number;
  sl: number;
  tp: number;
  entryTime: string;
  exitTime: string;
  exitPrice: number;
  pnlPips: number;
  pnlUsd: number;
  lots: number;
  balanceAfter: number;
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
  totalPnlUsd: number;
  totalPnlPips: number;
  avgWinUsd: number;
  avgLossUsd: number;
  maxDrawdownUsd: number;
  maxDrawdownPct: number;
  finalBalance: number;
  returnPct: number;
  profitFactor: number;
  expectancy: number;
  tradesList: BacktestTrade[];
}

// ─── Маппинг периодов ──────────────────────────────────────────────

/** Количество M15 баров по периоду */
function periodToM15Bars(period: string): number {
  switch (period) {
    case '1m':
      return 2880; // ~30 дней
    case '3m':
      return 8640;
    case '6m':
      return 17280;
    case '1y':
      return 34560;
    default:
      return parseInt(period) || 8640;
  }
}

// ─── Pip calculation ───────────────────────────────────────────────

function getPipSize(pair: string): number {
  if (pair.includes('JPY')) return 0.01;
  if (pair === 'XAUUSD') return 0.1;
  return 0.0001;
}

function priceToPips(diff: number, pair: string): number {
  return diff / getPipSize(pair);
}

function roundPrice(price: number, pair: string): number {
  if (pair === 'XAUUSD') return Number(price.toFixed(2));
  if (pair.includes('JPY')) return Number(price.toFixed(3));
  return Number(price.toFixed(5));
}

// ─── Pip value и position sizing ───────────────────────────────────

/**
 * Pip value в USD для 1 стандартного лота (100k единиц).
 * Для XXX/USD пар: 1 pip = $10
 * Для USD/XXX пар: 1 pip = $10 / rate (приблизительно)
 * Для XAUUSD: 1 pip (0.1) = $10
 * Для кросс-пар (EUR/JPY, GBP/JPY): через USD
 */
function pipValueUsd(pair: string, price: number): number {
  // Пары где USD котируемая валюта: EURUSD, GBPUSD, AUDUSD, NZDUSD — 1 pip = $10
  if (pair.endsWith('USD') && !pair.startsWith('USD') && pair !== 'XAUUSD') return 10;
  // XAUUSD: 1 pip (0.1) на 100 oz = $10
  if (pair === 'XAUUSD') return 10;
  // Пары где USD базовая валюта: USDJPY, USDCAD, USDCHF
  if (pair.startsWith('USD')) {
    // pipValue = (pip_size / price) * 100000
    const pipSize = getPipSize(pair);
    return (pipSize / price) * 100_000;
  }
  // Кросс-пары: EURJPY, GBPJPY — pip value через JPY/USD
  if (pair.includes('JPY')) {
    // Для JPY-кроссов pip value ≈ $10 / (USDJPY rate / 100)
    // Аппроксимация: USDJPY ~150 → pip value ≈ $6.67
    return (0.01 / price) * 100_000;
  }
  // Fallback
  return 10;
}

/**
 * Рассчитывает размер позиции (лоты) исходя из риска в USD и SL в пипсах.
 * lots = riskUsd / (slPips * pipValue)
 */
function calculateLots(riskUsd: number, slPips: number, pair: string, price: number): number {
  const pv = pipValueUsd(pair, price);
  const lots = riskUsd / (slPips * pv);
  // Округляем до 0.01 лота (минимум micro lot)
  return Math.max(0.01, Math.round(lots * 100) / 100);
}

// ─── R:R по режиму ────────────────────────────────────────────────

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
      return 1.8;
  }
}

// ─── Confluence scoring из свечей ──────────────────────────────────

function buildInputFromCandles(
  pair: string,
  m15Candles: OHLC[],
  h4Candles: OHLC[],
  d1Candles: OHLC[],
  barIndex: number,
): ConfluenceInput | null {
  // Look-ahead bias prevention: только данные до текущего бара
  const m15Slice = m15Candles.slice(0, barIndex + 1);
  if (m15Slice.length < 50) return null;

  const currentPrice = m15Slice[m15Slice.length - 1]!.close;

  // Пропорциональные срезы для старших TF
  const h4Bars = Math.floor(m15Slice.length / 16);
  const d1Bars = Math.floor(m15Slice.length / 96);

  const h4Slice = h4Candles.slice(0, Math.min(h4Bars, h4Candles.length));
  const d1Slice = d1Candles.slice(0, Math.min(d1Bars, d1Candles.length));

  const entryTF = buildMarketAnalysis(m15Slice.slice(-200), {
    pair,
    timeframe: 'M15',
    source: 'BACKTEST',
  });
  if (!entryTF) return null;

  const trendTF =
    d1Slice.length >= 50
      ? buildMarketAnalysis(d1Slice.slice(-200), { pair, timeframe: 'D1', source: 'BACKTEST' })
      : h4Slice.length >= 50
        ? buildMarketAnalysis(h4Slice.slice(-200), { pair, timeframe: 'H4', source: 'BACKTEST' })
        : null;

  const regime: MarketRegime =
    m15Slice.length >= 50 ? detectMarketRegime(m15Slice.slice(-100)) : 'RANGING';

  // Форекс: нет orderbook, OI, funding, volume profile
  return {
    trendTF,
    zonesTF: null,
    entryTF,
    precisionTF: null,
    entryCandles: m15Slice.slice(-200),
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
}

// ─── Симуляция сделки ──────────────────────────────────────────────

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
  lots: number,
  currentBalance: number,
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

  // Если сделка не закрылась за 200 баров — закрываем по текущей цене
  if (result === 'OPEN' && futureCandles.length > 0) {
    const lastCandle = futureCandles[futureCandles.length - 1]!;
    exitPrice = lastCandle.close;
    exitTime = lastCandle.time;
  }

  const rawPnl = side === 'Buy' ? exitPrice - entry : entry - exitPrice;
  const pnlPips = priceToPips(rawPnl, pair);
  const pv = pipValueUsd(pair, entry);
  const pnlUsd = pnlPips * pv * lots;
  const balanceAfter = currentBalance + pnlUsd;

  return {
    pair,
    side,
    entryPrice: entry,
    sl,
    tp,
    entryTime,
    exitTime,
    exitPrice,
    pnlPips,
    pnlUsd,
    lots,
    balanceAfter,
    result,
    confluence: confluence.total,
    confidence: confluence.confidence,
    regime,
  };
}

// ─── Основная функция бэктеста ────────────────────────────────────

async function backtestPair(pair: string, periodStr: string): Promise<BacktestResult> {
  const m15Bars = periodToM15Bars(periodStr);

  log.info(`Загрузка данных: ${pair}, ${periodStr} (${m15Bars} M15 bars)...`);

  const data = await prefetchForBacktest(pair, m15Bars);

  log.info(`Данные загружены: M15=${data.m15.length}, H4=${data.h4.length}, D1=${data.d1.length}`);

  if (data.m15.length < 100) {
    log.error(`Недостаточно данных для ${pair}: ${data.m15.length} < 100`);
    return emptyResult(pair, periodStr);
  }

  const trades: BacktestTrade[] = [];
  let signalCount = 0;
  let balance = INITIAL_BALANCE;

  // Шагаем по M15 свечам (каждую 3-ю: ~45 мин между проверками)
  const step = 3;
  const startBar = 100;
  const cooldownBars = Math.ceil(60 / 15); // 1 час cooldown между сделками

  let lastTradeBar = 0;

  for (let i = startBar; i < data.m15.length - 20; i += step) {
    if (i - lastTradeBar < cooldownBars) continue;

    // Стоп если баланс слишком низкий (margin call)
    if (balance < INITIAL_BALANCE * 0.5) break;

    const input = buildInputFromCandles(pair, data.m15, data.h4, data.d1, i);
    if (!input) continue;

    const confluence = calculateConfluenceScore(input);
    const absScore = Math.abs(confluence.total);
    const regime = input.regime;
    const threshold = getRegimeThreshold(regime);

    if (absScore < threshold) continue;
    if (confluence.confidence < config.minConfidence) continue;

    const side: 'Buy' | 'Sell' = confluence.total > 0 ? 'Buy' : 'Sell';

    // Фильтр: не торгуем против H4 тренда в трендовых режимах
    const trendBias = input.trendTF?.bias.emaTrend;
    if (regime === 'STRONG_TREND' || regime === 'WEAK_TREND') {
      if (trendBias === 'BULLISH' && side === 'Sell') continue;
      if (trendBias === 'BEARISH' && side === 'Buy') continue;
    }

    signalCount++;

    const currentCandle = data.m15[i]!;
    const price = currentCandle.close;

    // ATR14 для SL расчёта
    const m15Slice = data.m15.slice(Math.max(0, i - 50), i + 1);
    const atr = calculateAtr(
      m15Slice.map((c) => c.high),
      m15Slice.map((c) => c.low),
      m15Slice.map((c) => c.close),
      14,
    );

    if (atr === 0 || price === 0) continue;

    const slDistance = atr * config.atrSlMultiplier;
    const entry = roundPrice(price, pair);
    const sl = roundPrice(side === 'Buy' ? entry - slDistance : entry + slDistance, pair);

    const rr = getRegimeRR(regime);
    const tp = roundPrice(side === 'Buy' ? entry + slDistance * rr : entry - slDistance * rr, pair);

    // Minimum SL в пипсах
    const slPips = Math.abs(priceToPips(entry - sl, pair));
    if (slPips < config.minSlPips) continue;

    // Position sizing: 1% от текущего баланса
    const riskUsd = balance * (RISK_PER_TRADE_PCT / 100);
    const lots = calculateLots(riskUsd, slPips, pair, entry);

    const futureCandles = data.m15.slice(i + 1, i + 200);
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
      lots,
      balance,
    );

    trades.push(trade);
    balance = trade.balanceAfter;
    lastTradeBar = i;

    // Перескакиваем к выходу из сделки
    if (trade.result !== 'OPEN') {
      const exitBarIdx = data.m15.findIndex((c) => c.time >= trade.exitTime);
      if (exitBarIdx > i) {
        const jump = Math.floor((exitBarIdx - i) / step) * step;
        if (jump > 0) i += jump - step;
      }
    }
  }

  return buildResult(pair, data.m15.length, signalCount, trades, startBar, data.m15);
}

function emptyResult(pair: string, period: string): BacktestResult {
  return {
    pair,
    period,
    totalBars: 0,
    signals: 0,
    trades: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    totalPnlUsd: 0,
    totalPnlPips: 0,
    avgWinUsd: 0,
    avgLossUsd: 0,
    maxDrawdownUsd: 0,
    maxDrawdownPct: 0,
    finalBalance: INITIAL_BALANCE,
    returnPct: 0,
    profitFactor: 0,
    expectancy: 0,
    tradesList: [],
  };
}

function buildResult(
  pair: string,
  totalBars: number,
  signalCount: number,
  trades: BacktestTrade[],
  startBar: number,
  m15Candles: OHLC[],
): BacktestResult {
  const wins = trades.filter((t) => t.result === 'WIN').length;
  const losses = trades.filter((t) => t.result === 'LOSS').length;
  const totalTrades = wins + losses;

  const winUsd = trades.filter((t) => t.result === 'WIN').map((t) => t.pnlUsd);
  const lossUsd = trades.filter((t) => t.result === 'LOSS').map((t) => t.pnlUsd);

  const avgWin = winUsd.length > 0 ? winUsd.reduce((a, b) => a + b, 0) / winUsd.length : 0;
  const avgLoss = lossUsd.length > 0 ? lossUsd.reduce((a, b) => a + b, 0) / lossUsd.length : 0;

  const totalPnlUsd = trades.reduce((sum, t) => sum + t.pnlUsd, 0);
  const totalPnlPips = trades.reduce((sum, t) => sum + t.pnlPips, 0);
  const grossProfit = winUsd.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(lossUsd.reduce((a, b) => a + b, 0));

  // Max drawdown в USD (по equity curve)
  let maxDD = 0;
  let peakBalance = INITIAL_BALANCE;
  let balance = INITIAL_BALANCE;
  for (const t of trades) {
    balance += t.pnlUsd;
    if (balance > peakBalance) peakBalance = balance;
    const dd = peakBalance - balance;
    if (dd > maxDD) maxDD = dd;
  }

  const finalBalance =
    trades.length > 0 ? trades[trades.length - 1]!.balanceAfter : INITIAL_BALANCE;
  const returnPct = ((finalBalance - INITIAL_BALANCE) / INITIAL_BALANCE) * 100;
  const maxDDPct = peakBalance > 0 ? (maxDD / peakBalance) * 100 : 0;

  const firstBar = m15Candles[startBar]?.time ?? '';
  const lastBar = m15Candles[m15Candles.length - 1]?.time ?? '';

  return {
    pair,
    period: `${firstBar.slice(0, 10)} — ${lastBar.slice(0, 10)}`,
    totalBars,
    signals: signalCount,
    trades: totalTrades,
    wins,
    losses,
    winRate: totalTrades > 0 ? (wins / totalTrades) * 100 : 0,
    totalPnlUsd: totalPnlUsd,
    totalPnlPips,
    avgWinUsd: avgWin,
    avgLossUsd: avgLoss,
    maxDrawdownUsd: maxDD,
    maxDrawdownPct: maxDDPct,
    finalBalance,
    returnPct,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    expectancy: totalTrades > 0 ? totalPnlUsd / totalTrades : 0,
    tradesList: trades,
  };
}

// ─── Форматирование результатов ────────────────────────────────────

function fmtUsd(n: number): string {
  const sign = n >= 0 ? '+' : '';
  return `${sign}$${n.toFixed(0)}`;
}

function formatResult(r: BacktestResult, verbose: boolean): string {
  const lines = [
    ``,
    `═══ Backtest: ${r.pair} ═══`,
    `Период: ${r.period}`,
    `Баров: ${r.totalBars} (M15) | Сигналов: ${r.signals} | Сделок: ${r.trades}`,
    ``,
    `Начальный баланс: $${INITIAL_BALANCE.toLocaleString()}`,
    `Финальный баланс: $${r.finalBalance.toFixed(0)}  (${r.returnPct >= 0 ? '+' : ''}${r.returnPct.toFixed(1)}%)`,
    ``,
    `Win rate:      ${r.winRate.toFixed(1)}% (${r.wins}W / ${r.losses}L)`,
    `Total P&L:     ${fmtUsd(r.totalPnlUsd)} (${r.totalPnlPips >= 0 ? '+' : ''}${r.totalPnlPips.toFixed(0)} pips)`,
    `Avg Win:       ${fmtUsd(r.avgWinUsd)}`,
    `Avg Loss:      ${fmtUsd(r.avgLossUsd)}`,
    `Max Drawdown:  $${r.maxDrawdownUsd.toFixed(0)} (${r.maxDrawdownPct.toFixed(1)}%)`,
    `Profit Factor: ${r.profitFactor === Infinity ? '∞' : r.profitFactor.toFixed(2)}`,
    `Expectancy:    ${fmtUsd(r.expectancy)}/trade`,
  ];

  if (verbose && r.tradesList.length > 0) {
    lines.push(``, `--- Сделки ---`);
    for (const t of r.tradesList) {
      const pnlStr = fmtUsd(t.pnlUsd).padStart(7);
      lines.push(
        `  ${t.entryTime.slice(5, 16)} ${t.side.padEnd(4)} ${t.result.padEnd(4)} ${pnlStr}  ${t.lots.toFixed(2)}lot  bal=$${t.balanceAfter.toFixed(0)}  conf=${t.confluence}`,
      );
    }
  }

  return lines.join('\n');
}

function formatSummary(results: BacktestResult[]): string {
  const totalTrades = results.reduce((s, r) => s + r.trades, 0);
  const totalWins = results.reduce((s, r) => s + r.wins, 0);
  const totalPnlUsd = results.reduce((s, r) => s + r.totalPnlUsd, 0);
  const avgWR = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;
  const avgPF =
    results.length > 0
      ? results.reduce((s, r) => s + (r.profitFactor === Infinity ? 10 : r.profitFactor), 0) /
        results.length
      : 0;

  // Общий max drawdown (портфельный)
  const maxDD = Math.max(...results.map((r) => r.maxDrawdownUsd));

  const lines = [
    ``,
    `═══ ИТОГО: ${results.length} пар, бюджет $${INITIAL_BALANCE.toLocaleString()} на каждую ═══`,
    `Всего сделок:     ${totalTrades} | Win rate: ${avgWR.toFixed(1)}%`,
    `Суммарный P&L:    ${fmtUsd(totalPnlUsd)}`,
    `Макс. просадка:   $${maxDD.toFixed(0)}`,
    `Средний PF:       ${avgPF.toFixed(2)}`,
    ``,
    `По парам:`,
  ];

  for (const r of results.sort((a, b) => b.totalPnlUsd - a.totalPnlUsd)) {
    const pnl = fmtUsd(r.totalPnlUsd).padStart(7);
    const ret = `${r.returnPct >= 0 ? '+' : ''}${r.returnPct.toFixed(1)}%`;
    lines.push(
      `  ${r.pair.padEnd(7)} ${pnl}  ${ret.padStart(7)}  WR=${r.winRate.toFixed(0)}%  PF=${r.profitFactor === Infinity ? '∞' : r.profitFactor.toFixed(1)}  DD=${r.maxDrawdownPct.toFixed(1)}%  (${r.trades} trades)`,
    );
  }

  return lines.join('\n');
}

// ─── Main ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const pair = getArg('pair') ?? 'EURUSD';
  const period = getArg('period') ?? '3m';
  const verbose = hasFlag('verbose') || hasFlag('v');
  const allPairs = hasFlag('all');

  const pairsToTest = allPairs ? config.pairs : [pair.toUpperCase()];

  console.log(`\nForex Backtester`);
  console.log(`Период: ${period} | Пары: ${pairsToTest.join(', ')}`);
  console.log(
    `Бюджет: $${INITIAL_BALANCE.toLocaleString()} | Риск: ${RISK_PER_TRADE_PCT}%/сделку ($${((INITIAL_BALANCE * RISK_PER_TRADE_PCT) / 100).toFixed(0)})`,
  );
  console.log(`Настройки: ATR SL=${config.atrSlMultiplier}x, min SL=${config.minSlPips} pips`);
  console.log(`─────────────────────────────────────`);

  const results: BacktestResult[] = [];

  for (const p of pairsToTest) {
    try {
      const result = await backtestPair(p, period);
      results.push(result);
      console.log(formatResult(result, verbose));
    } catch (err) {
      log.error(`Backtest failed for ${p}: ${(err as Error).message}`);
    }

    // Пауза между парами для rate limit
    if (pairsToTest.indexOf(p) < pairsToTest.length - 1) {
      log.info('Rate limit pause (8s)...');
      await new Promise((r) => setTimeout(r, 8_000));
    }
  }

  if (results.length > 1) {
    console.log(formatSummary(results));
  }
}

main().catch((err) => {
  log.error(`Backtester crashed: ${(err as Error).message}`);
  process.exit(1);
});
