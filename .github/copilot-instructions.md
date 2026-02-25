# OpenClaw AI Assistant — Copilot Instructions

Это многоагентная AI-система на основе платформы OpenClaw для автоматизации торговли и разработки. Язык проекта — русский.

## Архитектура

- **Runtime**: Node.js ≥ 20.19, OpenClaw 2026.2.22-2, TypeScript
- **Конфигурация**: `openclaw.json` (JSON5 формат) — шаблон в корне; реальный конфиг в `~/.openclaw/openclaw.json`
- **Gateway**: порт 18789, Telegram channel через `@openclaw/telegram`
- **Telegram Bot**: @hyrotraders_bot

## Структура проекта

```
openclaw-ai-assistent/
├── workspaces/          # Рабочие пространства агентов (каждый содержит SOUL.md, AGENTS.md, TOOLS.md, IDENTITY.md)
│   ├── orchestrator/    # Главный координатор — маршрутизирует задачи
│   ├── forex-trader/    # Торговля на Forex через MT5 WebTerminal
│   ├── crypto-trader/   # Торговля криптовалютами
│   ├── market-analyst/  # Анализ рынков
│   ├── tech-lead/       # Управление разработкой → делегирует backend-dev, frontend-dev, qa-tester
│   ├── backend-dev/     # Backend разработка (Node.js, TypeScript, Express/Fastify)
│   ├── frontend-dev/    # Frontend разработка (React/Next.js, TailwindCSS)
│   └── qa-tester/       # QA тестирование (Jest/Vitest, Playwright)
├── skills/              # Наборы инструкций для агентов
├── scripts/             # Служебные скрипты (setup.sh, fix_config.py)
├── .github/             # GitHub конфигурация, документация, CI/CD, Copilot инструкции
│   ├── docs/            # Полная документация (rules, skills, protocols, architecture)
│   ├── agents/          # Профили агентов
│   ├── instructions/    # Path-specific инструкции для Copilot
│   └── workflows/       # GitHub Actions
└── openclaw.json        # Шаблон конфигурации (НЕ содержит реальных credentials)
```

## Структура workspace агента

Каждый агент в `workspaces/{agent-id}/` имеет:

- **SOUL.md** — личность, стиль общения, принципы агента
- **AGENTS.md** — роль, задачи, инструменты, workflow
- **TOOLS.md** — API endpoints, credentials в safe-формате (скрыто 80%: `7467…umn4`)
- **IDENTITY.md** — имя, эмодзи, версия

## Основные команды OpenClaw

```bash
openclaw status              # Проверить состояние системы
openclaw status --deep       # Детальный аудит всех подсистем
openclaw gateway start|stop|restart  # Управление Gateway
openclaw agent --agent <id> --message "text"  # Тестировать агента
openclaw logs --follow       # Логи в реальном времени
```

## Правила безопасности (КРИТИЧНО!)

- **НИКОГДА** не коммить реальные пароли, токены, API ключи
- Credentials хранить ТОЛЬКО в `~/.openclaw/openclaw.json` или env vars
- В файлах использовать safe-формат: `7467…umn4` (скрыть 80%)
- Файл `keys.md` — **не коммитить**, должен быть в `.gitignore`
- При обнаружении утечки — немедленно ревокнуть credential

## Конвенции

- **Коммиты**: Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`)
- **Агенты**: именование `<role>-<specialization>` (forex-trader, backend-dev)
- **Язык**: документация и коммуникация агентов на русском
- **Стек разработки**: TypeScript, ESLint + Prettier, conventional commits

## Документация

Вся документация проекта находится в `.github/docs/`:

- `rules/security.md` — правила безопасности (обязательно!)
- `rules/architecture.md` — архитектурные правила
- `rules/code-review.md` — стандарты code review
- `skills/` — навыки и практики для конкретных задач
- `protocols/task-envelope.md` — формат передачи задач между агентами

## Иерархия агентов

```
User (Telegram) → Orchestrator → forex-trader, crypto-trader, tech-lead (→ backend-dev, frontend-dev, qa-tester), market-analyst
```

Orchestrator координирует всех. Tech Lead управляет dev-командой.
