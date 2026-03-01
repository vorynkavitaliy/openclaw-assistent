```skill
---
name: ctrader-typescript
description: cTrader Open API integration for forex trading via TypeScript
user-invocable: false
requires:
  bins: [npx]
---

# Skill: cTrader Open API Integration (TypeScript)

## Description

Integration with cTrader via Open API (Spotware) for programmatic forex trade management. Used by the forex-trader agent as the primary order execution method. Fully in TypeScript via `ctrader-ts` SDK.

## Dependencies

- Node.js 20+
- `ctrader-ts` SDK (installed in package.json)
- Authentication: `npx ctrader-ts auth` (one-time, OAuth2)

## Modules

```
src/trading/forex/
├── client.ts   — cTrader API client: connection, data, trading
├── monitor.ts  — monitoring: heartbeat, positions, risk-check, trade
├── trade.ts    — CLI for orders: open, close, modify, status
└── config.ts   — configuration from ~/.openclaw/openclaw.json
```

## CLI Reference

### Monitoring (monitor.ts)

```bash
# Heartbeat — account, positions, drawdown, FTMO alerts
cd /root/Projects/openclaw-assistent && npx tsx src/trading/forex/monitor.ts --heartbeat

# Positions only
cd /root/Projects/openclaw-assistent && npx tsx src/trading/forex/monitor.ts --positions

# Account only
cd /root/Projects/openclaw-assistent && npx tsx src/trading/forex/monitor.ts --account

# Risk check (FTMO drawdown)
cd /root/Projects/openclaw-assistent && npx tsx src/trading/forex/monitor.ts --risk-check

# Analysis + trading (dry-run)
cd /root/Projects/openclaw-assistent && npx tsx src/trading/forex/monitor.ts --trade --dry-run

# Analysis + trading (live mode)
cd /root/Projects/openclaw-assistent && npx tsx src/trading/forex/monitor.ts --trade

# Single pair
cd /root/Projects/openclaw-assistent && npx tsx src/trading/forex/monitor.ts --trade --pair=EURUSD --dry-run
```

### Trading (trade.ts)

```bash
# Open position
cd /root/Projects/openclaw-assistent && npx tsx src/trading/forex/trade.ts --action open \
  --pair EURUSD --side BUY --lots 0.1 \
  --sl-pips 50 --tp-pips 100

# Close position
cd /root/Projects/openclaw-assistent && npx tsx src/trading/forex/trade.ts --action close --position-id 12345678

# Partial close
cd /root/Projects/openclaw-assistent && npx tsx src/trading/forex/trade.ts --action close --position-id 12345678 --lots 0.05

# Modify SL/TP
cd /root/Projects/openclaw-assistent && npx tsx src/trading/forex/trade.ts --action modify --position-id 12345678 \
  --sl-pips 30 --tp-pips 100

# Close all
cd /root/Projects/openclaw-assistent && npx tsx src/trading/forex/trade.ts --action close-all

# Account status
cd /root/Projects/openclaw-assistent && npx tsx src/trading/forex/trade.ts --action status
```

All commands return JSON.

## API Client (client.ts)

Library for use by other modules:

| Function                               | Description                      |
| -------------------------------------- | -------------------------------- |
| `connect()`                            | Connect to cTrader API           |
| `disconnect()`                         | Disconnect                       |
| `getAccountInfo()`                     | Balance, equity, margin          |
| `getPositions()`                       | Open positions                   |
| `openPosition(params)`                 | Open order (Market/Limit)        |
| `closePosition(positionId, volume?)`   | Close (full or partial)          |
| `modifyPosition(positionId, sl?, tp?)` | Modify SL/TP                     |
| `closeAllPositions()`                  | Close all positions              |
| `getTrendbars(symbol, period, count)`  | OHLC data                        |

## Configuration

Credentials in `~/.openclaw/openclaw.json`:

```json5
{
  forex: {
    mode: 'simulate', // "simulate" | "execute"
    pairs: ['EURUSD', 'GBPUSD', 'USDJPY'],
    riskPerTrade: 0.02,
    maxDailyDrawdown: 0.05,
    maxTotalDrawdown: 0.1,
  },
}
```

## Security

- OAuth2 tokens via `npx ctrader-ts auth`
- Credentials in `~/.openclaw/openclaw.json` — DO NOT commit
- Log only in safe format: `531…488`
