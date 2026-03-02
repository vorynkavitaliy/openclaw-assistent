# HEARTBEAT.md — Crypto Trader

## ⛔ CRITICAL: NEVER RESPOND HEARTBEAT_OK

**This is a TRADING CYCLE, not a status check.**
**You MUST use tools (run commands) to execute the algorithm below.**
**Responding HEARTBEAT_OK without executing = VIOLATION.**
**Text-only analysis without tool calls = VIOLATION.**

## Activation

Heartbeat **DISABLED by default** (no config = $0 cost).
`trading_control.sh start` injects heartbeat: **every 2h**.
`trading_control.sh stop` removes it → $0.

## TOKEN ECONOMY (HARD LIMIT)

**MAX 5 tool calls per heartbeat. After 5 → STOP. No exceptions.**
**MINIMUM 3 tool calls per heartbeat. Less = you didn't do your job.**

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

## Heartbeat Algorithm (MAX 5 calls)

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

| State                                     | Action                                         |
| ----------------------------------------- | ---------------------------------------------- |
| Kill-switch ON                            | STOP immediately                               |
| Daily loss limit hit                      | NO new trades                                  |
| Strong setup at current price             | Market order via `trade.ts --action open`      |
| Good setup but price not at level yet     | **Limit order** via `trade.ts --type Limit`    |
| No clear setup but 0 positions + 0 orders | **Conservative limit order** at best S/R level |
| Positions exist, no new setup             | Monitor existing (SL/TP already set)           |

**❗ PREFER LIMIT ORDERS over market orders.** Market only when price is already at your entry level.

## ⚠️ POSITION SIZING (CRITICAL — READ BEFORE EVERY TRADE)

**Daily target: $100 with 2-5 trades = each trade must aim for $20-50 profit.**

**Formula:**

```
risk_amount = budget × risk_percent = $10,000 × 2% = $200 per trade
position_value = risk_amount / (SL_distance_%) = $200 / 2% = $10,000
qty = position_value / entry_price
leverage = position_value / (budget / max_positions) ≈ 3x
```

**Example: XRPUSDT @ $1.52**

```
Target profit per trade: $30
R:R = 1:2, so max loss = $15
SL distance = 2% → position_value = $15 / 0.02 = $750
But with leverage 3x: position_value = $750 × 3 = $2,250
qty = $2,250 / $1.52 = 1,480 XRP (NOT 130!)
TP at +4% = $90 profit ✅
SL at -2% = $45 loss ✅
```

**Minimum position value: $500 (no leverage). With leverage 3x: $1,500 minimum.**
**If position_value < $500 → INCREASE QTY. Tiny positions ($4 profit) are USELESS.**

**Quick reference by price range:**

| Coin price | Min qty (no lev) | Min qty (3x lev) | Target profit |
| ---------- | ---------------- | ---------------- | ------------- |
| $0.10-1    | 5,000 units      | 15,000 units     | $20-50        |
| $1-10      | 500 units        | 1,500 units      | $20-50        |
| $10-100    | 50 units         | 150 units        | $20-50        |
| $100-1000  | 5 units          | 15 units         | $20-50        |
| $1000+     | 0.5 units        | 1.5 units        | $20-50        |

**Limit order example:**

```bash
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/trade.ts \
  --action open --pair BTCUSDT --side BUY --type Limit --price 67000 --qty 0.001 --sl 65500 --tp 70000 --leverage 3
```

**Market order example (only when price already at entry):**

```bash
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/trade.ts \
  --action open --pair BTCUSDT --side BUY --qty 0.001 --sl 65500 --tp 70000 --leverage 3
```

Pairs: BTC, ETH, SOL, ARB, OP, LINK, AVAX. Strategy: Smart Money (BOS, CHoCH, FVG, OB).

### Call 3: Verify / Modify (optional)

If you opened a trade in Call 2, verify it was filled correctly:

```bash
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/trade.ts --action status
```

Modify SL/TP if needed. **Skip this call if no trade was made.**

### Call 4: Additional Trade (optional)

If you have budget/risk room for a second position, execute another trade.
**Skip this call if one trade is enough or no setup found.**

### Call 5: Log + Telegram Report (IN RUSSIAN)

**MANDATORY: Log your actions BEFORE sending Telegram.**

```bash
# Log what you did (REQUIRED — orchestrator monitors this)
bash /root/Projects/openclaw-assistent/scripts/trading_log.sh write crypto-trader heartbeat "Analyzed market, [opened/closed/held] [details]"

# If you opened a trade, log it separately:
bash /root/Projects/openclaw-assistent/scripts/trading_log.sh write crypto-trader trade_open "BUY BTCUSDT 0.001 @ 65400 SL=64500 TP=67500"

# If you closed a trade:
bash /root/Projects/openclaw-assistent/scripts/trading_log.sh write crypto-trader trade_close "BTCUSDT closed @ 66800 P&L=+$14.20"
```

Then send Telegram:

```
🪙 Crypto [HH:MM]
📊 Позиций: N | Лимиток: M | P&L: +$XX
📈 Действия: [что сделал]
💬 Оценка: [тренд, план]
```

**Then STOP. Do not make more calls.**

> ⚠️ NO LOG = VIOLATION. Orchestrator tracks agent activity via trading_log.sh.

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
