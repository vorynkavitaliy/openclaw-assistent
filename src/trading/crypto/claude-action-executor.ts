import { createLogger } from '../../utils/logger.js';
import { sendTelegram } from '../../utils/telegram.js';
import { closePosition, modifyPosition } from './bybit-client.js';
import { logDecision } from './decision-journal.js';
import type { TradeSignalInternal } from './market-analyzer.js';
import { executeSignals } from './signal-executor.js';
import * as state from './state.js';

const log = createLogger('claude-action-executor');

// ─── Типы ─────────────────────────────────────────────────────────

export type ClaudeActionType = 'ENTER' | 'CLOSE' | 'MODIFY_SL' | 'MODIFY_TP' | 'SKIP' | 'WAIT';

export interface ClaudeAction {
  type: ClaudeActionType;
  pair: string;
  reason: string;
  // ENTER
  side?: 'Buy' | 'Sell';
  confidence?: number;
  // MODIFY_SL / MODIFY_TP
  newSl?: number;
  newTp?: number;
}

export interface ClaudeResponse {
  summary: string;
  actions: ClaudeAction[];
}

export interface ActionResult {
  type: ClaudeActionType;
  pair: string;
  status: 'OK' | 'ERROR' | 'SKIPPED' | 'DRY_RUN';
  message: string;
}

// ─── Валидация типов ───────────────────────────────────────────────

const VALID_ACTION_TYPES = new Set<ClaudeActionType>([
  'ENTER',
  'CLOSE',
  'MODIFY_SL',
  'MODIFY_TP',
  'SKIP',
  'WAIT',
]);

function isValidActionType(value: unknown): value is ClaudeActionType {
  return typeof value === 'string' && VALID_ACTION_TYPES.has(value as ClaudeActionType);
}

function isValidAction(raw: unknown): raw is ClaudeAction {
  if (!raw || typeof raw !== 'object') return false;
  const obj = raw as Record<string, unknown>;
  return (
    isValidActionType(obj.type) &&
    typeof obj.pair === 'string' &&
    obj.pair.trim().length > 0 &&
    typeof obj.reason === 'string'
  );
}

// ─── Парсинг ответа Claude ─────────────────────────────────────────

/**
 * Извлекает JSON из строки — поддерживает как чистый JSON, так и обёрнутый в ```json ... ```.
 */
function extractJson(content: string): string {
  // Пробуем извлечь из markdown code block
  const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch?.[1]) {
    return codeBlockMatch[1].trim();
  }

  // Пробуем найти JSON объект в тексте
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (jsonMatch?.[0]) {
    return jsonMatch[0];
  }

  return content.trim();
}

/**
 * Парсит JSON ответ от Claude.
 * При ошибке парсинга возвращает SKIP для всех fallbackPairs.
 */
export function parseClaudeResponse(content: string, fallbackPairs: string[]): ClaudeResponse {
  try {
    const jsonStr = extractJson(content);
    const parsed = JSON.parse(jsonStr) as unknown;

    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Parsed value is not an object');
    }

    const obj = parsed as Record<string, unknown>;
    const summary = typeof obj.summary === 'string' ? obj.summary : 'No summary provided';

    const rawActions = Array.isArray(obj.actions) ? obj.actions : [];
    const actions: ClaudeAction[] = rawActions.filter(isValidAction).map((action) => ({
      ...action,
      pair: action.pair.trim().toUpperCase(),
    }));

    if (actions.length === 0) {
      log.warn('Claude response contained no valid actions — falling back to SKIP', {
        rawActionsCount: rawActions.length,
      });
      return {
        summary,
        actions: fallbackPairs.map((pair) => ({
          type: 'SKIP' as ClaudeActionType,
          pair,
          reason: 'No valid actions in Claude response',
        })),
      };
    }

    log.info('Claude response parsed', {
      summary: summary.slice(0, 120),
      actionTypes: actions.map((a) => `${a.type}:${a.pair}`).join(', '),
    });

    return { summary, actions };
  } catch (err) {
    log.warn('Failed to parse Claude response — returning SKIP for all pairs', {
      error: (err as Error).message,
      contentSnippet: content.slice(0, 200),
    });

    return {
      summary: 'Parse error — defaulting to SKIP',
      actions: fallbackPairs.map((pair) => ({
        type: 'SKIP' as ClaudeActionType,
        pair,
        reason: `JSON parse failed: ${(err as Error).message}`,
      })),
    };
  }
}

