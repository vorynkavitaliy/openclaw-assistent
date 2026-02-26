#!/usr/bin/env node
'use strict';
/**
 * Bybit Trade — полноценный торговый модуль для Bybit API v5.
 *
 * Использует bybit-api (Node SDK) с поддержкой Demo Trading.
 * Credentials из ~/.openclaw/credentials.json или env vars.
 *
 * Действия:
 *   --action=order          Создать ордер (Market/Limit)
 *   --action=close          Закрыть позицию по паре
 *   --action=partial_close  Частично закрыть позицию
 *   --action=modify         Изменить SL/TP позиции
 *   --action=close_all      Закрыть все позиции
 *   --action=positions      Показать открытые позиции
 *   --action=balance        Показать баланс
 *   --action=leverage       Установить плечо
 *
 * Примеры:
 *   node bybit_trade.js --action=order --symbol=SOLUSDT --side=Buy --qty=1 --sl=140 --tp=200
 *   node bybit_trade.js --action=close --symbol=BTCUSDT
 *   node bybit_trade.js --action=positions
 *   node bybit_trade.js --action=balance
 *   node bybit_trade.js --action=modify --symbol=BTCUSDT --sl=96500 --tp=103000
 *   node bybit_trade.js --action=leverage --symbol=BTCUSDT --leverage=5
 *
 * Env vars (приоритет перед credentials.json):
 *   BYBIT_API_KEY, BYBIT_API_SECRET, BYBIT_TESTNET, BYBIT_DEMO_TRADING
 */

const fs = require('fs');
const path = require('path');
const { RestClientV5 } = require('bybit-api');

// ─── Константы ────────────────────────────────────────────────
const MAX_LEVERAGE = 5;
const DEFAULT_LEVERAGE = 3;
const CATEGORY = 'linear'; // USDT-M фьючерсы

// ─── CLI утилиты ──────────────────────────────────────────────

