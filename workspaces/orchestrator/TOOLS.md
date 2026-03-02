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

## Trading Control

```bash
# Start/stop trading agents (creates cron + runs IMMEDIATELY)
bash scripts/trading_control.sh start [crypto-trader|forex-trader|all]
bash scripts/trading_control.sh stop [crypto-trader|forex-trader|all]
bash scripts/trading_control.sh status    # Crons + recent activity + sessions
```

## Trading Activity Log

```bash
# View recent agent activity
bash scripts/trading_log.sh show --last 10           # All agents, last 10
bash scripts/trading_log.sh show crypto-trader        # Only crypto agent
bash scripts/trading_log.sh show forex-trader --last 5

# Today's summary (trades, heartbeats, errors per agent)
bash scripts/trading_log.sh summary

# Quick status via trading_control
bash scripts/trading_control.sh log [agent]           # Shortcut for show
bash scripts/trading_control.sh summary               # Shortcut for summary
```

Use this to verify agents are actually working after starting them.
If no log entries appear within 5 minutes of start → agent may be stuck.

## System

```bash
openclaw status        # Gateway status
openclaw agents        # Agent list
```