// ─── Исполнение действий ───────────────────────────────────────────

/**
 * Исполняет список действий из ответа Claude.
 * Не крашится при ошибках API — логирует и продолжает.
 */
export async function executeClaudeActions(
  response: ClaudeResponse,
  signals: TradeSignalInternal[],
  cycleId: string,
  dryRun: boolean,
): Promise<ActionResult[]> {
  const results: ActionResult[] = [];

  for (const action of response.actions) {
    const result = await executeSingleAction(action, signals, cycleId, dryRun);
    results.push(result);
  }

  return results;
}

async function executeSingleAction(
  action: ClaudeAction,
  signals: TradeSignalInternal[],
  cycleId: string,
  dryRun: boolean,
): Promise<ActionResult> {
  const { type, pair } = action;

  switch (type) {
    case 'ENTER':
      return executeEnter(action, signals, cycleId, dryRun);

    case 'CLOSE':
      return executeClose(action, cycleId, dryRun);

    case 'MODIFY_SL':
      return executeModifySl(action, cycleId, dryRun);

    case 'MODIFY_TP':
      return executeModifyTp(action, cycleId, dryRun);

    case 'SKIP':
    case 'WAIT': {
      logDecision(cycleId, 'skip', pair, `CLAUDE_${type}`, [action.reason], {});
      log.info(`Claude ${type}`, { pair, reason: action.reason });
      return { type, pair, status: 'SKIPPED', message: action.reason };
    }
  }
}

// ─── ENTER ────────────────────────────────────────────────────────

async function executeEnter(
  action: ClaudeAction,
  signals: TradeSignalInternal[],
  cycleId: string,
  dryRun: boolean,
): Promise<ActionResult> {
  const { pair, reason, side } = action;

  // Ищем соответствующий сигнал по паре и опционально по side
  const signal = signals.find((s) => s.pair === pair && (side === undefined || s.side === side));

  if (!signal) {
    const msg = `No matching signal found for ${pair}${side ? ` side=${side}` : ''}`;
    log.warn('ENTER action skipped — signal not found', { pair, side });
    logDecision(cycleId, 'skip', pair, 'CLAUDE_ENTER_NO_SIGNAL', [reason, msg], {});
    return { type: 'ENTER', pair, status: 'SKIPPED', message: msg };
  }

  log.info('Executing CLAUDE ENTER', {
    pair,
    side: signal.side,
    entry: signal.entryPrice,
    sl: signal.sl,
    tp: signal.tp,
    confidence: action.confidence,
    reason,
  });

  log.info('Calling executeSignals for ENTER', { pair, dryRun });
  const signalResults = await executeSignals([signal], cycleId, dryRun);
  const res = signalResults[0];

  if (!res) {
    log.error('executeSignals returned empty', { pair });
    return { type: 'ENTER', pair, status: 'ERROR', message: 'executeSignals returned empty' };
  }

  log.info('executeSignals result', { pair, action: res.action, dryRun });

  if (dryRun) {
    return { type: 'ENTER', pair, status: 'DRY_RUN', message: res.action };
  }

  if (res.action.startsWith('ERROR')) {
    return { type: 'ENTER', pair, status: 'ERROR', message: res.action };
  }

  if (res.action.startsWith('SKIP') || res.action.startsWith('BLOCKED')) {
    return { type: 'ENTER', pair, status: 'SKIPPED', message: res.action };
  }

  return { type: 'ENTER', pair, status: 'OK', message: res.action };
}

// ─── CLOSE ────────────────────────────────────────────────────────

