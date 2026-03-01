# HEARTBEAT.md — Orchestrator (every 15 minutes)

## On each heartbeat:

1. **Task Board check** — find stuck tasks (in_progress > 2 hours):

   ```bash
   bash /root/Projects/openclaw-assistent/skills/taskboard/scripts/taskboard.sh --agent orchestrator list --status in_progress
   ```

   If task is stuck — notify user and ping the assignee.

2. **Agent status** — check that Gateway and channels are working:

   ```bash
   openclaw status
   ```

   If Telegram OFF or Gateway unreachable — send alert to user.

3. **If no stuck tasks and no user requests — DO NOTHING.** Save tokens.
