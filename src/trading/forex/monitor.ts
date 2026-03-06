import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasFlag } from '../../utils/args.js';
import { createLogger } from '../../utils/logger.js';
import { acquireLock, releaseLock } from '../../utils/lockfile.js';
import { runMain } from '../../utils/process.js';
import { sendTelegram } from '../../utils/telegram.js';
import {
  closePosition,
  disconnect,
  getBalance,
  getPositions,
  modifyPosition,
  submitOrder,
  type PositionWithId,
} from './client.js';
import config from './config.js';
import { logDecision, generateCycleId, rotateIfNeeded } from './decision-journal.js';
import { runForexLLMAdvisor } from './llm-advisor.js';
import { analyzeAll, type ForexAnalysisResult } from './market-analyzer.js';
import { saveForexSnapshots } from './market-snapshot.js';
import { getCurrentPrices, loadCandleStore } from './price-provider.js';
import {
  activateKillSwitch,
  canTrade,
  isKillSwitchActive,
  loadState,
  resetDaily,
  saveState,
  updateAccountBalance,
} from './state.js';
import { cleanExpired as cleanWatchlist } from './watchlist.js';

const log = createLogger('forex-monitor');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../../data');
const LOCK_FILE = path.join(DATA_DIR, 'forex-monitor.lock');
const HEALTH_FILE = path.join(DATA_DIR, 'forex-health.json');

const DRY_RUN = hasFlag('dry-run') || config.mode !== 'execute';

const PIP_VALUE_PER_LOT = 10;
const STANDARD_PIP_MULTIPLIER = 10_000;

// ─── Управление позициями ────────────────────────────────────────────────────

/**
 * Рассчитывает текущее R для открытой позиции.
 * Возвращает null если расчёт невозможен (нет SL, нет entry и т.д.).
 */
function calcCurrentR(pos: PositionWithId): number | null {
  const entry = parseFloat(pos.entryPrice);
  const sl = parseFloat(pos.stopLoss ?? '0');
  const size = parseFloat(pos.size);
  const uPnl = parseFloat(pos.unrealisedPnl);

  if (entry === 0 || sl === 0 || size === 0) return null;

  const slDistance = Math.abs(entry - sl);
  if (slDistance === 0) return null;

  const oneR = slDistance * STANDARD_PIP_MULTIPLIER * size * PIP_VALUE_PER_LOT;
  if (oneR === 0) return null;

  return uPnl / oneR;
}

/**
 * Управляет открытыми позициями:
 * - Partial close при достижении config.partialCloseAtR
 * - Trailing SL при достижении config.trailingStartR
 */