async function executeClose(
  action: ClaudeAction,
  cycleId: string,
  dryRun: boolean,
): Promise<ActionResult> {
  const { pair, reason } = action;

  // Проверяем наличие позиции в state
  const s = state.get();
  const position = s.positions.find((p) => p.symbol === pair);

  if (!position) {
    const msg = `No open position found for ${pair} in state`;
    log.warn('CLOSE action skipped — no position in state', { pair });
    logDecision(cycleId, 'skip', pair, 'CLAUDE_CLOSE_NO_POSITION', [reason, msg], {});
    return { type: 'CLOSE', pair, status: 'SKIPPED', message: msg };
  }

  if (dryRun) {
    const msg = `DRY_RUN: would close ${pair} ${position.side} size=${position.size}`;
    log.info(msg);
    return { type: 'CLOSE', pair, status: 'DRY_RUN', message: msg };
  }

  try {
    const orderResult = await closePosition(pair);

    const entryPrice = parseFloat(position.entryPrice) || 0;
    const markPrice = parseFloat(position.markPrice) || 0;
    const unrealisedPnl = parseFloat(position.unrealisedPnl) || 0;
    const pnl = unrealisedPnl;

    state.recordTrade({
      symbol: pair,
      side: position.side,
      pnl,
      entryPrice,
      exitPrice: markPrice,
    });

    state.logEvent('position_closed_by_claude', {
      symbol: pair,
      side: position.side,
      size: position.size,
      entryPrice: position.entryPrice,
      markPrice: position.markPrice,
      unrealisedPnl: position.unrealisedPnl,
      reason,
      orderId: orderResult.orderId,
    });

    logDecision(
      cycleId,
      'exit',
      pair,
      'CLAUDE_CLOSE',
      [reason, `Closed ${position.side} size=${position.size} at ~${markPrice}`],
      { side: position.side },
    );

    const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
    const sideEmoji = position.side === 'long' ? 'LONG' : 'SHORT';
    await sendTelegram(
      `*Claude закрыл позицию*\n\n` +
        `Пара: \`${pair}\`\n` +
        `Сторона: ${sideEmoji}\n` +
        `Размер: ${position.size}\n` +
        `PnL: ${pnlStr}\n\n` +
        `Причина: ${reason}`,
    );

    log.info('Position closed by Claude', {
      pair,
      side: position.side,
      size: position.size,
      pnl,
      reason,
    });

    return {
      type: 'CLOSE',
      pair,
      status: 'OK',
      message: `Closed ${position.side} size=${position.size}, pnl=${pnlStr}`,
    };
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    log.error('Failed to close position by Claude', { pair, error: errMsg });
    state.logEvent('api_error', {
      type: 'claude_close_failed',
      symbol: pair,
      reason,
      error: errMsg,
    });
    return { type: 'CLOSE', pair, status: 'ERROR', message: errMsg };
  }
}

// ─── MODIFY_SL ────────────────────────────────────────────────────

async function executeModifySl(
  action: ClaudeAction,
  cycleId: string,
  dryRun: boolean,
): Promise<ActionResult> {
  const { pair, reason, newSl } = action;

  if (newSl === undefined || newSl <= 0) {
    const msg = `Invalid newSl value: ${String(newSl)}`;
    log.warn('MODIFY_SL skipped — invalid newSl', { pair, newSl });
    return { type: 'MODIFY_SL', pair, status: 'SKIPPED', message: msg };
  }

  const s = state.get();
  const position = s.positions.find((p) => p.symbol === pair);

  if (!position) {
    const msg = `No open position found for ${pair} in state`;
    log.warn('MODIFY_SL skipped — no position in state', { pair });
    logDecision(cycleId, 'skip', pair, 'CLAUDE_MODIFY_SL_NO_POSITION', [reason, msg], {});
    return { type: 'MODIFY_SL', pair, status: 'SKIPPED', message: msg };
  }

  const markPrice = parseFloat(position.markPrice) || 0;

  // Валидация: SL не должен быть за рыночной ценой в неверном направлении
  if (markPrice > 0) {
    if (position.side === 'long' && newSl >= markPrice) {
      const msg = `MODIFY_SL rejected: LONG position but newSl=${newSl} >= markPrice=${markPrice}`;
      log.warn(msg, { pair });
      logDecision(cycleId, 'skip', pair, 'CLAUDE_MODIFY_SL_INVALID', [reason, msg], {});
      return { type: 'MODIFY_SL', pair, status: 'SKIPPED', message: msg };
    }
    if (position.side === 'short' && newSl <= markPrice) {
      const msg = `MODIFY_SL rejected: SHORT position but newSl=${newSl} <= markPrice=${markPrice}`;
      log.warn(msg, { pair });
      logDecision(cycleId, 'skip', pair, 'CLAUDE_MODIFY_SL_INVALID', [reason, msg], {});
      return { type: 'MODIFY_SL', pair, status: 'SKIPPED', message: msg };
    }
  }

  if (dryRun) {
    const msg = `DRY_RUN: would set SL=${newSl} for ${pair} ${position.side} (markPrice=${markPrice})`;
    log.info(msg);
    return { type: 'MODIFY_SL', pair, status: 'DRY_RUN', message: msg };
  }

  try {
    await modifyPosition(pair, String(newSl));

    state.logEvent('sl_modified_by_claude', {
      symbol: pair,
      side: position.side,
      oldSl: position.stopLoss,
      newSl,
      markPrice,
      reason,
    });

    logDecision(
      cycleId,
      'manage',
      pair,
      'CLAUDE_MODIFY_SL',
      [reason, `SL: ${position.stopLoss ?? 'none'} → ${newSl} (markPrice=${markPrice})`],
      { side: position.side, sl: newSl },
    );

    log.info('SL modified by Claude', { pair, oldSl: position.stopLoss, newSl, reason });

    return {
      type: 'MODIFY_SL',
      pair,
      status: 'OK',
      message: `SL set to ${newSl} (was ${position.stopLoss ?? 'none'})`,
    };
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    log.error('Failed to modify SL by Claude', { pair, newSl, error: errMsg });
    state.logEvent('api_error', {
      type: 'claude_modify_sl_failed',
      symbol: pair,
      newSl,
      reason,
      error: errMsg,
    });
    return { type: 'MODIFY_SL', pair, status: 'ERROR', message: errMsg };
  }
}

