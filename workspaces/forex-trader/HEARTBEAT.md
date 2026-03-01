# HEARTBEAT.md — Forex Trader

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
| min_rr           | 1:2     | Don't enter below                 |

> Weekend = OFF is hardcoded in check script (not a param).

## Token Economy

- **MAX 3 tool calls per heartbeat cycle.** This is a HARD LIMIT.
- Sessions are compacted after each cycle — you lose memory. All data comes from check script.
- DO NOT read workspace files — everything you need is in system prompt and script output.

## Heartbeat Algorithm (every 1h)

### Call 1: Run Check Script

```bash
bash /root/Projects/openclaw-assistent/scripts/forex_check.sh
```

This ONE script does everything:

- Weekend check (exits if Sat/Sun)
- Trading session detection (London/NY hours)
- Runs monitor.ts --heartbeat (positions, P&L, account)
- Lists pending tasks

**If output says `WEEKEND_CLOSED` → STOP IMMEDIATELY. Zero cost. No more calls.**

### Call 2: Analyze + Act (LIMIT ORDERS strategy)

Read TRADING PARAMS from script output. Use those values (not hardcoded defaults).

**CORE STRATEGY: Place limit orders at key levels.**
Since heartbeat is every 1h, you CANNOT rely on market entries. Instead:

1. Identify key support/resistance, FVG, Order Blocks on H4 → M15
2. Place **limit orders** (buy limit / sell limit) at those levels with SL/TP
3. Orders work while you sleep between heartbeats

**Each heartbeat cycle:**

**IF existing limit orders → REVIEW:**

- Check if any orders filled → became positions
- Adjust unfilled orders if levels shifted (cancel + re-place)
- Leave valid orders as-is

**IF no positions and no pending orders → ANALYZE + PLACE:**

- Analyze top pairs (EUR/USD, GBP/USD, USD/JPY, AUD/USD): H4 trend → M15 entry levels
- Smart Money: BOS, CHoCH, FVG, Order Blocks, S&D zones
- Place limit orders at key levels with SL ≤ max_sl_per_trade, TP per min_rr
- Goal: always have 1-3 pending limit orders in the market

**IF positions exist → MANAGE:**

- Check P&L vs daily_target and max_daily_loss from params
- Partial close at +1R, trailing at +1.5R
- If daily loss ≥ max_daily_loss or max_stops_day hit → CANCEL all pending orders, NO NEW TRADES

**Handle tasks** from check script output (todo → in_progress → done)

### Call 3: Telegram Report (MANDATORY)

Send to Telegram **IN RUSSIAN**:

```
📊 Forex [HH:MM]
📈 Позиций: N | Лимиток: M | P&L: +$XX
📋 Действия: [выставил/скорректировал/убрал лимитки | закрыл/без действий]
💬 Оценка: [1 строка — тренд, сессия, план]
```

Then STOP. Do not make more calls.

## Session Rules

| Session          | Hours (UTC+3 Kyiv) | Priority |
| ---------------- | ------------------ | -------- |
| London           | 09:00 - 17:00      | HIGH     |
| New York         | 16:00 - 00:00      | HIGH     |
| Asian            | 02:00 - 09:00      | LOW      |
| Outside sessions | —                  | SKIP     |

Outside active sessions: monitor only, no new entries.

## Management Commands

```bash
# All-in-one check (used by heartbeat)
bash /root/Projects/openclaw-assistent/scripts/forex_check.sh

# Direct monitoring
cd /root/Projects/openclaw-assistent && npx tsx src/trading/forex/monitor.ts --heartbeat

# Live trading
cd /root/Projects/openclaw-assistent && npx tsx src/trading/forex/monitor.ts --trade

# Risk check
cd /root/Projects/openclaw-assistent && npx tsx src/trading/forex/monitor.ts --risk-check
```

> ⚠️ FORBIDDEN: creating tasks. Only Orchestrator creates tasks.
> ⚠️ YOU own your task statuses — change them yourself (todo → in_progress → done)
