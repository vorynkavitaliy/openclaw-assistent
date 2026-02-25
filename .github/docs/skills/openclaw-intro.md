# Skill: Введение в OpenClaw

## Цель

Дать агенту полный контекст проекта: что такое OpenClaw, как устроена система, какие агенты есть и как они взаимодействуют.

## Когда использовать

- Перед первой задачей в проекте.
- Когда нужно понять общую архитектуру.
- Когда добавляется новый агент или скилл.

## Когда НЕ использовать

- При рутинных операциях, если архитектура уже понятна.

## Что такое OpenClaw

OpenClaw — платформа для создания команд AI-агентов, работающих через единый Gateway.

- **Docs**: https://docs.openclaw.ai/
- **Multi-agent routing**: https://docs.openclaw.ai/concepts/multi-agent
- **Skills**: https://docs.openclaw.ai/tools/skills

### Ключевые концепции

| Концепция  | Описание                                                     |
| ---------- | ------------------------------------------------------------ |
| Gateway    | Единая точка входа (port 18789), маршрутизация, управление   |
| Agent      | Автономная сущность с LLM, workspace, tools, skills          |
| Workspace  | Директория агента: SOUL.md, AGENTS.md, TOOLS.md              |
| Skill      | Пакет инструкций/скриптов, доступный одному или всем агентам |
| Binding    | Привязка канала (Telegram, WebChat) к конкретному агенту     |
| Channel    | Канал ввода: Telegram, WebChat, CLI                          |
| Task Board | Shared skill для управления задачами (аналог Jira)           |

## Наш проект

### Агенты (7 штук)

| Agent ID      | Модель         | Роль                       |
| ------------- | -------------- | -------------------------- |
| orchestrator  | openai/gpt-5.2 | Координация, делегирование |
| forex-trader  | openai/gpt-5.2 | Торговля на Forex (MT5)    |
| crypto-trader | openai/gpt-5.2 | Торговля криптовалютами    |
| tech-lead     | openai/gpt-5.2 | Архитектура, code review   |
| backend-dev   | openai/gpt-5.2 | Серверная разработка       |
| frontend-dev  | openai/gpt-5.2 | Клиентская разработка      |
| qa-tester     | openai/gpt-5.2 | Тестирование, автотесты    |

### Иерархия

```
Telegram User → Orchestrator
                  ├─ forex-trader
                  ├─ crypto-trader
                  ├─ tech-lead
                  │    ├─ backend-dev
                  │    └─ frontend-dev
                  └─ qa-tester
```

### Коммуникация между агентами

1. **sessions_send** — синхронная отправка сообщения агенту.
2. **sessions_spawn** — запуск подзадачи в отдельной сессии.
3. **sessions_list** — список активных сессий.
4. **sessions_history** — история сообщений сессии.
5. **Task Board** — асинхронная коммуникация через задачи.

### Структура проекта

```
openclaw-ai-assistent/
├── openclaw.json            # Основная конфигурация (JSON5)
├── ARCHITECTURE.md          # Детальная архитектура
├── workspaces/              # Workspace файлы агентов
│   ├── orchestrator/        # SOUL.md, AGENTS.md
│   ├── forex-trader/        # SOUL.md, AGENTS.md, TOOLS.md, skills/
│   ├── crypto-trader/       # ...
│   ├── tech-lead/           # ...
│   ├── backend-dev/         # ...
│   ├── frontend-dev/        # ...
│   └── qa-tester/           # ...
├── skills/                  # Shared skills
│   ├── taskboard/           # Task Board (Jira-аналог)
│   ├── forex-trading/       # Forex инструменты
│   ├── crypto-trading/      # Crypto инструменты
│   └── dev-tools/           # Dev инструменты
├── scripts/                 # setup.sh, fix_config.py
└── .github/                 # GitHub конфигурация (agents, docs)
```

### Где что хранится

- **Конфиг**: `openclaw.json` → копируется в `~/.openclaw/openclaw.json`
- **Workspaces**: `~/.openclaw/workspace-{agent-id}`
- **Agents**: `~/.openclaw/agents/{agent-id}/agent`
- **Skills**: `~/.openclaw/skills/{skill-name}/`
- **Логи**: `/tmp/openclaw/openclaw-*.log`

## Быстрая проверка здоровья

```bash
openclaw status              # Базовая проверка
openclaw status --deep       # Полный аудит
openclaw agents list         # Список агентов
openclaw logs --follow       # Логи в реальном времени
```

## Лучшие практики

- Всегда проверяй `openclaw status` перед работой.
- Не трогай `~/.openclaw/openclaw.json` напрямую — обновляй `openclaw.json` в репо и копируй.
- Все credentials в `~/.openclaw/`, в репо только safe-format.
- Коммитить workspace изменения (SOUL.md, AGENTS.md) в git.

## Типовые проблемы

- **Gateway не доступен**: `openclaw gateway restart`
- **Агент не отвечает**: `openclaw agent --agent <id> --message "PING"`
- **Telegram не работает**: `openclaw channels login --channel telegram`
- **Sandbox ошибки**: проверить `agents.defaults.sandbox.mode` в конфиге