// ─── MODIFY_TP ────────────────────────────────────────────────────

async function executeModifyTp(
  action: ClaudeAction,
  cycleId: string,
  dryRun: boolean,
): Promise<ActionResult> {
  const { pair, reason, newTp } = action;

  if (newTp === undefined || newTp <= 0) {
    const msg = `Invalid newTp value: ${String(newTp)}`;
    log.warn('MODIFY_TP skipped — invalid newTp', { pair, newTp });
    return { type: 'MODIFY_TP', pair, status: 'SKIPPED', message: msg };
  }

  const s = state.get();
  const position = s.positions.find((p) => p.symbol === pair);

  if (!position) {
    const msg = `No open position found for ${pair} in state`;
    log.warn('MODIFY_TP skipped — no position in state', { pair });
    logDecision(cycleId, 'skip', pair, 'CLAUDE_MODIFY_TP_NO_POSITION', [reason, msg], {});
    return { type: 'MODIFY_TP', pair, status: 'SKIPPED', message: msg };
  }

  const markPrice = parseFloat(position.markPrice) || 0;

  // Валидация: TP должен быть в правильном направлении
  if (markPrice > 0) {
    if (position.side === 'long' && newTp <= markPrice) {
      const msg = `MODIFY_TP rejected: LONG position but newTp=${newTp} <= markPrice=${markPrice}`;
      log.warn(msg, { pair });
      logDecision(cycleId, 'skip', pair, 'CLAUDE_MODIFY_TP_INVALID', [reason, msg], {});
      return { type: 'MODIFY_TP', pair, status: 'SKIPPED', message: msg };
    }
    if (position.side === 'short' && newTp >= markPrice) {
      const msg = `MODIFY_TP rejected: SHORT position but newTp=${newTp} >= markPrice=${markPrice}`;
      log.warn(msg, { pair });
      logDecision(cycleId, 'skip', pair, 'CLAUDE_MODIFY_TP_INVALID', [reason, msg], {});
      return { type: 'MODIFY_TP', pair, status: 'SKIPPED', message: msg };
    }
  }

  if (dryRun) {
    const msg = `DRY_RUN: would set TP=${newTp} for ${pair} ${position.side} (markPrice=${markPrice})`;
    log.info(msg);
    return { type: 'MODIFY_TP', pair, status: 'DRY_RUN', message: msg };
  }

  try {
    await modifyPosition(pair, undefined, String(newTp));

    state.logEvent('tp_modified_by_claude', {
      symbol: pair,
      side: position.side,
      oldTp: position.takeProfit,
      newTp,
      markPrice,
      reason,
    });

    logDecision(
      cycleId,
      'manage',
      pair,
      'CLAUDE_MODIFY_TP',
      [reason, `TP: ${position.takeProfit ?? 'none'} → ${newTp} (markPrice=${markPrice})`],
      { side: position.side, tp: newTp },
    );

    log.info('TP modified by Claude', { pair, oldTp: position.takeProfit, newTp, reason });

    return {
      type: 'MODIFY_TP',
      pair,
      status: 'OK',
      message: `TP set to ${newTp} (was ${position.takeProfit ?? 'none'})`,
    };
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    log.error('Failed to modify TP by Claude', { pair, newTp, error: errMsg });
    state.logEvent('api_error', {
      type: 'claude_modify_tp_failed',
      symbol: pair,
      newTp,
      reason,
      error: errMsg,
    });
    return { type: 'MODIFY_TP', pair, status: 'ERROR', message: errMsg };
  }
}
