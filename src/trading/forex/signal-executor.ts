import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../../utils/logger.js';
import { submitOrder, type PositionWithId } from './client.js';
import config from './config.js';
import { getRegimeThreshold } from '../shared/regime.js';
import type { ForexAnalysisResult } from './market-analyzer.js';

const log = createLogger('forex-executor');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Путь к файлу решений форекс (JSONL)
const DECISIONS_FILE = path.resolve(__dirname, '../../../data/forex-decisions.jsonl');

// ATR multiplier для расчёта SL
const ATR_SL_MULTIPLIER = 2.0;

// Минимальный SL в pips (защита от слишком тесных стопов)
const MIN_SL_PIPS = 10;

// Размер пипа в единицах цены
const PIP_SIZE_DEFAULT = 0.0001;
const PIP_SIZE_JPY = 0.01;

// Минимальный и максимальный объём в лотах
const MIN_LOTS = 0.01;
const MAX_LOTS = 1.0;

/**
 * Pip value в USD для 1 стандартного лота (100,000 единиц базовой валюты).
 * - XXX/USD пары (EURUSD, AUDUSD): $10 за pip
 * - USD/JPY: $1000 / currentPrice (при USDJPY=150 → ~$6.67)
 * - Cross JPY (EURJPY, GBPJPY): $1000 / currentPrice
 * - USD/XXX (USDCAD, USDCHF): $10 / currentPrice * basePrice ≈ $10
 * - XAUUSD: $1 за pip (pip = 0.01, lot = 100 oz)
 */
function pipValueUsd(pair: string, currentPrice: number): number {
  const p = pair.toUpperCase();

  // XAUUSD: 100 oz × $0.01 = $1 за pip
  if (p === 'XAUUSD') return 1;

  // XXX/USD пары — pip = $10
  if (p.endsWith('USD') && !p.includes('JPY')) return 10;

  // JPY пары (USDJPY, EURJPY, GBPJPY)
  if (p.includes('JPY')) {
    // pip = 0.01, lot = 100,000 units → 100,000 × 0.01 / price
    return currentPrice > 0 ? 1000 / currentPrice : 10;
  }

  // USD/XXX (USDCAD, USDCHF) — pip value зависит от курса котируемой валюты
  if (p.startsWith('USD')) {
    return currentPrice > 0 ? 10 / currentPrice : 10;
  }

  // Fallback
  return 10;
}

export interface ForexDecision {
  timestamp: string;
  pair: string;
  action: 'ENTER' | 'SKIP';
  side?: 'Buy' | 'Sell';
  lots?: number;
  entryPrice?: number;
  sl?: number;
  tp?: number;
  confluenceScore: number;
  confidence: number;
  regime: string;
  reason: string;
}

function getPipSize(pair: string): number {
  return pair.toUpperCase().includes('JPY') ? PIP_SIZE_JPY : PIP_SIZE_DEFAULT;
}

/**
 * Рассчитывает размер лота на основе риска.
 * Формула: riskUsd / (slPips × pipValue)
 */
function calcLots(balance: number, slPips: number, pair: string, currentPrice: number): number {
  const riskUsd = (balance * config.maxRiskPerTradePct) / 100;
  const pipVal = pipValueUsd(pair, currentPrice);
  const slValueUsd = slPips * pipVal;

  if (slValueUsd <= 0) return MIN_LOTS;

  const lots = riskUsd / slValueUsd;
  return Math.max(MIN_LOTS, Math.min(MAX_LOTS, Math.round(lots * 100) / 100));
}

/**
 * Записывает решение в JSONL файл.
 */
