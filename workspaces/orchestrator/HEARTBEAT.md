# HEARTBEAT.md — Orchestrator (NO HEARTBEAT)

## Mode: Event-Driven (no periodic activation)

The Orchestrator has **NO heartbeat**. It activates ONLY when:

1. **User sends a message** via Telegram
2. **Agent contacts orchestrator** via `sessions_send`

This saves tokens — orchestrator does NOT run when idle.

## When activated by user:

1. Parse the request
2. If trading → create task on Task Board for forex-trader/crypto-trader (they pick up on heartbeat)
3. If urgent → create task + send `sessions_send` to agent directly
4. If development → create task + send `sessions_send` to tech-lead
5. If analysis → create task + send `sessions_send` to market-analyst
6. Report result to user in Telegram (IN RUSSIAN)

## When activated by agent:

1. Read agent's message
2. If agent reports completion → check Task Board → report to user
3. If agent asks for help → process and respond
4. If agent reports error → notify user

## Task Status Rules:

- You create tasks with status `todo`
- You NEVER change task statuses — only the assignee agent does that
- You only READ statuses and COMMENT on tasks
