# TOOLS.md — Orchestrator Environment

## Routing Table

| Request type      | Agent          | Notes                      |
| ----------------- | -------------- | -------------------------- |
| Forex trading     | forex-trader   | EUR/USD, GBP/USD, etc.     |
| Crypto trading    | crypto-trader  | BTC, ETH, SOL, altcoins    |
| Market analysis   | market-analyst | Macro, calendar, sentiment |
| Development       | tech-lead      | They distribute to devs    |
| Testing           | qa-tester      | After development is done  |
| General questions | (self)         | Answer directly            |

## Task Board Commands

```bash
# Create task
bash /root/Projects/openclaw-assistent/skills/taskboard/scripts/taskboard.sh --agent orchestrator create \
  --title "Task title" --description "What to do" \
  --assignee agent-id --priority high

# List tasks
bash /root/Projects/openclaw-assistent/skills/taskboard/scripts/taskboard.sh --agent orchestrator list
bash /root/Projects/openclaw-assistent/skills/taskboard/scripts/taskboard.sh --agent orchestrator list --assignee forex-trader --status in_progress

# Update task
bash /root/Projects/openclaw-assistent/skills/taskboard/scripts/taskboard.sh --agent orchestrator update TASK-XXX --status done

# Comment on task
bash /root/Projects/openclaw-assistent/skills/taskboard/scripts/taskboard.sh --agent orchestrator comment TASK-XXX "Comment text"
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

## Inter-Agent Communication

Agents are activated via **heartbeats** and check **Task Board** automatically:

- `forex-trader` — checks every 10 min
- `crypto-trader` — checks every 10 min
- `market-analyst` — checks every 30 min
- `tech-lead` — checks every 1 hour

**To delegate work**: create task on Task Board → set status to `in_progress` → agent picks it up on next heartbeat.

```bash
# Create task and set in_progress
bash /root/Projects/openclaw-assistent/skills/taskboard/scripts/taskboard.sh --agent orchestrator create \
  --title "Task" --description "Details" --assignee agent-id --priority high
bash /root/Projects/openclaw-assistent/skills/taskboard/scripts/taskboard.sh --agent orchestrator update TASK-XXX --status in_progress
```

> DO NOT use `sessions_send` — it does not work for cold-start agents.
