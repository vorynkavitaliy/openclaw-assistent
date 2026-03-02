# TOOLS.md — Orchestrator Commands

## ⚠️ CRITICAL: Use `exec` tool for ALL bash commands below

All commands MUST be executed via the `exec` tool. Do NOT write commands as text.

---

## 1. Trading Control (Start/Stop Agents)

```bash
# Start SPECIFIC agent (creates 2h cron + runs FIRST cycle immediately)
bash scripts/trading_control.sh start crypto-trader
bash scripts/trading_control.sh start forex-trader

# Stop SPECIFIC agent (removes cron, clears sessions, $0 cost)
bash scripts/trading_control.sh stop crypto-trader
bash scripts/trading_control.sh stop forex-trader

# Status (shows crons, recent activity, sessions)
bash scripts/trading_control.sh status

# Trading summary
bash scripts/trading_control.sh summary
```

**⛔ NEVER run `start` or `stop` without specifying agent name!**
**⛔ NEVER use `all` unless user EXPLICITLY says "все"/"оба"/"all"!**

---

## 2. Urgent Commands to Agents (DIRECT INVOCATION)

When user needs an agent to do something RIGHT NOW (not wait for next heartbeat):

```bash
# Send urgent command to crypto-trader
openclaw agent --agent crypto-trader -m "URGENT: <command>" --timeout 120

# Send urgent command to forex-trader
openclaw agent --agent forex-trader -m "URGENT: <command>" --timeout 120

# With Telegram delivery of result
openclaw agent --agent crypto-trader -m "URGENT: <command>" --timeout 120 --deliver --reply-channel telegram --reply-account 5929886678
```

### Concrete Examples

```bash
# Close all crypto positions
openclaw agent --agent crypto-trader -m "URGENT: Закрой ВСЕ позиции немедленно. Выполни: cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/trade.ts --action close-all" --timeout 120

# Check crypto account status
openclaw agent --agent crypto-trader -m "URGENT: Проверь статус аккаунта. Выполни: cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/trade.ts --action status" --timeout 120

# Open specific trade
openclaw agent --agent crypto-trader -m "URGENT: Открой LONG BTCUSDT qty=0.001 sl=65000 tp=70000 limit. Выполни: cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/trade.ts --action open --pair BTCUSDT --side BUY --qty 0.001 --sl 65000 --tp 70000 --type limit" --timeout 120
```

**⚠️ `openclaw agent` creates a NEW session — agent wakes up, executes, goes back to sleep.**
**⚠️ Do NOT use `sessions_send` — it only works for ACTIVE sessions (which don't exist between crons).**

---

## 3. Task Board

```bash
# Create task for agent
bash skills/taskboard/scripts/taskboard.sh --agent orchestrator create --title "..." --assignee crypto-trader --priority high

# List tasks
bash skills/taskboard/scripts/taskboard.sh --agent orchestrator list

# Comment on task
bash skills/taskboard/scripts/taskboard.sh --agent orchestrator comment TASK-XXX "text"
```

---

## 4. System

```bash
openclaw status        # Gateway status
openclaw agents        # Agent list
openclaw cron list     # Active cron jobs
```
