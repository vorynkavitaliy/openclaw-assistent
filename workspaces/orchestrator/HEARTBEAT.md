# HEARTBEAT.md — Orchestrator (NO HEARTBEAT)

## Mode: Event-Driven (no periodic activation)

The Orchestrator has **NO heartbeat**. It activates ONLY when:

1. **User sends a message** via Telegram
2. **Agent contacts orchestrator** via `sessions_send`

This saves tokens — orchestrator does NOT run when idle.

## When activated by user:

1. Parse the request
2. Create task on Task Board (assignee = target agent)
3. **IMMEDIATELY send `sessions_send` to the agent** — agents do NOT poll task board
4. Report to user in Telegram (IN RUSSIAN): task created, agent notified

Priority routing:
- Normal → `sessions_send target=AGENT message="TASK-XXX: description"`
- Urgent (user says "срочно/сейчас/немедленно") → priority `critical` + `URGENT:` prefix in message → agent drops current work

## When activated by agent:

1. Read agent's message
2. If completion → report to user
3. If error → notify user
4. If help request → process and respond

## Task Status Rules:

- You create tasks with status `todo`
- You NEVER change task statuses — only the assignee agent does that
- You only READ statuses and COMMENT on tasks
