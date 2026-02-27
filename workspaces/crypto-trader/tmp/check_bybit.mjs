#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import os from 'os';
import { RestClientV5 } from 'bybit-api';

function loadCredentials() {
  const configPath = path.join(os.homedir(), '.openclaw', 'credentials.json');
  const raw = fs.readFileSync(configPath, 'utf8');
  const json = JSON.parse(raw);
  const bybit = json.bybit || {};

  const apiKey = process.env.BYBIT_API_KEY || bybit.api_key;
  const apiSecret = process.env.BYBIT_API_SECRET || bybit.api_secret;
  const testnet = String(process.env.BYBIT_TESTNET ?? bybit.testnet ?? 'false').toLowerCase() === 'true';
  const demoTrading = String(process.env.BYBIT_DEMO_TRADING ?? bybit.demoTrading ?? 'false').toLowerCase() === 'true';

  if (!apiKey || !apiSecret) throw new Error('Missing Bybit api_key/api_secret in ~/.openclaw/credentials.json (bybit.*) or env');
  return { apiKey, apiSecret, testnet, demoTrading };
}

const CATEGORY = 'linear';

async function main() {
  const { apiKey, apiSecret, testnet, demoTrading } = loadCredentials();
  const client = new RestClientV5({ key: apiKey, secret: apiSecret, testnet, demoTrading });

  const [pos, bal] = await Promise.all([
    client.getPositionInfo({ category: CATEGORY }),
    client.getWalletBalance({ accountType: 'UNIFIED' }),
  ]);

  const positions = (pos?.result?.list || []).filter(p => Number(p.size) !== 0);

  const coins = bal?.result?.list?.[0]?.coin || [];
  const usdt = coins.find(c => c.coin === 'USDT') || null;

  const out = {
    timestamp: new Date().toISOString(),
    positions: positions.map(p => ({
      symbol: p.symbol,
      side: p.side,
      size: Number(p.size),
      entryPrice: Number(p.avgPrice || p.entryPrice || 0),
      markPrice: Number(p.markPrice || 0),
      leverage: Number(p.leverage || 0),
      unrealisedPnl: Number(p.unrealisedPnl || 0),
      stopLoss: p.stopLoss ? Number(p.stopLoss) : null,
      takeProfit: p.takeProfit ? Number(p.takeProfit) : null,
    })),
    usdt: usdt ? {
      equity: Number(usdt.equity || 0),
      walletBalance: Number(usdt.walletBalance || 0),
      availableToWithdraw: Number(usdt.availableToWithdraw || usdt.availableBalance || 0),
      unrealisedPnl: Number(usdt.unrealisedPnl || 0),
    } : null,
  };

  console.log(JSON.stringify(out, null, 2));
}

main().catch(e => {
  console.error(String(e?.stack || e));
  process.exit(1);
});
