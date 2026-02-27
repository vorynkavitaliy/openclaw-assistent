/**
 * Forex Trade CLI — торговые команды через cTrader.
 *
 * Использование:
 *   tsx src/trading/forex/trade.ts --action open --pair EURUSD --side BUY --lots 0.1 --sl-pips 50 --tp-pips 100
 *   tsx src/trading/forex/trade.ts --action close --position-id 123456
 *   tsx src/trading/forex/trade.ts --action close-all
 *   tsx src/trading/forex/trade.ts --action modify --position-id 123456 --sl-pips 30
 *   tsx src/trading/forex/trade.ts --action status
 *
 * Мигрировано из scripts/mt5_trade.py
 */

import { createLogger } from '../../utils/logger.js';
import {
  closeAll,
  closePosition,
  disconnect,
  getBalance,
  getPositions,
  modifyPosition,
  submitOrder,
} from './client.js';

const log = createLogger('forex-trade');

// ─── CLI parsing ─────────────────────────────────────────────

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((a: string) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function getNumArg(name: string): number | undefined {
  const val = getArg(name);
  return val !== undefined ? parseFloat(val) : undefined;
}

function getRequiredArg(name: string): string {
  const val = getArg(name);
  if (val === undefined) {
    console.error(JSON.stringify({ error: `--${name} обязателен` }));
    process.exit(1);
  }
  return val;
}

// ─── Validation ──────────────────────────────────────────────

function validateRisk(lots: number, slPips?: number): { ok: boolean; error?: string } {
  if (lots > 10.0) return { ok: false, error: `Лот ${lots} слишком большой. Макс 10.0` };
  if (lots < 0.01) return { ok: false, error: `Лот ${lots} слишком маленький. Мин 0.01` };
  if (!slPips || slPips <= 0)
    return { ok: false, error: 'SL обязателен! Позиция без Stop Loss запрещена.' };
  return { ok: true };
}

// ─── Actions ─────────────────────────────────────────────────

async function actionOpen(): Promise<void> {
  const pair = getRequiredArg('pair').toUpperCase();
  const side = getRequiredArg('side').toUpperCase() as 'BUY' | 'SELL';
  const lots = getNumArg('lots') ?? 0.01;
  const slPips = getNumArg('sl-pips');
  const tpPips = getNumArg('tp-pips');

  const validation = validateRisk(lots, slPips);
  if (!validation.ok) {
    console.log(JSON.stringify({ error: validation.error, action: 'REJECTED' }));
    return;
  }

  const result = await submitOrder({
    symbol: pair,
    side: side === 'BUY' ? 'Buy' : 'Sell',
    lots,
    sl: slPips ? { pips: slPips } : undefined,
    tp: tpPips ? { pips: tpPips } : undefined,
  });

  console.log(
    JSON.stringify(
      {
        ...result,
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

async function actionClose(): Promise<void> {
  const positionId = parseInt(getRequiredArg('position-id'), 10);
  const partialLots = getNumArg('lots');

  await closePosition(positionId, partialLots);

  console.log(
    JSON.stringify(
      {
        status: 'CLOSED',
        positionId,
        partial: partialLots,
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

async function actionCloseAll(): Promise<void> {
  await closeAll();
  console.log(
    JSON.stringify(
      {
        status: 'ALL_CLOSED',
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

async function actionModify(): Promise<void> {
  const positionId = parseInt(getRequiredArg('position-id'), 10);
  const slPips = getNumArg('sl-pips');
  const tpPips = getNumArg('tp-pips');

  const opts: Record<string, unknown> = {};
  if (slPips !== undefined) opts.sl = { pips: slPips };
  if (tpPips !== undefined) opts.tp = { pips: tpPips };

  await modifyPosition(positionId, opts as Parameters<typeof modifyPosition>[1]);

  console.log(
    JSON.stringify(
      {
        status: 'MODIFIED',
        positionId,
        slPips,
        tpPips,
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

async function actionStatus(): Promise<void> {
  const [account, positions] = await Promise.all([getBalance(), getPositions()]);

  console.log(
    JSON.stringify(
      {
        account,
        positions,
        positionsCount: positions.length,
        totalProfit: positions.reduce((s, p) => s + parseFloat(p.unrealisedPnl), 0),
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

// ─── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const action = getArg('action') ?? 'status';

  try {
    switch (action) {
      case 'open':
        await actionOpen();
        break;
      case 'close':
        await actionClose();
        break;
      case 'close-all':
      case 'close_all':
        await actionCloseAll();
        break;
      case 'modify':
        await actionModify();
        break;
      case 'status':
        await actionStatus();
        break;
      default:
        console.error(
          JSON.stringify({
            error: `Неизвестное действие: ${action}`,
            available: ['open', 'close', 'close-all', 'modify', 'status'],
          }),
        );
        process.exit(1);
    }
  } finally {
    disconnect();
  }
}

main().catch((err) => {
  log.error(`Ошибка: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
