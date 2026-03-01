```skill
---
name: taskboard
description: 'Task management board (Jira-like) for AI agent team coordination. Create, assign, track, and manage tasks across all agents.'
metadata: { 'openclaw': { 'always': true, 'emoji': '📋' } }
user-invocable: true
---

# Task Board — Task Management

You have access to the task management system (Task Board). It is a shared board for the entire agent team, similar to Jira.

## Data Location

- Tasks file: `{baseDir}/data/tasks.json`
- Notifications: `{baseDir}/data/notifications.json`
- Telegram config: `{baseDir}/data/telegram.conf` (gitignored)
- Management script: `{baseDir}/scripts/taskboard.sh`

## Agent Identification

The script **automatically detects** the agent from the CWD workspace directory.
No need to pass anything — `reporter` and `agent` will be populated correctly.

Detection order: `--agent` flag → `OPENCLAW_AGENT_ID` env → CWD `/workspaces/<id>` → ancestor CWD.

If auto-detection fails (shows "unknown"), pass explicitly:

```bash
bash {baseDir}/scripts/taskboard.sh --agent YOUR_AGENT_ID command [arguments]
```

## Commands

### Creating a Task

```bash
bash {baseDir}/scripts/taskboard.sh --agent YOUR_ID create \
  --title "Task title" \
  --description "Detailed description" \
  --type "task" \
  --assignee "agent-id" \
  --priority "high" \
  --labels "backend,api" \
  --parent "TASK-001"
```

Types: `task`, `bug`, `feature`, `epic`
Priorities: `critical`, `high`, `medium`, `low`

### Listing Tasks

```bash
# All tasks
bash {baseDir}/scripts/taskboard.sh list

# Filter by assignee
bash {baseDir}/scripts/taskboard.sh list --assignee backend-dev

# Filter by status
bash {baseDir}/scripts/taskboard.sh list --status todo

# Combined filtering
bash {baseDir}/scripts/taskboard.sh list --assignee backend-dev --status in_progress --priority high
```

### Getting a Task

```bash
bash {baseDir}/scripts/taskboard.sh get TASK-001
```

### Updating a Task

```bash
# Change status
bash {baseDir}/scripts/taskboard.sh --agent YOUR_ID update TASK-001 --status in_progress

# Change priority
bash {baseDir}/scripts/taskboard.sh --agent YOUR_ID update TASK-001 --priority critical

# Reassign
bash {baseDir}/scripts/taskboard.sh --agent YOUR_ID update TASK-001 --assignee frontend-dev
```

Statuses: `backlog` → `todo` → `in_progress` → `review` → `testing` → `done`

### Adding a Comment

```bash
bash {baseDir}/scripts/taskboard.sh --agent YOUR_ID comment TASK-001 "Comment text"
```

### Notifications (for orchestrator)

The script automatically creates a notification on every status change.

```bash
# Show unseen notifications
bash {baseDir}/scripts/taskboard.sh notifications --unseen

# All notifications (last 20)
bash {baseDir}/scripts/taskboard.sh notifications

# Mark all as read
bash {baseDir}/scripts/taskboard.sh notifications --ack
```

### Statistics and Deletion

```bash
bash {baseDir}/scripts/taskboard.sh stats
bash {baseDir}/scripts/taskboard.sh delete TASK-001
```

## Telegram Notifications

All task actions are automatically sent to the user via Telegram.

**What gets notified:**

- Task creation
- Status changes
- Priority changes
- Assignee changes
- Comments
- Task deletion

**Visual system (emoji by agent):**
| Agent | Emoji |
|-------|-------|
| orchestrator | 🎯 |
| crypto-trader | ₿ |
| forex-trader | 💱 |
| market-analyst | 📊 |
| tech-lead | 👨‍💻 |
| backend-dev | ⚙️ |
| frontend-dev | 🎨 |
| qa-tester | 🧪 |

**Configuration:** `{baseDir}/data/telegram.conf` (gitignored, do not commit):

```bash
TG_BOT_TOKEN="bot-token-here"
TG_CHAT_ID="chat-id-here"
```

If `telegram.conf` is missing or empty — notifications are silently skipped.

## Usage Rules

1. **Task creation**: Only Orchestrator and Tech Lead create tasks (other agents may create bug reports)
2. **Statuses**: Always update status when starting and finishing work
3. **Comments**: Add comments about progress and results
4. **Assignment**: Every task must have an assignee
5. **Relations**: Use --parent to link subtasks to a parent task

## Workflow

```
backlog → todo → in_progress → review → testing → done
```

- `backlog`: Task created, awaiting prioritization
- `todo`: Task is ready to be worked on
- `in_progress`: Agent has picked up the task
- `review`: Code/result is ready for review (Tech Lead)
- `testing`: Passed to testing (QA Tester)
- `done`: Task completed and tested
