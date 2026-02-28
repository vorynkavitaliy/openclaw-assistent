import { getArg, getNumArg, getRequiredArg } from '../../utils/args.js';
import { runMain } from '../../utils/process.js';
import {
  closeAll,
  closePosition,
  disconnect,
  getBalance,
  getPositions,
  modifyPosition,
  submitOrder,
} from './client.js';

function validateRisk(lots: number, slPips?: number): { ok: boolean; error?: string } {
  if (lots > 10.0) return { ok: false, error: `Lot size ${lots} too large. Max 10.0` };
  if (lots < 0.01) return { ok: false, error: `Lot size ${lots} too small. Min 0.01` };
  if (!slPips || slPips <= 0)
    return { ok: false, error: 'SL required! Positions without Stop Loss are forbidden.' };
  return { ok: true };
}

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

  console.log(JSON.stringify({ ...result, timestamp: new Date().toISOString() }, null, 2));
}

async function actionClose(): Promise<void> {
  const positionId = getRequiredArg('position-id');
  const partialLots = getNumArg('lots');

  await closePosition(positionId, partialLots);

  console.log(
    JSON.stringify(
      { status: 'CLOSED', positionId, partial: partialLots, timestamp: new Date().toISOString() },
      null,
      2,
    ),
  );
}

async function actionCloseAll(): Promise<void> {
  await closeAll();
  console.log(
    JSON.stringify({ status: 'ALL_CLOSED', timestamp: new Date().toISOString() }, null, 2),
  );
}

async function actionModify(): Promise<void> {
  const positionId = getRequiredArg('position-id');
  const slPips = getNumArg('sl-pips');
  const tpPips = getNumArg('tp-pips');

  const opts: Record<string, unknown> = {};
  if (slPips !== undefined) opts.sl = { pips: slPips };
  if (tpPips !== undefined) opts.tp = { pips: tpPips };

  await modifyPosition(positionId, opts as Parameters<typeof modifyPosition>[1]);

  console.log(
    JSON.stringify(
      { status: 'MODIFIED', positionId, slPips, tpPips, timestamp: new Date().toISOString() },
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

async function main(): Promise<void> {
  const action = getArg('action') ?? 'status';

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
      throw new Error(
        `Unknown action: ${action}. Available: open, close, close-all, modify, status`,
      );
  }
}

runMain(main, disconnect);
