# TOOLS.md — Crypto Trader Environment

## Architecture

```
Bybit REST API v5
    ↕
Node.js SDK (bybit-api) — with Demo Trading support
    ↕
TypeScript modules (src/trading/crypto/)
├── bybit-client.ts — API wrapper: trading, data, monitoring
├── monitor.ts      — autonomous monitoring + analysis + execution
├── killswitch.ts   — emergency stop + close all positions
├── report.ts       — hourly reports Telegram + JSON
├── state.ts        — persistent state: balance, limits, events
└── config.ts       — config from ~/.openclaw/openclaw.json
    ↕
OpenClaw Crypto Trader Agent
    ↕
Orchestrator → Telegram
```

## Bybit API v5

### Endpoints

- **Mainnet**: https://api.bybit.com
- **Testnet**: https://api-testnet.bybit.com
- **Demo Trading**: mainnet + flag `demoTrading: true` in SDK
- **Docs**: https://bybit-exchange.github.io/docs/v5/intro

### Credentials

- **File**: `~/.openclaw/openclaw.json` → `crypto` section
- **Account type**: Unified Trading Account (UTA)
- **Trade type**: USDT-M Linear Perpetual
- **Demo Trading**: keys from Bybit demo account (work only via Node SDK with `demoTrading: true`)

> ⚠️ Demo Trading keys DO NOT work with regular REST API. Only via Node SDK `bybit-api` with `demoTrading: true`.

---

## TypeScript CLI — Monitoring and Trading

### Monitoring (primary tool)

```bash
# Full monitoring of all pairs (dry-run — no execution)
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/monitor.ts --dry-run

# Monitor single pair (dry-run)
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/monitor.ts --pair=BTCUSDT --dry-run

# Live mode — analysis + automatic execution
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/monitor.ts

# Live mode — single pair
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/monitor.ts --pair=BTCUSDT
```

Monitor automatically:

1. Checks kill-switch and stop-day
2. Updates balance and positions
3. Manages open positions (partial close +1R, trailing SL +1.5R, BE)
4. Performs multi-timeframe analysis (4h + 15m)
5. Executes signals (if not dry-run)

### Kill Switch (emergency stop)

```bash
# Status (kill-switch, stop-day, mode, balance, positions)
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/killswitch.ts

# Enable kill-switch (stop trading)
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/killswitch.ts --on --reason="manual stop"

# Close ALL positions + enable kill-switch
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/killswitch.ts --close-all

# Disable kill-switch (resume trading)
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/killswitch.ts --off
```

### Report (Telegram + JSON)

```bash
# Hourly report (sent to Telegram via Gateway)
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/report.ts

# Report in JSON format (stdout)
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/report.ts --format=json
```

Contains: balance, positions, daily stats, market data for BTC/ETH/SOL.

---

## API Functions (bybit-client.ts)

Available as library for other modules:

| Function                                      | Description                             |
| --------------------------------------------- | --------------------------------------- |
| `getKlines(symbol, interval, limit)`          | OHLC candles                            |
| `getMarketInfo(symbol)`                       | Ticker, funding rate, OI, funding signal|
| `getMarketAnalysis(symbol, tf, bars)`         | OHLC + EMA/RSI/ATR + trend bias        |
| `getBalance(coin?)`                           | Balance (UNIFIED account)               |
| `getPositions(symbol?)`                       | Open positions                          |
| `submitOrder({symbol, side, type, qty, ...})` | Create order with SL/TP                 |
| `closePosition(symbol)`                       | Close position                          |
| `partialClosePosition(symbol, qty)`           | Partial close                           |
| `modifyPosition(symbol, sl?, tp?)`            | Modify SL/TP                            |
| `closeAllPositions()`                         | Close all USDT positions                |
| `setLeverage(symbol, leverage)`               | Set leverage (max 5x)                   |

---

## Additional APIs

### CoinGecko (free)

```bash
# Prices
curl -s "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true"

# Bitcoin Dominance
curl -s "https://api.coingecko.com/api/v3/global" | jq '.data.market_cap_percentage.btc'
```

### Fear & Greed Index

```bash
curl -s "https://api.alternative.me/fng/?limit=1" | jq '.data[0]'
```

### Market Digest (macro + news)

```bash
cd /root/Projects/openclaw-assistent && npx tsx src/market/digest.ts --hours=24 --max-news=10
```

---

## Visual Tools (Browser)

- **TradingView**: https://www.tradingview.com/chart/
- **CoinMarketCap**: https://coinmarketcap.com/
- **DeFi Llama**: https://defillama.com/
- **Coinglass**: https://www.coinglass.com/ — funding, OI, liquidations

## Timeframes (MANDATORY RULE)

```
4h  → Determine direction (trend, support/resistance zones)
1h  → Identify key levels and demand/supply zones
15m → FIND ENTRY POINT (BOS, CHoCH, Order Block, FVG)
5m  → FINE-TUNE ENTRY (pattern confirmation, minimal SL)
```

## Leverage

- Default: 3x
- Maximum: 5x
- **NEVER** more than 5x — liquidation = total loss
