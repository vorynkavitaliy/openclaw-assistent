# TOOLS.md — Backend Dev Environment

## Инструменты

### Runtime

- Node.js >= 20
- Python 3.10+
- npm / pnpm

### Базы данных

- SQLite (OpenClaw memory)
- `[настроить PostgreSQL/MySQL если используется]`

### API

- OpenClaw Gateway: http://127.0.0.1:18789
- `[настроить внешние API если нужны]`

### Тестирование

- Jest / Vitest
- pytest (для Python)

## Коммуникация

- Получает задачи от **tech-lead** через **sessions_send** (мгновенно) + **Task Board** (трекинг)
- Отчитывается через **sessions_send** + обновление **Task Board**
