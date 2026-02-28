# TOOLS.md — Orchestrator Environment

## Инфраструктура

- **Сервер**: srv1427432 (76.13.250.171), Linux 6.8.0
- **Node.js**: 22.22.0, TypeScript ES2022/NodeNext strict
- **OpenClaw**: v2026.2.26, Gateway порт 18789 (local loopback)
- **Telegram**: @hyrotraders_bot
- **Проект**: /root/Projects/openclaw-assistent

## Коммуникация с агентами

### sessions_send (синхронно)

Отправить сообщение агенту и дождаться ответа:

```
sessions_send target=forex-trader message="Проверь текущие позиции"
```

### sessions_spawn (асинхронно)

Запустить подзадачу у агента:

```
sessions_spawn target=crypto-trader message="Анализ BTC/USDT, ищи точку входа"
```

## Task Board

```bash
# Создать задачу
bash skills/taskboard/scripts/taskboard.sh create --title "..." --assignee developer --priority high

# Обновить статус
bash skills/taskboard/scripts/taskboard.sh update TASK-XXX --status in-progress

# Список задач
bash skills/taskboard/scripts/taskboard.sh list

# Статистика
bash skills/taskboard/scripts/taskboard.sh stats
```

## Скрипты мониторинга

```bash
# Статус системы
openclaw status

# Глубокая проверка (каналы, сессии)
openclaw status --deep

# Логи в реальном времени
openclaw logs --follow

# Перезапуск шлюза
openclaw gateway restart

# Крипто отчёт
npx tsx src/trading/crypto/report.ts

# Рыночный дайджест
npx tsx src/market/digest.ts
```

## Telegram Gateway API

Агент может отправлять сообщения пользователю через стандартные ответы. Все DM от пользователя 5929886678 маршрутизируются в orchestrator (первый в списке агентов, dmPolicy: pairing).

## Правила маршрутизации

| Тема                    | Агент                                |
| ----------------------- | ------------------------------------ |
| Торговля крипто         | crypto-trader                        |
| Торговля форекс         | forex-trader                         |
| Анализ рынка            | market-analyst                       |
| Разработка (новые фичи) | tech-lead → backend-dev/frontend-dev |
| Тестирование            | qa-tester                            |
| Баги в коде             | tech-lead                            |
