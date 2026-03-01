```skill
---
name: crypto-trading
description: 'Cryptocurrency market analysis and trading tools. Fetch prices, on-chain data, manage positions via exchange APIs.'
metadata: { 'openclaw': { 'emoji': '🪙', 'requires': { 'bins': ['curl', 'jq'] } } }
user-invocable: true
---

# Crypto Trading Skill

Tools for cryptocurrency analysis and trading.

## Fetching Market Data

### Current Prices (CoinGecko, free)

```bash
# Major coins
curl -s "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true" | jq '.'

# Top 10 by market cap
curl -s "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=10&page=1" | jq '.[] | {symbol, current_price, price_change_percentage_24h, market_cap}'
```

### Bybit API v5

```bash
# Current price
curl -s "https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT" | jq '.result.list[0] | {symbol, lastPrice, price24hPcnt, volume24h, turnover24h}'

# Order book
curl -s "https://api.bybit.com/v5/market/orderbook?category=linear&symbol=BTCUSDT&limit=5" | jq '.result'

# Klines (candles) — 1h, last 24
curl -s "https://api.bybit.com/v5/market/kline?category=linear&symbol=BTCUSDT&interval=60&limit=24" | jq '.result.list[] | {open: .[1], high: .[2], low: .[3], close: .[4], volume: .[5]}'
```

> For trading operations use TypeScript modules (bybit-client.ts) — not curl.
> Docs: https://bybit-exchange.github.io/docs/v5/intro

### Fear & Greed Index

```bash
curl -s "https://api.alternative.me/fng/?limit=1" | jq '.data[0] | {value, value_classification}'
```

### Bitcoin Dominance

```bash
curl -s "https://api.coingecko.com/api/v3/global" | jq '.data.market_cap_percentage.btc'
```

## On-Chain Analysis (via browser)

- **Glassnode**: https://studio.glassnode.com/
- **Dune Analytics**: https://dune.com/
- **DeFiLlama**: https://defillama.com/
- **Etherscan**: https://etherscan.io/
- **Whale Alert**: https://whale-alert.io/

## Trading via TypeScript Modules (Bybit)

All trading operations are executed via TypeScript CLI:

```bash
# Monitoring (analysis + trading, dry-run)
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/monitor.ts --dry-run

# Live mode
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/monitor.ts

# Kill Switch (emergency stop)
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/killswitch.ts --close-all

# Report
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/report.ts
```

### Credentials

- **File**: `~/.openclaw/openclaw.json` → `crypto` section
- **SDK**: `bybit-api` (Node.js) with `demoTrading: true` for Demo Trading
- **Type**: Unified Trading Account (UTA), USDT-M Linear Perpetual

> ⚠️ Demo Trading keys work ONLY via Node SDK with `demoTrading: true`, not via REST API.

## Portfolio Monitoring

### Position Format

```
🪙 BTC/USDT
   Quantity: 0.5 BTC
   Avg Price: $95,000
   Current Price: $98,500
   P&L: +$1,750 (+3.7%)
   SL: $93,000 (-2.1%)
   TP: $105,000 (+10.5%)
```

## Alerts

Create alerts via cron:

```bash
# Check every 5 minutes
# If BTC > 100000, send alert via sessions_send orchestrator
```

## Trade Journal

```bash
bash {baseDir}/../taskboard/scripts/taskboard.sh create \
  --title "BTC LONG 0.1 @ $98,500" \
  --description "SL: $96,000, TP: $105,000. Breakout above $98K resistance. RSI: 65. F&G: 72 (Greed)" \
  --type "task" \
  --assignee "crypto-trader" \
  --priority "high" \
  --labels "crypto,trade,btc"
```
