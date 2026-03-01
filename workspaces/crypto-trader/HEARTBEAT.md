# HEARTBEAT.md — Crypto Trader Autonomous Mode

## Schedule

| Condition             | Behavior                                                             |
| --------------------- | -------------------------------------------------------------------- |
| 0-1 open positions    | FULL ANALYSIS every 30 min (analyze all pairs, look for entries)     |
| 2+ open positions     | LIGHT CHECK every 30 min (monitor positions only, skip new analysis) |
| After every heartbeat | MANDATORY Telegram report in RUSSIAN                                 |

## Token Economy Rules

- **Sessions are compacted** after each cycle — you lose conversation history. This is intentional.
- All position data comes from API (monitor.ts) — you don't need memory.
- **Be concise**: minimum tool calls per cycle. Don't read workspace files you already have in system prompt.
- Target: **< 8 tool calls per heartbeat cycle**.

## Heartbeat Algorithm (every 30 min)

### Step 1: Check Positions

```bash
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/monitor.ts --dry-run
```

Count open positions from output.

### Step 2: Adaptive Mode

**IF 0-1 positions → FULL ANALYSIS:**

1. Check kill-switch status
2. Check drawdown: daily <4%, total <8% (HyroTrade buffer)
3. Check Fear & Greed, funding rates, OI
4. Analyze ALL pairs (BTC, ETH, SOL, ARB, OP, LINK, AVAX): 4h trend → 15m entry → 5m fine-tune
5. Smart Money signals: BOS, CHoCH, FVG, Order Blocks
6. If signal found → open trade automatically (without waiting for user)

**IF 2+ positions → LIGHT CHECK:**

1. Check all positions: P&L, SL/TP, margin ratio, funding rate
2. Manage existing positions (partial close at +1R, trailing at +1.5R)
3. Check drawdown limits
4. DO NOT look for new entries (save tokens)

### Step 3: Telegram Report (MANDATORY)

After EVERY heartbeat, send report to Telegram **IN RUSSIAN**:

```
🪙 Crypto [HH:MM]
📊 Позиций: N | P&L: +$XX (+X.X%)
🔍 Режим: полный анализ / мониторинг позиций
📈 Действия: [что сделал — открыл/закрыл/модифицировал или "без действий"]
💬 Рынок: [1-2 предложения — настроение, тренд, ключевые моменты]
```

### Step 4: Task Board

```bash
# Check for assigned tasks
bash /root/Projects/openclaw-assistent/skills/taskboard/scripts/taskboard.sh list --assignee crypto-trader --status todo
```

- If task with status `todo` found → change to `in_progress` YOURSELF and execute
- Log results as comments to task
- When done → change status to `done` YOURSELF

> ⚠️ FORBIDDEN: creating tasks. Only Orchestrator creates tasks.
> ⚠️ YOU own your task statuses — change them yourself (todo → in_progress → done)

## Management

```bash
# Auto-trading status
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/killswitch.ts

# Emergency stop (kill-switch)
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/killswitch.ts --on --reason="reason"

# Kill + close all positions
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/killswitch.ts --close-all

# Resume trading
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/killswitch.ts --off

# Manual monitoring
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/monitor.ts --dry-run
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/monitor.ts --pair=BTCUSDT

# Report
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/report.ts
```

## Guard Rails

| Parameter      | Value | Description                  |
| -------------- | ----- | ---------------------------- |
| Max daily loss | $500  | On reach → stop-day          |
| Max stops/day  | 2     | On reach → stop-day          |
| Max risk/trade | $250  | No more than 50% daily limit |
| Max positions  | 3     | Simultaneously open          |
| Risk per trade | 2%    | Of deposit                   |
| Max leverage   | 5x    | Default 3x                   |
| Min R:R        | 1:2   | Don't enter below            |
