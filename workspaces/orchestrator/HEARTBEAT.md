# HEARTBEAT.md — Orchestrator (каждые 30 минут)

## При каждом heartbeat:

1. **Task Board проверка** — найди зависшие задачи (in_progress > 2 часов):
   ```bash
   bash skills/taskboard/scripts/taskboard.sh list --status in_progress
   ```
   Если задача зависла — уведоми пользователя и пингни исполнителя.

2. **Статус агентов** — проверь что Gateway и каналы работают:
   ```bash
   openclaw status
   ```
   Если Telegram OFF или Gateway unreachable — отправь алерт пользователю.

3. **Утренний брифинг** (только 09:00 UTC+3) — отправь пользователю:
   - Статус всех открытых позиций (crypto + forex)
   - Активные задачи на Task Board
   - Важные новости рынка от market-analyst
