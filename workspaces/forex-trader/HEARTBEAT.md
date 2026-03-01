# HEARTBEAT.md — Forex Trader

## Activation

Heartbeat is **DISABLED by default** (no config in openclaw.json = $0 cost).
When orchestrator runs `trading_control.sh start`, heartbeat config is injected: **every 1h**.
When user says СТОП, config is removed → back to $0.

## Guard Rails

| Parameter        | Value   | Description                           |
| ---------------- | ------- | ------------------------------------- |
| Daily target     | $100    | Profit goal per day                   |
| Max daily loss   | $50     | On reach → stop trading for today     |
| Max stops/day    | 2       | On 2 stop losses → stop for today     |
| Max SL per trade | $300    | Hard limit on stop loss amount        |
| Budget           | $10,000 | Trading capital                       |
| Min trades/day   | 2       | Trade actively, don't sit idle        |
| Max positions    | 3       | Simultaneously open                   |
| Risk per trade   | 1-3%    | Of deposit                            |
| Min R:R          | 1:2     | Don't enter below                     |
| Weekend          | OFF     | Sat-Sun = zero cost, exit immediately |

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

### Call 2: Analyze + Act

Based on script output:

**IF no positions or <2 trades today → LOOK FOR ENTRIES:**

- Analyze top pairs (EUR/USD, GBP/USD, USD/JPY, AUD/USD): H4 trend → M15 entry
- Smart Money: BOS, CHoCH, FVG, Order Blocks
- If signal → execute trade (check guard rails first!)
- If no signal → note it in report

**IF positions exist → MANAGE:**

- Check P&L vs daily target ($100) and drawdown ($50)
- Partial close at +1R, trailing at +1.5R
- If daily loss ≥$50 or 2 stops hit → NO NEW TRADES

**Handle tasks** from check script output (todo → in_progress → done)

### Call 3: Telegram Report (MANDATORY)

Send to Telegram **IN RUSSIAN**:

```
📊 Forex [HH:MM]
📈 Позиций: N | P&L: +$XX
📋 Действия: [открыл/закрыл/без действий]
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
