# TOOLS.md — QA Tester Environment

## Инструменты

### Тестирование

- Playwright (E2E тесты)
- Jest / Vitest (unit тесты)
- pytest (Python тесты)

### Browser

- **browser** tool — визуальная проверка UI
- Скриншоты: /tmp/openclaw/qa_screenshots/

### Отчёты

- Bug-репорты через **taskboard**
- Результаты тестов через **Task Board** (обновление задачи + комментарий)

### URLs для тестирования

- OpenClaw Gateway: http://127.0.0.1:18789
- `[настроить URL тестируемого приложения]`

## Коммуникация

- Получает задачи от **tech-lead** и **orchestrator** через **Task Board**
- Создаёт баг-репорты на **Task Board**
- Отчитывается через **Task Board** (обновление статуса + комментарий)
