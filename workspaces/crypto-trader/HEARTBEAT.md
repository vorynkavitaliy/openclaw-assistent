# HEARTBEAT.md — Crypto Trader Autonomous Mode

## Schedule

| Task                | Interval     | Description                                        |
| ------------------- | ------------ | -------------------------------------------------- |
| Market monitoring   | Every 10 min | Pair analysis, position management, open/close      |
| User report         | Every 2 hrs  | Via orchestrator: balance, positions, P&L, market   |

## Heartbeat prompt (every 10 min)

On each heartbeat you MUST:

1. **Check open positions**: P&L, SL/TP, margin ratio, funding rate
2. **Check drawdown**: daily <4%, total <8% (HyroTrade buffer)
3. **Analyze pairs** (BTC, ETH, SOL, ARB, OP, LINK, AVAX): 4h trend → 15m entry → Smart Money signals
4. **If signal found** → open trade automatically (without waiting for user)
5. **Log actions** as comments to active task in Task Board

> ⚠️ You work AUTONOMOUSLY. Don't wait for approval. Analyze → decide → execute.
> HyroTrade rules: `skills/crypto-trading/HYROTRADE_RULES.md`

## Management

```bash
# Auto-trading status
npx tsx src/trading/crypto/killswitch.ts

# Emergency stop (kill-switch)
npx tsx src/trading/crypto/killswitch.ts --on --reason="reason"

# Kill + close all positions
npx tsx src/trading/crypto/killswitch.ts --close-all

# Resume trading
npx tsx src/trading/crypto/killswitch.ts --off

# Manual monitoring launch
npx tsx src/trading/crypto/monitor.ts
npx tsx src/trading/crypto/monitor.ts --dry-run    # no trades
npx tsx src/trading/crypto/monitor.ts --pair=BTCUSDT  # single pair

# Manual report
npx tsx src/trading/crypto/report.ts
npx tsx src/trading/crypto/report.ts --format=json
```

## Guard Rails

| Parameter          | Value | Description                   |
| ------------------ | ----- | ----------------------------- |
| Max daily loss     | $500  | On reach → stop-day           |
| Max stops/day      | 2     | On reach → stop-day           |
| Max risk/trade     | $250  | No more than 50% daily limit  |
| Max positions      | 3     | Simultaneously open           |
| Risk per trade     | 2%    | Of deposit                    |
| Max leverage       | 5x    | Default 3x                    |
| Min R:R            | 1:2   | Don't enter below             |

## Mode

Current mode is set in `~/.openclaw/openclaw.json` (`crypto.mode` section):
- `execute` — full auto-trading (FULL-AUTO)
- `dry-run` — analysis only, no trade execution
