import { getArg, getNumArg, getRequiredArg } from '../../utils/args.js';
import { createLogger } from '../../utils/logger.js';
import { runMain } from '../../utils/process.js';
import {
  cancelSymbolOrders,
  closeAllPositions,
  closePosition,
  getBalance,
  getPositions,
  modifyPosition,
  setLeverage,
  submitOrder,
} from './bybit-client.js';

const log = createLogger('crypto-trade');

function validateRisk(qty: string, sl?: string, tp?: string): { ok: boolean; error?: string } {
  const qtyNum = parseFloat(qty);
  if (isNaN(qtyNum) || qtyNum <= 0) return { ok: false, error: `Invalid qty: ${qty}` };
  if (!sl) return { ok: false, error: 'SL required! Positions without Stop Loss are forbidden.' };
  if (!tp) return { ok: false, error: 'TP required! Positions without Take Profit are forbidden.' };
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

  const validation = validateRisk(qty, sl, tp);
  if (!validation.ok) {
    log.warn('Order rejected', { error: validation.error, action: 'REJECTED' });
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

  log.info('Order opened', { ...result, timestamp: new Date().toISOString() });
}

async function actionClose(): Promise<void> {
  const pair = getRequiredArg('pair').toUpperCase();
  const result = await closePosition(pair);
  log.info('Position closed', { ...result, timestamp: new Date().toISOString() });
  // Отменяем оставшиеся ордера (grid-лимитки, SL/TP)
  const cancelled = await cancelSymbolOrders(pair);
  if (cancelled > 0) log.info('Cancelled remaining orders', { pair, cancelled });
}

async function actionCloseAll(): Promise<void> {
  const result = await closeAllPositions();
  log.info('All positions closed', { ...result, timestamp: new Date().toISOString() });
}

async function actionModify(): Promise<void> {
  const pair = getRequiredArg('pair').toUpperCase();
  const sl = getArg('sl');
  const tp = getArg('tp');

  await modifyPosition(pair, sl, tp);

  log.info('Position modified', {
    status: 'MODIFIED',
    symbol: pair,
    sl,
    tp,
    timestamp: new Date().toISOString(),
  });
}

async function actionStatus(): Promise<void> {
  const [account, positions] = await Promise.all([getBalance(), getPositions()]);

  log.info('Account status', {
    account,
    positions,
    positionsCount: positions.length,
    totalUnrealisedPnl: positions.reduce((s, p) => s + parseFloat(p.unrealisedPnl ?? '0'), 0),
    timestamp: new Date().toISOString(),
  });
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
