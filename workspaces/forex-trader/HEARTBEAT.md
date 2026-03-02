# HEARTBEAT.md — Forex Trader

## Activation

Heartbeat **DISABLED by default** (no config = $0 cost).
`trading_control.sh start` injects heartbeat: **every 1h**.
`trading_control.sh stop` removes it → $0.

## TOKEN ECONOMY (HARD LIMIT)

**MAX 3 tool calls per heartbeat. After 3 → STOP. No exceptions.**

The check script collects ALL data. You DO NOT need to gather anything yourself.

## Guard Rails (DYNAMIC)

Parameters from `scripts/data/trading_params.json`. **Always use values from TRADING PARAMS section** in check script output.

Defaults (if params missing):

| Parameter | Default |
| --------- | ------- |
| daily_target | $100 |
| max_daily_loss | $50 |
| max_stops_day | 2 |
| max_sl_per_trade | $300 |
| budget | $10,000 |
| max_positions | 3 |
| risk_percent | 1-3% |
| min_rr | 1:2 |

> Weekend = OFF is hardcoded in check script.

## Heartbeat Algorithm (EXACTLY 3 calls)

### Call 1: Run Check Script

```bash
bash /root/Projects/openclaw-assistent/scripts/forex_check.sh
```

This ONE script gives you EVERYTHING: weekend/session check, account, positions, drawdown,
FTMO alerts, full market analysis (H4+M15 signals), market digest (news+calendar), tasks.

**If `WEEKEND_CLOSED` → STOP. Zero cost. No more calls.**
**If `Off-hours` → monitor only, no new entries.**

### Call 2: Execute (if signals exist)

Review signals from check script output. Read TRADING PARAMS (use those values, not defaults).

**Decision matrix:**

| State | Action |
| ----- | ------ |
| Weekend | STOP immediately |
| Off-session hours | Monitor only, no new entries |
| Daily loss limit hit | NO new trades |
| Strong signal in output | Execute: `npx tsx src/trading/forex/monitor.ts --trade --pair=SYMBOL` |
| Weak/no signal but 0 positions + 0 orders | Place conservative limit order at best S/R |
| Positions exist, no signal | Skip (monitor manages SL/TP automatically) |
| Friday after 17:00 Kyiv | Close all positions before 19:00 |

Pairs: EUR/USD, GBP/USD, USD/JPY, AUD/USD. Strategy: Smart Money (BOS, CHoCH, FVG, OB, S&D).

### Call 3: Telegram Report (IN RUSSIAN)

```
📊 Forex [HH:MM]
📈 Позиций: N | Лимиток: M | P&L: +$XX
📋 Действия: [что сделал]
💬 Оценка: [тренд, сессия, план]
```

**Then STOP. Do not make more calls.**

## MANDATORY MARKET PRESENCE

- **0 positions + 0 orders = FORBIDDEN** (during active sessions).
- Closed a position/order → replace with new limit order.
- Exception: daily loss limit, weekend, or off-session hours.

## Session Rules

| Session | Hours (UTC+3 Kyiv) | Priority |
| ------- | ------------------ | -------- |
| London | 09:00 - 17:00 | HIGH |
| New York | 16:00 - 00:00 | HIGH |
| Asian | 02:00 - 09:00 | LOW |
| Outside | — | SKIP |

## Quick Reference

```bash
# All-in-one check (Call 1)
bash /root/Projects/openclaw-assistent/scripts/forex_check.sh

# Execute pair (Call 2)
cd /root/Projects/openclaw-assistent && npx tsx src/trading/forex/monitor.ts --trade --pair=EURUSD

# Manual order
cd /root/Projects/openclaw-assistent && npx tsx src/trading/forex/trade.ts --action open \
  --pair EURUSD --side BUY --lots 0.1 --sl-pips 50 --tp-pips 100
```

> ⚠️ FORBIDDEN: creating tasks. Only Orchestrator creates tasks.
> ⚠️ YOU own your task statuses — change them yourself (todo → in_progress → done)
