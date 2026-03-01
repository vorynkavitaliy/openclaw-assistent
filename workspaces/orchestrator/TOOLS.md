# TOOLS.md — Orchestrator Environment

## Routing Table

| Request type             | Agent            | Notes                                   |
| ------------------------ | ---------------- | --------------------------------------- |
| Forex trading            | forex-trader     | EUR/USD, GBP/USD, etc.                  |
| Crypto trading           | crypto-trader    | BTC, ETH, SOL, altcoins                 |
| Market analysis          | market-analyst   | Macro, calendar, sentiment              |
| Development              | tech-lead        | They distribute to devs                 |
| Testing                  | qa-tester        | After development is done               |
| General questions        | (self)           | Answer directly                         |

## Task Board Commands

```bash
# Create task
bash skills/taskboard/scripts/taskboard.sh --agent orchestrator create \
  --title "Task title" --description "What to do" \
  --assignee agent-id --priority high

# List tasks
bash skills/taskboard/scripts/taskboard.sh --agent orchestrator list
bash skills/taskboard/scripts/taskboard.sh --agent orchestrator list --assignee forex-trader --status in_progress

# Update task
bash skills/taskboard/scripts/taskboard.sh --agent orchestrator update TASK-XXX --status done

# Comment on task
bash skills/taskboard/scripts/taskboard.sh --agent orchestrator comment TASK-XXX "Comment text"
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

## Telegram Gateway

- Bot: @hyrotraders_bot
- Chat ID: 5929886678
- **ALL messages to user MUST be in RUSSIAN**
- Gateway: http://127.0.0.1:18789

## Inter-Agent Messaging

```
# Send to agent
sessions_send target=agent-id message="Message text"

# Example: delegate to forex-trader
sessions_send target=forex-trader message="New task TASK-XXX: analyze EUR/USD for BUY setup. Details on Task Board."
```
