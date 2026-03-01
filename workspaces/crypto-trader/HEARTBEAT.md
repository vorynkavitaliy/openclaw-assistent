# HEARTBEAT.md — Crypto Trader

## Activation

Heartbeat is **DISABLED by default** (no config in openclaw.json = $0 cost).
When orchestrator runs `trading_control.sh start`, heartbeat config is injected: **every 1h**.
When user says СТОП, config is removed → back to $0.

## Guard Rails

| Parameter        | Value   | Description                       |
| ---------------- | ------- | --------------------------------- |
| Daily target     | $100    | Profit goal per day               |
| Max daily loss   | $50     | On reach → stop trading for today |
| Max stops/day    | 2       | On 2 stop losses → stop for today |
| Max SL per trade | $300    | Hard limit on stop loss amount    |
| Budget           | $10,000 | Trading capital                   |
| Min trades/day   | 2       | Trade actively, don't sit idle    |
| Max positions    | 3       | Simultaneously open               |
| Risk per trade   | 1-3%    | Of deposit                        |
| Max leverage     | 5x      | Default 3x                        |
| Min R:R          | 1:2     | Don't enter below                 |

## Token Economy

- **MAX 3 tool calls per heartbeat cycle.** This is a HARD LIMIT.
- Sessions are compacted after each cycle — you lose memory. All data comes from check script.
- DO NOT read workspace files — everything you need is in system prompt and script output.

## Heartbeat Algorithm (every 1h)

### Call 1: Run Check Script

```bash
bash /root/Projects/openclaw-assistent/scripts/crypto_check.sh
```

This ONE script does everything:

- Kill-switch check (exits if ON)
- Runs monitor.ts --dry-run (positions, P&L, account)
- Lists pending tasks

**If output says `KILLSWITCH_ON` → STOP IMMEDIATELY. No more calls.**

### Call 2: Analyze + Act

Based on script output:

**IF no positions or <2 trades today → LOOK FOR ENTRIES:**

- Analyze top pairs (BTC, ETH, SOL, ARB, OP, LINK, AVAX): 4h trend → 15m entry
- Smart Money: BOS, CHoCH, FVG, Order Blocks
- Check funding rates, OI divergence
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
🪙 Crypto [HH:MM]
📊 Позиций: N | P&L: +$XX
📈 Действия: [открыл/закрыл/без действий]
💬 Оценка: [1 строка — тренд, волатильность, план]
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
