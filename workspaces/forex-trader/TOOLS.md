# TOOLS.md — Forex Trader Environment

## Architecture (cTrader Open API)

```
cTrader Open API (Spotware)
    ↕
ctrader-ts SDK (TypeScript)
    ↕
TypeScript modules (src/trading/forex/)
├── client.ts    — cTrader API client: connection, data, trading
├── monitor.ts   — monitoring: heartbeat, positions, risk-check, trade
├── trade.ts     — CLI for orders: open, close, modify, status
└── config.ts    — config from ~/.openclaw/openclaw.json
    ↕
OpenClaw Forex Trader Agent
    ↕
Orchestrator → Telegram
```

### cTrader Credentials

- **File**: `~/.openclaw/openclaw.json` → `forex` section
- **Authentication**: `npx ctrader-ts auth` (one-time, OAuth2)
- **Broker**: FTMO (prop trading firm)

---

## TypeScript CLI — Monitoring

### Heartbeat (primary)

```bash
# Full heartbeat — account, positions, drawdown, FTMO alerts
npx tsx src/trading/forex/monitor.ts --heartbeat

# Positions only
npx tsx src/trading/forex/monitor.ts --positions

# Account only
npx tsx src/trading/forex/monitor.ts --account

# Risk check (FTMO max daily/total drawdown)
npx tsx src/trading/forex/monitor.ts --risk-check
```

### Trading (analysis + execution)

```bash
# Analysis + trading all pairs (dry-run — no execution)
npx tsx src/trading/forex/monitor.ts --trade --dry-run

# Analysis + trading single pair (dry-run)
npx tsx src/trading/forex/monitor.ts --trade --pair=EURUSD --dry-run

# Live mode — analysis + automatic execution
npx tsx src/trading/forex/monitor.ts --trade

# Live mode — single pair
npx tsx src/trading/forex/monitor.ts --trade --pair=EURUSD
```

Monitor in `--trade` mode automatically:

1. Manages open positions (partial close +1R, trailing SL +1.5R, BE)
2. Scans all pairs for entry signals (4h trend + M15 RSI)
3. Executes signals (if not dry-run)

---

## TypeScript CLI — Orders (trade.ts)

### Open Position

```bash
npx tsx src/trading/forex/trade.ts --action open \
  --pair EURUSD --side BUY --lots 0.1 \
  --sl-pips 50 --tp-pips 100
```

Required: `--pair`, `--side` (BUY/SELL), `--sl-pips` (risk management).
Optional: `--lots` (default 0.01), `--tp-pips`.

### Close Position

```bash
# Full close
npx tsx src/trading/forex/trade.ts --action close --position-id 12345678

# Partial close (50% at +1R)
npx tsx src/trading/forex/trade.ts --action close --position-id 12345678 --lots 0.05
```

### Modify SL/TP

```bash
npx tsx src/trading/forex/trade.ts --action modify --position-id 12345678 \
  --sl-pips 30 --tp-pips 100
```

### Close All Positions (emergency)

```bash
npx tsx src/trading/forex/trade.ts --action close-all
```

### Account Status

```bash
npx tsx src/trading/forex/trade.ts --action status
```

All commands return JSON.

---

## Market Digest (macro + news)

```bash
# Full digest (48 hours)
npx tsx src/market/digest.ts

# Digest for 24 hours
npx tsx src/market/digest.ts --hours=24 --max-news=10
```

Parses: ForexFactory Calendar XML + CoinDesk/Cointelegraph RSS.

---

## Economic Calendar

- **Primary source**: Market Analyst agent (via sessions_send + Task Board)
- ForexFactory: https://www.forexfactory.com/calendar
- Investing.com: https://www.investing.com/economic-calendar/

## Visual Tools (Browser)

- **TradingView**: https://www.tradingview.com/chart/
- **MT5 WebTerminal**: https://mt5-3.ftmo.com/ (visual analysis only)

## Trading Hours (Kyiv time, Europe/Kyiv)

- London: 09:00-17:00
- New York: 16:00-00:00
- Overlap: 16:00-17:00 (best trading time)
- DON'T trade: 01:00-08:00 (Asia, except JPY pairs)

## Timeframes (MANDATORY RULE)

```
H4  → Determine direction (trend, support/resistance zones)
H1  → Identify key levels and demand/supply zones
M15 → FIND ENTRY POINT (BOS, CHoCH, Order Block, FVG)
M5  → FINE-TUNE ENTRY (pattern confirmation, minimal SL)
```
