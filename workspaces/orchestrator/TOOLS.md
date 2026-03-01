# TOOLS.md — Orchestrator Environment

## Routing Table

| Request type      | Agent          | Activation method                  |
| ----------------- | -------------- | ---------------------------------- |
| Forex trading     | forex-trader   | Task Board (picks up on heartbeat) |
| Crypto trading    | crypto-trader  | Task Board (picks up on heartbeat) |
| Market analysis   | market-analyst | Task Board + sessions_send         |
| Development       | tech-lead      | Task Board + sessions_send         |
| Testing           | qa-tester      | Task Board + sessions_send         |
| General questions | (self)         | Answer directly                    |
| URGENT anything   | any agent      | Task Board + sessions_send         |

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
