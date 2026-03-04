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

function validateRisk(
  lots: number,
  hasSl: boolean,
  hasTp: boolean,
): { ok: boolean; error?: string } {
  if (lots > 10.0) return { ok: false, error: `Lot size ${lots} too large. Max 10.0` };
  if (lots < 0.01) return { ok: false, error: `Lot size ${lots} too small. Min 0.01` };
  if (!hasSl)
    return { ok: false, error: 'SL required! Positions without Stop Loss are forbidden.' };
  if (!hasTp)
    return { ok: false, error: 'TP required! Positions without Take Profit are forbidden.' };
  return { ok: true };
}

async function actionOpen(): Promise<void> {
  const pair = getRequiredArg('pair').toUpperCase();
  const side = getRequiredArg('side').toUpperCase() as 'BUY' | 'SELL';
  const lots = getNumArg('lots') ?? 0.01;

  // Absolute prices take priority over pips
  const slPrice = getNumArg('sl');
  const tpPrice = getNumArg('tp');
  const slPips = getNumArg('sl-pips');
  const tpPips = getNumArg('tp-pips');

  const hasSl = !!(slPrice ?? slPips);
  const hasTp = !!(tpPrice ?? tpPips);

  const validation = validateRisk(lots, hasSl, hasTp);
  if (!validation.ok) {
    console.log(JSON.stringify({ error: validation.error, action: 'REJECTED' }));
    return;
  }

  // Build SL/TP specs — prefer absolute price over pips
  const sl = slPrice ? { price: slPrice } : slPips ? { pips: slPips } : undefined;
  const tp = tpPrice ? { price: tpPrice } : tpPips ? { pips: tpPips } : undefined;

  const result = await submitOrder({
    symbol: pair,
    side: side === 'BUY' ? 'Buy' : 'Sell',
    lots,
    sl,
    tp,
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
  const slPrice = getNumArg('sl');
  const tpPrice = getNumArg('tp');
  const slPips = getNumArg('sl-pips');
  const tpPips = getNumArg('tp-pips');

  const sl = slPrice ? { price: slPrice } : slPips ? { pips: slPips } : undefined;
  const tp = tpPrice ? { price: tpPrice } : tpPips ? { pips: tpPips } : undefined;

  await modifyPosition(positionId, { sl, tp });

  console.log(
    JSON.stringify(
      {
        status: 'MODIFIED',
        positionId,
        sl: slPrice ?? slPips,
        tp: tpPrice ?? tpPips,
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
