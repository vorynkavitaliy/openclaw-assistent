# HEARTBEAT.md — Forex Trader Autonomous Mode

## Schedule

| Condition             | Behavior                                                             |
| --------------------- | -------------------------------------------------------------------- |
| 0-1 open positions    | FULL ANALYSIS every 10 min (analyze all pairs, look for entries)     |
| 2+ open positions     | LIGHT CHECK every 10 min (monitor positions only, skip new analysis) |
| Weekend (Sat-Sun)     | DO NOTHING — forex market closed, save tokens                        |
| After every heartbeat | MANDATORY Telegram report in RUSSIAN                                 |

## Heartbeat Algorithm (every 10 min)

### Step 0: Weekend Check

If Saturday or Sunday → do nothing, save tokens, exit immediately.

### Step 1: Check Positions

```bash
cd /root/Projects/openclaw-assistent && npx tsx src/trading/forex/monitor.ts --heartbeat
```

Count open positions from output.

### Step 2: Adaptive Mode

**IF 0-1 positions → FULL ANALYSIS:**

1. Check account status and drawdown (FTMO: daily <4%, total <8%)
2. Check if in trading session (London 09:00-17:00 Kyiv / NY 16:00-00:00 Kyiv)
3. If in session → analyze ALL pairs (EUR/USD, GBP/USD, USD/JPY, AUD/USD, USD/CHF): H4 trend → M15 entry → M5 fine-tune
4. Check economic calendar — ±30 min from HIGH impact = don't trade
5. Smart Money signals: BOS, CHoCH, FVG, Order Blocks, S&D zones
6. If signal found → open trade automatically (without waiting for user)
7. If outside session → only monitor existing positions

**IF 2+ positions → LIGHT CHECK:**

1. Check all positions: P&L, SL/TP, drawdown
2. Manage existing positions (partial close at +1R, trailing at +1.5R)
3. FTMO risk check
4. DO NOT look for new entries (save tokens)

### Step 3: Telegram Report (MANDATORY)

After EVERY heartbeat, send report to Telegram **IN RUSSIAN**:

```
📊 Forex [HH:MM]
📈 Позиций: N | P&L: +$XX (+X.X%)
🔍 Режим: полный анализ / мониторинг позиций
📋 Действия: [что сделал — открыл/закрыл/модифицировал или "без действий"]
💬 Рынок: [1-2 предложения — настроение, тренд, сессия]
```

### Step 4: Task Board

```bash
# Check for assigned tasks
bash /root/Projects/openclaw-assistent/skills/taskboard/scripts/taskboard.sh list --assignee forex-trader --status todo
```

- If task with status `todo` found → change to `in_progress` YOURSELF and execute
- Log results as comments to task
- When done → change status to `done` YOURSELF

> ⚠️ FORBIDDEN: creating tasks. Only Orchestrator creates tasks.
> ⚠️ YOU own your task statuses — change them yourself (todo → in_progress → done)
> FTMO rules: `skills/forex-trading/FTMO_RULES.md`

## Management

```bash
# Heartbeat — account, positions, drawdown, FTMO alerts
cd /root/Projects/openclaw-assistent && npx tsx src/trading/forex/monitor.ts --heartbeat

# Monitoring with analysis
cd /root/Projects/openclaw-assistent && npx tsx src/trading/forex/monitor.ts --trade --dry-run

# Live mode (auto-trading)
cd /root/Projects/openclaw-assistent && npx tsx src/trading/forex/monitor.ts --trade

# Risk check (FTMO max daily/total drawdown)
cd /root/Projects/openclaw-assistent && npx tsx src/trading/forex/monitor.ts --risk-check
```
