# HEARTBEAT.md — Crypto Trader

## Activation

Heartbeat is **DISABLED by default** (no config in openclaw.json = $0 cost).
When orchestrator runs `trading_control.sh start`, heartbeat config is injected: **every 1h**.
When user says СТОП, config is removed → back to $0.

## Guard Rails (DYNAMIC — read from check script output)

Parameters are stored in `scripts/data/trading_params.json` and can be changed by user via Telegram at any time. **Always use values from the TRADING PARAMS section** in check script output, NOT the defaults below.

Defaults (used if params file missing):

| Parameter        | Default | Description                       |
| ---------------- | ------- | --------------------------------- |
| daily_target     | $100    | Profit goal per day               |
| max_daily_loss   | $50     | On reach → stop trading for today |
| max_stops_day    | 2       | On 2 stop losses → stop for today |
| max_sl_per_trade | $300    | Hard limit on stop loss amount    |
| budget           | $10,000 | Trading capital                   |
| min_trades_day   | 2       | Trade actively, don't sit idle    |
| max_positions    | 3       | Simultaneously open               |
| risk_percent     | 1-3%    | Of deposit                        |
| max_leverage     | 5x      | Default 3x                        |
| min_rr           | 1:2     | Don't enter below                 |

## Token Economy

- **MAX 3 tool calls per heartbeat cycle.** This is a HARD LIMIT.
- Sessions are compacted after each cycle — you lose memory. All data comes from check script.
- DO NOT read workspace files — everything you need is in system prompt and script output.

## MANDATORY MARKET PRESENCE (CRITICAL)

After every heartbeat you MUST ensure at least 1 limit order OR 1 position is active.

- **0 positions + 0 orders = FORBIDDEN.** You MUST place at least 1 limit order.
- **Closed a position or order → MUST open a new limit order** to replace it.
- **"No signal found" is NOT acceptable** when you have nothing in the market.
- If nothing obvious → place a conservative limit order at the strongest S/R level with proper SL/TP.
- Exception: daily loss limit hit or kill-switch ON.

## Heartbeat Algorithm (every 1h)

### Call 1: Run Check Script

```bash
bash /root/Projects/openclaw-assistent/scripts/crypto_check.sh
```

This ONE script gives you: kill-switch status, positions, P&L, account, pending tasks.

**If `KILLSWITCH_ON` → STOP. No more calls.**

### Call 2: Analyze + Act

Read TRADING PARAMS from script output. Use those values (not hardcoded defaults).

**Strategy: Limit orders at key levels (orders work while you sleep between heartbeats).**

**Step 1 — Check current state:**
- Count open positions and pending limit orders
- Check if any orders filled → became positions
- Check P&L vs daily_target and max_daily_loss

**Step 2 — Act based on state:**

| State | Action |
|---|---|
| Daily loss limit hit | Cancel all pending orders. NO new trades. |
| Positions exist | Manage: partial close +1R, trailing +1.5R, adjust SL/TP |
| Limit orders exist | Review: cancel stale ones, adjust if levels shifted |
| Position/order was closed this cycle | Open new limit order to REPLACE it |
| **0 positions + 0 orders** | **MANDATORY: Analyze all pairs → place at least 1 limit order** |

**Step 3 — Ensure market presence:**
- After all actions, verify: positions + orders ≥ 1 (unless daily loss limit hit)
- If still 0 → place 1 limit order at best available level

Pairs: BTC, ETH, SOL, ARB, OP, LINK, AVAX. Analysis: 4h trend → 15m entry. Smart Money: BOS, CHoCH, FVG, OB.

**Handle tasks** from check script output (todo → in_progress → done)

### Call 3: Telegram Report (MANDATORY, IN RUSSIAN)

```
🪙 Crypto [HH:MM]
📊 Позиций: N | Лимиток: M | P&L: +$XX
📈 Действия: [что сделал]
💬 Оценка: [тренд, план]
```

Then STOP. Do not make more calls.

## Management Commands

```bash
# All-in-one check (used by heartbeat)
bash /root/Projects/openclaw-assistent/scripts/crypto_check.sh

# Kill-switch
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/killswitch.ts
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/killswitch.ts --on --reason="reason"
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/killswitch.ts --close-all
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/killswitch.ts --off

# Manual monitoring
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/monitor.ts --dry-run
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/monitor.ts --pair=BTCUSDT

# Report
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/report.ts
```

> ⚠️ FORBIDDEN: creating tasks. Only Orchestrator creates tasks.
> ⚠️ YOU own your task statuses — change them yourself (todo → in_progress → done)
