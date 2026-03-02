import { getArg, getNumArg, getRequiredArg } from '../../utils/args.js';
import { runMain } from '../../utils/process.js';
import {
  closeAllPositions,
  closePosition,
  getBalance,
  getPositions,
  modifyPosition,
  setLeverage,
  submitOrder,
} from './bybit-client.js';

function validateRisk(qty: string, sl?: string): { ok: boolean; error?: string } {
  const qtyNum = parseFloat(qty);
  if (isNaN(qtyNum) || qtyNum <= 0) return { ok: false, error: `Invalid qty: ${qty}` };
  if (!sl) return { ok: false, error: 'SL required! Positions without Stop Loss are forbidden.' };
  return { ok: true };
}

async function actionOpen(): Promise<void> {
  const pair = getRequiredArg('pair').toUpperCase();
  const rawSide = getRequiredArg('side').toUpperCase();
  const side: 'Buy' | 'Sell' = rawSide === 'SELL' ? 'Sell' : 'Buy';
  const orderType = (getArg('type') ?? 'Market').replace(/^./, (c) => c.toUpperCase()) as
    | 'Market'
    | 'Limit';
  const qty = getRequiredArg('qty');
  const price = getArg('price');
  const sl = getArg('sl');
  const tp = getArg('tp');
  const leverage = getNumArg('leverage');

  const validation = validateRisk(qty, sl);
  if (!validation.ok) {
    console.log(JSON.stringify({ error: validation.error, action: 'REJECTED' }));
    return;
  }

  if (leverage) {
    await setLeverage(pair, leverage);
  }

  const result = await submitOrder({
    symbol: pair,
    side,
    orderType,
    qty,
    ...(price ? { price } : {}),
    ...(sl ? { stopLoss: sl } : {}),
    ...(tp ? { takeProfit: tp } : {}),
  });

  console.log(JSON.stringify({ ...result, timestamp: new Date().toISOString() }, null, 2));
}

async function actionClose(): Promise<void> {
  const pair = getRequiredArg('pair').toUpperCase();
  const result = await closePosition(pair);
  console.log(JSON.stringify({ ...result, timestamp: new Date().toISOString() }, null, 2));
}

async function actionCloseAll(): Promise<void> {
  const result = await closeAllPositions();
  console.log(JSON.stringify({ ...result, timestamp: new Date().toISOString() }, null, 2));
}

async function actionModify(): Promise<void> {
  const pair = getRequiredArg('pair').toUpperCase();
  const sl = getArg('sl');
  const tp = getArg('tp');

  await modifyPosition(pair, sl, tp);

  console.log(
    JSON.stringify(
      { status: 'MODIFIED', symbol: pair, sl, tp, timestamp: new Date().toISOString() },
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
        totalUnrealisedPnl: positions.reduce((s, p) => s + parseFloat(p.unrealisedPnl ?? '0'), 0),
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

runMain(main);