function writeDecision(decision: ForexDecision): void {
  try {
    const dir = path.dirname(DECISIONS_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.appendFileSync(DECISIONS_FILE, JSON.stringify(decision) + '\n', 'utf-8');
  } catch (error: unknown) {
    log.error('Ошибка записи решения в журнал', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Исполняет торговые сигналы для форекс.
 *
 * @param signals — результаты анализа пар
 * @param positions — текущие открытые позиции
 * @param balance — доступный баланс счёта
 * @param tradingAllowed — флаг разрешения торговли (из state.ts / canTrade())
 */
export async function executeSignals(
  signals: ForexAnalysisResult[],
  positions: PositionWithId[],
  balance: number,
  tradingAllowed: boolean,
): Promise<void> {
  if (!tradingAllowed) {
    log.info('Торговля заблокирована (canTrade=false) — сигналы пропущены');
    return;
  }

  const openPairs = new Set(positions.map((p) => p.symbol.toUpperCase()));
  const openCount = positions.length;

  for (const signal of signals) {
    const pairUpper = signal.pair.toUpperCase();
    const threshold = getRegimeThreshold(signal.regime);
    const absScore = Math.abs(signal.confluenceScore);

    // Фильтр: минимальный score по режиму
    if (absScore < threshold) {
      log.debug(
        `${signal.pair}: пропуск — score=${signal.confluenceScore} < threshold=${threshold} (${signal.regime})`,
      );
      writeDecision({
        timestamp: new Date().toISOString(),
        pair: signal.pair,
        action: 'SKIP',
        confluenceScore: signal.confluenceScore,
        confidence: signal.confidence,
        regime: signal.regime,
        reason: `score ${signal.confluenceScore} ниже порога ${threshold} для режима ${signal.regime}`,
      });
      continue;
    }

    // Фильтр: минимальный confidence
    if (signal.confidence < 30) {
      log.debug(`${signal.pair}: пропуск — confidence=${signal.confidence}% < 30%`);
      writeDecision({
        timestamp: new Date().toISOString(),
        pair: signal.pair,
        action: 'SKIP',
        confluenceScore: signal.confluenceScore,
        confidence: signal.confidence,
        regime: signal.regime,
        reason: `confidence ${signal.confidence}% ниже 30%`,
      });
      continue;
    }

    // Пропускаем пары с уже открытой позицией
    if (openPairs.has(pairUpper)) {
      log.debug(`${signal.pair}: пропуск — позиция уже открыта`);
      writeDecision({
        timestamp: new Date().toISOString(),
        pair: signal.pair,
        action: 'SKIP',
        confluenceScore: signal.confluenceScore,
        confidence: signal.confidence,
        regime: signal.regime,
        reason: 'позиция уже открыта',
      });
      continue;
    }

    // Проверяем лимит открытых позиций
    if (openCount >= config.maxOpenPositions) {
      log.info(`${signal.pair}: пропуск — достигнут лимит позиций (${config.maxOpenPositions})`);
      writeDecision({
        timestamp: new Date().toISOString(),
        pair: signal.pair,
        action: 'SKIP',
        confluenceScore: signal.confluenceScore,
        confidence: signal.confidence,
        regime: signal.regime,
        reason: `достигнут лимит открытых позиций ${config.maxOpenPositions}`,
      });
      continue;
    }

    // Нейтральный сигнал — пропускаем
    if (signal.signal === 'NEUTRAL') {
      log.debug(`${signal.pair}: пропуск — сигнал NEUTRAL`);
      writeDecision({
        timestamp: new Date().toISOString(),
        pair: signal.pair,
        action: 'SKIP',
        confluenceScore: signal.confluenceScore,
        confidence: signal.confidence,
        regime: signal.regime,
        reason: 'сигнал NEUTRAL',
      });
      continue;
    }

    const side: 'Buy' | 'Sell' = signal.confluenceScore > 0 ? 'Buy' : 'Sell';
    const entryPrice = signal.lastPrice;
    const pipSize = getPipSize(signal.pair);

    // SL = ATR * multiplier
    const atrDistance = signal.atr * ATR_SL_MULTIPLIER;
    const atrPips = Math.round(atrDistance / pipSize);
    const slPips = Math.max(MIN_SL_PIPS, atrPips);
    const slDistance = slPips * pipSize;

    const sl = side === 'Buy' ? entryPrice - slDistance : entryPrice + slDistance;
    const tp =
      side === 'Buy'
        ? entryPrice + slDistance * config.minRR
        : entryPrice - slDistance * config.minRR;

    const lots = calcLots(balance, slPips, signal.pair, entryPrice);

    log.info(
      `${signal.pair}: сигнал ${side} score=${signal.confluenceScore} confidence=${signal.confidence}% ` +
        `entry=${entryPrice} SL=${sl.toFixed(5)} TP=${tp.toFixed(5)} lots=${lots}`,
    );

    if (config.mode === 'dry-run') {
      log.info(`[dry-run] ${signal.pair}: ордер НЕ отправлен (режим dry-run)`);
      writeDecision({
        timestamp: new Date().toISOString(),
        pair: signal.pair,
        action: 'ENTER',
        side,
        lots,
        entryPrice,
        sl,
        tp,
        confluenceScore: signal.confluenceScore,
        confidence: signal.confidence,
        regime: signal.regime,
        reason: `dry-run: ${side} score=${signal.confluenceScore} confidence=${signal.confidence}%`,
      });
      continue;
    }

    try {
      await submitOrder({
        symbol: signal.pair,
        side,
        lots,
        sl: { price: sl },
        tp: { price: tp },
      });

      writeDecision({
        timestamp: new Date().toISOString(),
        pair: signal.pair,
        action: 'ENTER',
        side,
        lots,
        entryPrice,
        sl,
        tp,
        confluenceScore: signal.confluenceScore,
        confidence: signal.confidence,
        regime: signal.regime,
        reason: `${side} score=${signal.confluenceScore} confidence=${signal.confidence}% regime=${signal.regime}`,
      });

      log.info(`${signal.pair}: ордер исполнен — ${side} ${lots} лот(ов)`);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`${signal.pair}: ошибка исполнения ордера`, { error: msg });
      writeDecision({
        timestamp: new Date().toISOString(),
        pair: signal.pair,
        action: 'SKIP',
        confluenceScore: signal.confluenceScore,
        confidence: signal.confidence,
        regime: signal.regime,
        reason: `ошибка исполнения: ${msg}`,
      });
    }
  }
}
