# TOOLS.md — Orchestrator Commands

## Task Board

```bash
# Create task
bash skills/taskboard/scripts/taskboard.sh --agent orchestrator create --title "..." --assignee AGENT --priority high

# List tasks
bash skills/taskboard/scripts/taskboard.sh --agent orchestrator list
bash skills/taskboard/scripts/taskboard.sh --agent orchestrator list --assignee AGENT --status todo

# Comment
bash skills/taskboard/scripts/taskboard.sh --agent orchestrator comment TASK-XXX "text"
```

## Agent Messaging

```bash
sessions_send target=AGENT message="TASK-XXX: Brief description."
sessions_send target=AGENT message="URGENT: TASK-XXX: Do this NOW."
```

## System

```bash
openclaw status        # Gateway status
openclaw agents        # Agent list
```
