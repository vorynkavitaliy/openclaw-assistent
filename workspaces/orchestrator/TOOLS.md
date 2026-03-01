# TOOLS.md — Orchestrator Environment

## Routing Table

| Request type          | Agent          | Activation method                              |
| --------------------- | -------------- | ---------------------------------------------- |
| Start trading/monitor | forex/crypto   | Enable heartbeat + sessions_send               |
| Stop trading          | forex/crypto   | Disable heartbeat + cleanup                    |
| One-off trade         | forex/crypto   | sessions_send (no heartbeat needed)            |
| Market analysis       | market-analyst | sessions_send                                  |
| Development           | tech-lead      | sessions_send                                  |
| Testing               | qa-tester      | sessions_send                                  |
| General questions     | (self)         | Answer directly                                |

> **ALL agents are OFF by default. Heartbeat = $0 when idle.**

## Task Board Commands

```bash
# Create task (always status 'todo' — agent changes it themselves)
bash /root/Projects/openclaw-assistent/skills/taskboard/scripts/taskboard.sh --agent orchestrator create \
  --title "Task title" --description "What to do" \
  --assignee agent-id --priority high

# List tasks (read-only)
bash /root/Projects/openclaw-assistent/skills/taskboard/scripts/taskboard.sh --agent orchestrator list
bash /root/Projects/openclaw-assistent/skills/taskboard/scripts/taskboard.sh --agent orchestrator list --assignee forex-trader --status in_progress
bash /root/Projects/openclaw-assistent/skills/taskboard/scripts/taskboard.sh --agent orchestrator list --status done

# Comment on task
bash /root/Projects/openclaw-assistent/skills/taskboard/scripts/taskboard.sh --agent orchestrator comment TASK-XXX "Comment text"
```

> ⚠️ DO NOT use `update --status` — only the assignee agent changes task statuses!

## Direct Agent Messaging

For urgent tasks or on-demand agents (those WITHOUT heartbeat):

```bash
# Send direct message to any agent
sessions_send target=agent-id message="TASK-XXX: Brief description. Details on Task Board."

# Examples:
sessions_send target=tech-lead message="TASK-010: Refactor crypto monitor. See Task Board."
sessions_send target=market-analyst message="TASK-011: EUR/USD fundamentals needed. See Task Board."
sessions_send target=forex-trader message="URGENT: Close all positions NOW."
```

## System Commands

```bash
# Gateway status
openclaw status

# Agent list
openclaw agents

# Restart gateway (caution!)
openclaw restart
```

## Trading Heartbeat Control (ON-DEMAND)

Heartbeats are **DISABLED by default**. Enable only when user requests monitoring/trading.

```bash
# User says "мониторь крипто/форекс" or "начни торговать" → ENABLE
bash /root/Projects/openclaw-assistent/scripts/trading_control.sh start

# User says "стоп", "останови", "/stop" → DISABLE
bash /root/Projects/openclaw-assistent/scripts/trading_control.sh stop

# Check status
bash /root/Projects/openclaw-assistent/scripts/trading_control.sh status

# Clean sessions (free context)
bash /root/Projects/openclaw-assistent/scripts/trading_control.sh cleanup
```

### Workflow:
1. User asks to start trading → you run `trading_control.sh start` + `sessions_send` to notify trader
2. Trader heartbeats every 30m, sends Telegram reports
3. User says stop → you run `trading_control.sh stop` → heartbeat off, $0 cost

### For one-off commands (no heartbeat needed):
```bash
# Direct command to agent without enabling heartbeat
sessions_send target=crypto-trader message="Check BTC position and report to Telegram"
sessions_send target=forex-trader message="Close EUR/USD position"
```

## Telegram Gateway

- Bot: @hyrotraders_bot
- Chat ID: 5929886678
- **ALL messages to user MUST be in RUSSIAN**
- Gateway: http://127.0.0.1:18789

## Agent Activation Summary

| Agent          | Has Heartbeat | How to activate                                                  |
| -------------- | ------------- | ---------------------------------------------------------------- |
| forex-trader   | Yes (10m)     | Create task → picks up on heartbeat. Or sessions_send for urgent |
| crypto-trader  | Yes (10m)     | Create task → picks up on heartbeat. Or sessions_send for urgent |
| tech-lead      | No            | Create task + sessions_send (REQUIRED)                           |
| backend-dev    | No            | Via tech-lead only                                               |
| frontend-dev   | No            | Via tech-lead only                                               |
| qa-tester      | No            | Create task + sessions_send (REQUIRED)                           |
| market-analyst | No            | Create task + sessions_send (REQUIRED)                           |
