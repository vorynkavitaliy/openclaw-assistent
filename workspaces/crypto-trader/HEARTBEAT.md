# HEARTBEAT.md — Crypto Trader

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

| Parameter        | Default |
| ---------------- | ------- |
| daily_target     | $100    |
| max_daily_loss   | $50     |
| max_stops_day    | 2       |
| max_sl_per_trade | $300    |
| budget           | $10,000 |
| max_positions    | 3       |
| risk_percent     | 1-3%    |
| max_leverage     | 5x      |
| min_rr           | 1:2     |

## Heartbeat Algorithm (EXACTLY 3 calls)

### Call 1: Run Check Script

```bash
bash /root/Projects/openclaw-assistent/scripts/crypto_check.sh
```

This ONE script gives you EVERYTHING: kill-switch, balance, positions,
**raw market data** (H4+M15 EMA/RSI/ATR/bias, funding, OI, volume for all pairs),
Fear & Greed, BTC dominance, pending tasks, recent events.

**If KILLSWITCH_ON → STOP. Send telegram "kill-switch active". No more calls.**

### Call 2: Analyze & Execute

Study the raw market data. **YOU are the analyst.** Form your own trading thesis:

1. **Filter pairs** — look for strong bias (trend alignment H4→M15), extreme RSI, favorable funding
2. **Find setups** — Smart Money concepts: BOS, CHoCH, FVG, OB, S/R levels
3. **Check risk** — respect TRADING PARAMS (budget, max_positions, risk_percent, min_rr)
4. **Execute or hold** — only trade setups YOU believe in, with proper SL/TP

**Decision matrix:**

| State                                     | Action                                                  |
| ----------------------------------------- | ------------------------------------------------------- |
| Kill-switch ON                            | STOP immediately                                        |
| Daily loss limit hit                      | NO new trades                                           |
| Strong setup found (your analysis)        | Execute via `trade.ts --action open`                    |
| No clear setup but 0 positions + 0 orders | Place conservative limit order at best S/R              |
| Positions exist, no new setup             | Monitor existing (SL/TP already set)                    |

**Execute:**
```bash
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/trade.ts \
  --action open --pair BTCUSDT --side BUY --qty 0.001 --sl 95000 --tp 105000 --leverage 3
```

Pairs: BTC, ETH, SOL, ARB, OP, LINK, AVAX. Strategy: Smart Money (BOS, CHoCH, FVG, OB).

### Call 3: Telegram Report (IN RUSSIAN)

```
🪙 Crypto [HH:MM]
📊 Позиций: N | Лимиток: M | P&L: +$XX
📈 Действия: [что сделал]
💬 Оценка: [тренд, план]
```

**Then STOP. Do not make more calls.**

## MANDATORY MARKET PRESENCE

- **0 positions + 0 orders = FORBIDDEN.** Place at least 1 limit order.
- Closed a position/order → replace with new limit order.
- Exception: daily loss limit hit or kill-switch ON.

## Quick Reference

```bash
# All-in-one check (Call 1)
bash /root/Projects/openclaw-assistent/scripts/crypto_check.sh

# Open trade (Call 2) — YOU decide pair, side, qty, SL, TP based on your analysis
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/trade.ts \
  --action open --pair BTCUSDT --side BUY --qty 0.001 --sl 95000 --tp 105000

# Close position
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/trade.ts --action close --pair BTCUSDT

# Modify SL/TP
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/trade.ts --action modify --pair BTCUSDT --sl 96000 --tp 106000

# Account status
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/trade.ts --action status

# Kill switch
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/killswitch.ts --on --reason="reason"
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/killswitch.ts --close-all
```

> ⚠️ FORBIDDEN: creating tasks. Only Orchestrator creates tasks.
> ⚠️ YOU own your task statuses — change them yourself (todo → in_progress → done)