function getArg(name, defaultValue = undefined) {
  const prefix = `--${name}=`;
  const found = process.argv.find(a => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : defaultValue;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function toBool(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

// ─── Credentials ──────────────────────────────────────────────

function loadCredentials() {
  const configPath = path.join(process.env.HOME || '/root', '.openclaw', 'credentials.json');
  if (!fs.existsSync(configPath))
    return { apiKey: '', apiSecret: '', testnet: false, demoTrading: false };

  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const bybit = config.bybit || {};
  return {
    apiKey: bybit.api_key || '',
    apiSecret: bybit.api_secret || '',
    testnet: Boolean(bybit.testnet),
    demoTrading: Boolean(bybit.demoTrading || bybit.demo_trading),
    defaultLeverage: bybit.default_leverage || DEFAULT_LEVERAGE,
    maxLeverage: bybit.max_leverage || MAX_LEVERAGE,
  };
}

function createClient() {
  const creds = loadCredentials();

  const apiKey = process.env.BYBIT_API_KEY || creds.apiKey;
  const apiSecret = process.env.BYBIT_API_SECRET || creds.apiSecret;
  const testnet = toBool(process.env.BYBIT_TESTNET, creds.testnet);
  const demoTrading = hasFlag('demo') || toBool(process.env.BYBIT_DEMO_TRADING, creds.demoTrading);

  if (!apiKey || !apiSecret) {
    console.error(
      JSON.stringify({ error: 'API ключи не настроены. Проверь ~/.openclaw/credentials.json' })
    );
    process.exit(1);
  }

  return {
    client: new RestClientV5({ key: apiKey, secret: apiSecret, testnet, demoTrading }),
    creds,
  };
}

// ─── Вывод ────────────────────────────────────────────────────

function out(data) {
  console.log(JSON.stringify(data, null, 2));
}

function fail(msg, extra = {}) {
  out({ status: 'ERROR', error: msg, ...extra });
  process.exit(1);
}

// ─── Действия ─────────────────────────────────────────────────

/** Баланс кошелька */
async function actionBalance(client) {
  const coin = getArg('coin', 'USDT');
  const res = await client.getWalletBalance({ accountType: 'UNIFIED', coin });

  if (res.retCode !== 0) return fail(res.retMsg, { retCode: res.retCode });

  const account = res.result?.list?.[0];
  if (!account) return fail('Аккаунт не найден');

  const coinData = account.coin?.find(c => c.coin === coin);
  out({
    status: 'OK',
    action: 'balance',
    totalEquity: account.totalEquity,
    totalWalletBalance: account.totalWalletBalance,
    totalAvailableBalance: account.totalAvailableBalance,
    totalPerpUPL: account.totalPerpUPL,
    coin: coinData
      ? {
          coin: coinData.coin,
          equity: coinData.equity,
          walletBalance: coinData.walletBalance,
          availableToWithdraw: coinData.availableToWithdraw,
          unrealisedPnl: coinData.unrealisedPnl,
        }
      : null,
  });
}

/** Открытые позиции */
async function actionPositions(client) {
  const symbol = getArg('symbol');
  const params = { category: CATEGORY, settleCoin: 'USDT' };
  if (symbol) params.symbol = symbol.toUpperCase();

  const res = await client.getPositionInfo(params);
  if (res.retCode !== 0) return fail(res.retMsg, { retCode: res.retCode });

  const positions = (res.result?.list || [])
    .filter(p => parseFloat(p.size) > 0)
    .map(p => ({
      symbol: p.symbol,
      side: p.side,
      size: p.size,
      entryPrice: p.avgPrice,
      markPrice: p.markPrice,
      unrealisedPnl: p.unrealisedPnl,
      leverage: p.leverage,
      liqPrice: p.liqPrice,
      stopLoss: p.stopLoss,
      takeProfit: p.takeProfit,
      trailingStop: p.trailingStop,
    }));

  out({ status: 'OK', action: 'positions', count: positions.length, positions });
}

/** Создать ордер (открытие позиции) */
async function actionOrder(client) {
  const symbol = getArg('symbol');
  if (!symbol) return fail('--symbol обязателен');

  const side = getArg('side', 'Buy');
  const orderType = getArg('type', 'Market');
  const qty = getArg('qty');
  if (!qty) return fail('--qty обязателен');

  const params = {
    category: CATEGORY,
    symbol: symbol.toUpperCase(),
    side,
    orderType,
    qty: String(qty),
    timeInForce: 'GTC',
  };

  // Limit ордер — нужна цена
  const price = getArg('price');
  if (orderType.toLowerCase() === 'limit') {
    if (!price) return fail('--price обязателен для Limit ордера');
    params.price = String(price);
  }

  // SL/TP
  const sl = getArg('sl');
  const tp = getArg('tp');
  if (sl) {
    params.stopLoss = String(sl);
    params.slTriggerBy = 'LastPrice';
  }
  if (tp) {
    params.takeProfit = String(tp);
    params.tpTriggerBy = 'LastPrice';
  }

  const res = await client.submitOrder(params);
  if (res.retCode !== 0) return fail(res.retMsg, { retCode: res.retCode });

  out({
    status: 'EXECUTED',
    action: 'order',
    orderId: res.result.orderId,
    orderLinkId: res.result.orderLinkId || '',
    symbol: symbol.toUpperCase(),
    side,
    orderType,
    qty,
    sl: sl || null,
    tp: tp || null,
    timestamp: new Date().toISOString(),
  });
}

/** Закрыть позицию */
async function actionClose(client) {
  const symbol = getArg('symbol');
  if (!symbol) return fail('--symbol обязателен');

  // Получаем текущую позицию
  const posRes = await client.getPositionInfo({ category: CATEGORY, symbol: symbol.toUpperCase() });
  if (posRes.retCode !== 0) return fail(posRes.retMsg, { retCode: posRes.retCode });

  const pos = (posRes.result?.list || []).find(p => parseFloat(p.size) > 0);
  if (!pos) return fail('Нет открытой позиции', { symbol: symbol.toUpperCase() });

  const closeSide = pos.side === 'Buy' ? 'Sell' : 'Buy';

  const res = await client.submitOrder({
    category: CATEGORY,
    symbol: symbol.toUpperCase(),
    side: closeSide,
    orderType: 'Market',
    qty: pos.size,
    timeInForce: 'GTC',
    reduceOnly: true,
  });

  if (res.retCode !== 0) return fail(res.retMsg, { retCode: res.retCode });

  out({
    status: 'CLOSED',
    action: 'close',
    orderId: res.result.orderId,
    symbol: symbol.toUpperCase(),
    closedQty: pos.size,
    closedSide: pos.side,
    unrealisedPnl: pos.unrealisedPnl,
    timestamp: new Date().toISOString(),
  });
}

/** Частичное закрытие позиции */
async function actionPartialClose(client) {
  const symbol = getArg('symbol');
  const qty = getArg('qty');
  if (!symbol) return fail('--symbol обязателен');
  if (!qty) return fail('--qty обязателен');

  const posRes = await client.getPositionInfo({ category: CATEGORY, symbol: symbol.toUpperCase() });
  if (posRes.retCode !== 0) return fail(posRes.retMsg, { retCode: posRes.retCode });

  const pos = (posRes.result?.list || []).find(p => parseFloat(p.size) > 0);
  if (!pos) return fail('Нет открытой позиции', { symbol: symbol.toUpperCase() });

  const closeSide = pos.side === 'Buy' ? 'Sell' : 'Buy';

  const res = await client.submitOrder({
    category: CATEGORY,
    symbol: symbol.toUpperCase(),
    side: closeSide,
    orderType: 'Market',
    qty: String(qty),
    timeInForce: 'GTC',
    reduceOnly: true,
  });

  if (res.retCode !== 0) return fail(res.retMsg, { retCode: res.retCode });

  out({
    status: 'PARTIAL_CLOSED',
    action: 'partial_close',
    orderId: res.result.orderId,
    symbol: symbol.toUpperCase(),
    closedQty: qty,
    remainingQty: String(parseFloat(pos.size) - parseFloat(qty)),
    timestamp: new Date().toISOString(),
  });
}

/** Модификация SL/TP */
async function actionModify(client) {
  const symbol = getArg('symbol');
  if (!symbol) return fail('--symbol обязателен');

  const sl = getArg('sl');
  const tp = getArg('tp');
  if (!sl && !tp) return fail('Укажи --sl и/или --tp');

  const params = { category: CATEGORY, symbol: symbol.toUpperCase(), positionIdx: 0 };
  if (sl) {
    params.stopLoss = String(sl);
    params.slTriggerBy = 'LastPrice';
  }
  if (tp) {
    params.takeProfit = String(tp);
    params.tpTriggerBy = 'LastPrice';
  }

  const res = await client.setTradingStop(params);
  if (res.retCode !== 0) return fail(res.retMsg, { retCode: res.retCode });

  out({
    status: 'MODIFIED',
    action: 'modify',
    symbol: symbol.toUpperCase(),
    newSl: sl || null,
    newTp: tp || null,
    timestamp: new Date().toISOString(),
  });
}

/** Закрыть все позиции */
async function actionCloseAll(client) {
  const posRes = await client.getPositionInfo({ category: CATEGORY, settleCoin: 'USDT' });
  if (posRes.retCode !== 0) return fail(posRes.retMsg, { retCode: posRes.retCode });

  const openPositions = (posRes.result?.list || []).filter(p => parseFloat(p.size) > 0);
  if (openPositions.length === 0) {
    return out({ status: 'OK', action: 'close_all', message: 'Нет открытых позиций', closed: 0 });
  }

  const results = [];
  for (const pos of openPositions) {
    const closeSide = pos.side === 'Buy' ? 'Sell' : 'Buy';
    try {
      const res = await client.submitOrder({
        category: CATEGORY,
        symbol: pos.symbol,
        side: closeSide,
        orderType: 'Market',
        qty: pos.size,
        timeInForce: 'GTC',
        reduceOnly: true,
      });
      results.push({
        symbol: pos.symbol,
        qty: pos.size,
        side: pos.side,
        result: res.retCode === 0 ? 'OK' : res.retMsg,
      });
    } catch (err) {
      results.push({ symbol: pos.symbol, qty: pos.size, result: err.message });
    }
  }

  out({
    status: 'ALL_CLOSED',
    action: 'close_all',
    closed: results.filter(r => r.result === 'OK').length,
    total: openPositions.length,
    details: results,
    timestamp: new Date().toISOString(),
  });
}

/** Установить плечо */
async function actionLeverage(client, creds) {
  const symbol = getArg('symbol');
  if (!symbol) return fail('--symbol обязателен');

  const leverage = parseInt(getArg('leverage', String(creds.defaultLeverage || DEFAULT_LEVERAGE)));
  if (leverage > (creds.maxLeverage || MAX_LEVERAGE)) {
    return fail(`Плечо ${leverage}x превышает максимум ${creds.maxLeverage || MAX_LEVERAGE}x`);
  }

  const res = await client.setLeverage({
    category: CATEGORY,
    symbol: symbol.toUpperCase(),
    buyLeverage: String(leverage),
    sellLeverage: String(leverage),
  });

  // retCode 110043 = "Set leverage not modified" (уже установлено) — не ошибка
  if (res.retCode !== 0 && res.retCode !== 110043) {
    return fail(res.retMsg, { retCode: res.retCode });
  }

  out({
    status: 'OK',
    action: 'leverage',
    symbol: symbol.toUpperCase(),
    leverage,
    timestamp: new Date().toISOString(),
  });
}

// ─── Main ─────────────────────────────────────────────────────

async function main() {
  const { client, creds } = createClient();
  const action = getArg('action', 'balance');

  const actions = {
    balance: () => actionBalance(client),
    positions: () => actionPositions(client),
    order: () => actionOrder(client),
    close: () => actionClose(client),
    partial_close: () => actionPartialClose(client),
    modify: () => actionModify(client),
    close_all: () => actionCloseAll(client),
    leverage: () => actionLeverage(client, creds),
  };

  const handler = actions[action];
  if (!handler) {
    fail(`Неизвестное действие: ${action}`, {
      available: Object.keys(actions),
    });
  }

  await handler();
}

main().catch(err => {
  out({ status: 'ERROR', error: err?.message || String(err) });
  process.exit(1);
});