async function managePositions(positions: PositionWithId[]): Promise<void> {
  if (positions.length === 0) return;

  for (const pos of positions) {
    const { positionId } = pos;
    if (!positionId) continue;

    const currentR = calcCurrentR(pos);
    if (currentR === null) {
      log.warn('Позиция без SL — невозможно управлять', {
        symbol: pos.symbol,
        positionId,
        side: pos.side,
      });
      continue;
    }

    const entry = parseFloat(pos.entryPrice);
    const sl = parseFloat(pos.stopLoss ?? '0');
    const size = parseFloat(pos.size);
    const slDistance = Math.abs(entry - sl);

    // Partial close при достижении 1R
    if (currentR >= config.partialCloseAtR) {
      const partialLots = size * config.partialClosePercent;
      if (partialLots >= 0.01) {
        if (DRY_RUN) {
          log.info(
            `[DRY-RUN] Partial close ${pos.symbol} ${partialLots.toFixed(2)} lots at ${currentR.toFixed(1)}R`,
          );
        } else {
          try {
            await closePosition(positionId, partialLots);
            // Переводим SL в безубыток после частичного закрытия
            await modifyPosition(positionId, { sl: { pips: 0 } });
            log.info('Partial close выполнен', {
              symbol: pos.symbol,
              partialLots: partialLots.toFixed(2),
              currentR: currentR.toFixed(1),
            });
          } catch (err: unknown) {
            log.warn('Ошибка partial close', {
              symbol: pos.symbol,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    }

    // Trailing SL при достижении 1.5R
    if (currentR >= config.trailingStartR) {
      const trailPips = Math.round(slDistance * config.trailingDistanceR * STANDARD_PIP_MULTIPLIER);
      if (DRY_RUN) {
        log.info(
          `[DRY-RUN] Trailing SL ${pos.symbol} to ${trailPips} pips at ${currentR.toFixed(1)}R`,
        );
      } else {
        try {
          await modifyPosition(positionId, { sl: { pips: trailPips } });
          log.info('Trailing SL обновлён', {
            symbol: pos.symbol,
            trailPips,
            currentR: currentR.toFixed(1),
          });
        } catch (err: unknown) {
          log.warn('Ошибка trailing SL', {
            symbol: pos.symbol,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }
}

// ─── Исполнение сигналов ─────────────────────────────────────────────────────

/**
 * Минимальный порог confluence для рассмотрения LLM-советником.
 * Сигналы выше этого порога отправляются в LLM для финального решения.
 */
const MIN_CONFLUENCE_FOR_LLM = 35;
const MIN_CONFIDENCE_FOR_LLM = 50;

/**
 * Fast-track: сигналы выше этих порогов исполняются без LLM.
 */
const FAST_TRACK_CONFLUENCE = 65;
const FAST_TRACK_CONFIDENCE = 75;

/**
 * Определяет сторону сделки по результату анализа.
 */
function determineSide(analysis: ForexAnalysisResult): 'Buy' | 'Sell' | null {
  const { signal } = analysis;
  if (signal === 'STRONG_LONG' || signal === 'LONG') return 'Buy';
  if (signal === 'STRONG_SHORT' || signal === 'SHORT') return 'Sell';
  return null;
}

/**
 * Проверяет, проходит ли сигнал минимальный фильтр для рассмотрения LLM.
 */
function passesMinFilter(analysis: ForexAnalysisResult): boolean {
  return (
    Math.abs(analysis.confluenceScore) >= MIN_CONFLUENCE_FOR_LLM &&
    analysis.confidence >= MIN_CONFIDENCE_FOR_LLM &&
    determineSide(analysis) !== null
  );
}

/**
 * Проверяет, проходит ли сигнал fast-track (без LLM).
 */
function isFastTrack(analysis: ForexAnalysisResult): boolean {
  return (
    Math.abs(analysis.confluenceScore) >= FAST_TRACK_CONFLUENCE &&
    analysis.confidence >= FAST_TRACK_CONFIDENCE
  );
}

/**
 * Рассчитывает размер позиции в лотах на основе риска и ATR.
 */
function calcLots(
  balanceUsd: number,
  atr: number,
  symbol: string,
): { lots: number; slPips: number; tpPips: number } {
  // SL = 1.5 × ATR(M15) в пипсах
  const pipMultiplier = symbol.toUpperCase().includes('JPY')
    ? 100
    : symbol.toUpperCase().startsWith('XAU')
      ? 10
      : 10_000;

  const slPips = Math.max(Math.round(atr * pipMultiplier * 1.5), 15);
  const tpPips = Math.round(slPips * config.minRR);

  // Риск = maxRiskPerTradePct% от баланса
  const riskUsd = (balanceUsd * config.maxRiskPerTradePct) / 100;

  // lots = riskUsd / (slPips × PIP_VALUE_PER_LOT)
  const rawLots = riskUsd / (slPips * PIP_VALUE_PER_LOT);

  // Округляем вниз до 2 знаков, минимум 0.01 лота
  const lots = Math.max(Math.floor(rawLots * 100) / 100, 0.01);

  return { lots, slPips, tpPips };
}

/**
 * Открывает один ордер по анализу.
 */
async function placeOrder(
  cycleId: string,
  analysis: ForexAnalysisResult,
  balanceUsd: number,
  reason: string,
): Promise<boolean> {
  const side = determineSide(analysis);
  if (!side) return false;

  const { lots, slPips, tpPips } = calcLots(balanceUsd, analysis.atr, analysis.pair);

  log.info('Сигнал на открытие', {
    pair: analysis.pair,
    side,
    lots,
    slPips,
    tpPips,
    confluenceScore: analysis.confluenceScore,
    confidence: `${analysis.confidence}%`,
    regime: analysis.regime,
    reason,
  });

  if (DRY_RUN) {
    log.info(`[DRY-RUN] ${side} ${analysis.pair} ${lots} lots | SL=${slPips}p TP=${tpPips}p`);
    return true;
  }

  try {
    const result = await submitOrder({
      symbol: analysis.pair,
      side,
      lots,
      sl: { pips: slPips },
      tp: { pips: tpPips },
    });
    log.info('Ордер открыт', { orderId: result.orderId, pair: analysis.pair, side, lots });
    logDecision(
      cycleId,
      'entry',
      analysis.pair,
      `${side} ${analysis.pair}`,
      [
        `Confluence: ${analysis.confluenceScore} (${analysis.signal})`,
        `Confidence: ${analysis.confidence}%`,
        `Regime: ${analysis.regime}`,
        `Reason: ${reason}`,
      ],
      {
        confluenceScore: analysis.confluenceScore,
        confluenceSignal: analysis.signal,
        confidence: analysis.confidence,
        regime: analysis.regime,
        bias: analysis.bias,
        side,
        entry: analysis.lastPrice,
        lots,
        slPips,
        tpPips,
        rr: tpPips / slPips,
        atr: analysis.atr,
      },
    );
    return true;
  } catch (err: unknown) {
    log.error('Ошибка открытия ордера', {
      pair: analysis.pair,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Исполняет торговые сигналы с LLM-советником (event-driven).
 *
 * Поток:
 * 1. Фильтрация: отсеиваем пары уже в позиции и слабые сигналы
 * 2. Fast-track: очень сильные сигналы (confluence>=65, confidence>=75%) исполняются сразу
 * 3. LLM: остальные кандидаты (confluence>=35) отправляются в LLM для ENTER/SKIP/WAIT
 * 4. Исполняются только ENTER решения
 */
async function executeSignals(
  cycleId: string,
  analyses: ForexAnalysisResult[],
  positions: PositionWithId[],
  balanceUsd: number,
): Promise<void> {
  const openSymbols = new Set(positions.map((p) => p.symbol));
  let slotsAvailable = config.maxOpenPositions - positions.length;
  let opened = 0;

  // Фильтруем: убираем уже открытые и слабые
  const candidates = analyses
    .filter((a) => !openSymbols.has(a.pair) && passesMinFilter(a))
    .sort(
      (a, b) =>
        Math.abs(b.confluenceScore) * b.confidence - Math.abs(a.confluenceScore) * a.confidence,
    );

  if (candidates.length === 0) {
    log.info('Нет кандидатов для торговли');
    return;
  }

  // Fast-track: очень сильные сигналы исполняются без LLM
  const fastTrack = candidates.filter((c) => isFastTrack(c));
  const forLLM = candidates.filter((c) => !isFastTrack(c));

  for (const analysis of fastTrack) {
    if (slotsAvailable <= 0) break;
    const success = await placeOrder(cycleId, analysis, balanceUsd, 'fast-track');
    if (success) {
      opened++;
      slotsAvailable--;
    }
  }

  // LLM-советник для остальных кандидатов
  if (forLLM.length > 0 && slotsAvailable > 0) {
    log.info(`Отправляем ${forLLM.length} кандидатов в LLM-советник`);

    const decisions = await runForexLLMAdvisor(cycleId, forLLM);
    const enterPairs = new Set(decisions.filter((d) => d.decision === 'ENTER').map((d) => d.pair));

    for (const analysis of forLLM) {
      if (slotsAvailable <= 0) break;
      if (!enterPairs.has(analysis.pair)) {
        const decision = decisions.find((d) => d.pair === analysis.pair);
        log.info(
          `LLM: ${analysis.pair} → ${decision?.decision ?? 'SKIP'}: ${decision?.reason ?? ''}`,
        );
        logDecision(
          cycleId,
          'skip',
          analysis.pair,
          `LLM SKIP: ${decision?.reason ?? ''}`,
          [
            `Confluence: ${analysis.confluenceScore}`,
            `LLM decision: ${decision?.decision ?? 'N/A'}`,
          ],
          {
            confluenceScore: analysis.confluenceScore,
            confidence: analysis.confidence,
            regime: analysis.regime,
            ...(decision?.decision !== undefined && { llmDecision: decision.decision }),
            ...(decision?.reason !== undefined && { llmReason: decision.reason }),
          },
        );
        continue;
      }

      const success = await placeOrder(cycleId, analysis, balanceUsd, 'llm-enter');
      if (success) {
        opened++;
        slotsAvailable--;
      }
    }
  }

  if (opened > 0) {
    log.info(`Открыто ордеров: ${opened}`);
  } else {
    log.info('Нет новых ордеров в этом цикле');
  }
}

// ─── Healthcheck ─────────────────────────────────────────────────────────────

function writeHealthcheck(
  cycleId: string,
  positionsCount: number,
  balance: number,
  startTime: number,
): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const healthData = {
      timestamp: new Date().toISOString(),
      cycleId,
      positions: positionsCount,
      balance,
      elapsed: `${((Date.now() - startTime) / 1000).toFixed(1)}s`,
    };
    const tmpFile = HEALTH_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(healthData, null, 2), 'utf-8');
    fs.renameSync(tmpFile, HEALTH_FILE);
  } catch {
    // best effort — не критично
  }
}

// ─── Main цикл ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const startTime = Date.now();
  const cycleId = generateCycleId();

  log.info('Forex monitor cycle start', { cycleId, dryRun: DRY_RUN });

  // 0. Загрузка кэша свечей с диска
  loadCandleStore();

  // Ротация журнала и очистка устаревших watchlist записей
  rotateIfNeeded();
  cleanWatchlist();

  // 1. Kill switch — немедленная остановка
  if (isKillSwitchActive()) {
    log.warn('KILL SWITCH активен — цикл пропущен', { cycleId });
    return;
  }

  // 2. Lockfile — предотвращаем параллельный запуск
  if (!acquireLock(LOCK_FILE, 10 * 60 * 1000)) {
    log.warn('Monitor cycle пропущен — предыдущий ещё работает', { cycleId });
    return;
  }

  try {
    // 3. Загрузка состояния + сброс дневных счётчиков если новый день
    const state = loadState();
    const today = new Date().toISOString().slice(0, 10);
    if (state.lastResetDate !== today) {
      resetDaily();
      log.info('Дневные счётчики сброшены', { date: today });
    }

    // 4. Получение баланса и позиций
    const [account, positions] = await Promise.all([getBalance(), getPositions()]);

    log.info('Состояние аккаунта', {
      cycleId,
      equity: account.totalEquity.toFixed(2),
      balance: account.totalWalletBalance.toFixed(2),
      positions: positions.length,
    });

    // Обновляем баланс в state для расчёта просадок
    updateAccountBalance(account.totalWalletBalance);

    // 5. Проверка drawdown — текущая просадка по equity vs balance
    const ddPct =
      account.totalEquity < account.totalWalletBalance
        ? ((account.totalWalletBalance - account.totalEquity) / account.totalWalletBalance) * 100
        : 0;

    if (ddPct >= config.maxDailyDrawdownPct) {
      log.error('Достигнут лимит просадки — активируем kill switch', {
        cycleId,
        ddPct: ddPct.toFixed(1),
        limit: config.maxDailyDrawdownPct,
      });
      activateKillSwitch(`Просадка ${ddPct.toFixed(1)}% >= лимита ${config.maxDailyDrawdownPct}%`);
      await sendTelegram(
        `🚨 *FOREX KILL SWITCH*\nПросадка ${ddPct.toFixed(1)}% >= лимита ${config.maxDailyDrawdownPct}%\nТорговля остановлена.`,
      );
      return;
    }

    if (ddPct >= config.maxDailyDrawdownPct * 0.75) {
      log.warn('Drawdown приближается к лимиту', {
        ddPct: ddPct.toFixed(1),
        limit: config.maxDailyDrawdownPct,
      });
    }

    // 6. Управление открытыми позициями (partial close, trailing SL)
    await managePositions(positions);

    // 7. Получаем свежие цены и обновляем свечи
    await getCurrentPrices(config.pairs);

    // 8. Анализ рынка
    const analyses = analyzeAll(config.pairs);

    log.info('Анализ рынка завершён', {
      cycleId,
      analyzed: analyses.length,
      total: config.pairs.length,
    });

    // Сохраняем snapshot'ы для истории confluence scores
    if (analyses.length > 0) {
      saveForexSnapshots(cycleId, analyses);
    }

    // 9. Исполнение сигналов (только если торговля разрешена и есть слоты)
    const tradeCheck = canTrade();
    if (!tradeCheck.allowed) {
      log.info('Торговля не разрешена', { reason: tradeCheck.reason });
    } else if (positions.length >= config.maxOpenPositions) {
      log.info('Достигнут лимит открытых позиций', {
        open: positions.length,
        max: config.maxOpenPositions,
      });
    } else {
      await executeSignals(cycleId, analyses, positions, account.totalWalletBalance);
    }

    // 10. Сохранение состояния
    saveState();

    // 11. Healthcheck
    writeHealthcheck(cycleId, positions.length, account.totalWalletBalance, startTime);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log.info('Forex monitor cycle complete', {
      cycleId,
      elapsed: `${elapsed}s`,
      positions: positions.length,
      dryRun: DRY_RUN,
    });
  } finally {
    releaseLock(LOCK_FILE);
  }
}

runMain(main, disconnect);
