# 🦞 OpenClaw Multi-Agent AI Team

Команда AI-агентов на платформе [OpenClaw](https://openclaw.ai/) для автоматизации торговли, разработки и тестирования.

## Структура проекта

```
openclaw-ai-assistent/
├── ARCHITECTURE.md          # Детальная архитектура системы
├── README.md                # Этот файл
├── openclaw.json            # Конфигурация OpenClaw (копируется в ~/.openclaw/)
├── scripts/
│   └── setup.sh             # Скрипт развертывания
├── workspaces/              # Workspace файлы агентов
│   ├── orchestrator/        # 🎯 Оркестратор
│   │   ├── SOUL.md
│   │   └── AGENTS.md
│   ├── forex-trader/        # 📈 Forex трейдер
│   │   ├── SOUL.md
│   │   └── AGENTS.md
│   ├── crypto-trader/       # 🪙 Crypto трейдер
│   │   ├── SOUL.md
│   │   └── AGENTS.md
│   ├── tech-lead/           # 👨‍💻 Техлид
│   │   ├── SOUL.md
│   │   └── AGENTS.md
│   ├── backend-dev/         # 🔧 Backend разработчик
│   │   ├── SOUL.md
│   │   └── AGENTS.md
│   ├── frontend-dev/        # 🎨 Frontend разработчик
│   │   ├── SOUL.md
│   │   └── AGENTS.md
│   └── qa-tester/           # 🧪 Тестировщик
│       ├── SOUL.md
│       └── AGENTS.md
└── skills/                  # Shared skills для всех агентов
    ├── taskboard/           # 📋 Task Board (Jira-аналог)
    │   ├── SKILL.md
    │   ├── scripts/
    │   │   └── taskboard.sh
    │   └── data/
    │       └── tasks.json
    ├── forex-trading/       # 📈 Forex инструменты
    │   └── SKILL.md
    ├── crypto-trading/      # 🪙 Crypto инструменты
    │   └── SKILL.md
    └── dev-tools/           # 🛠️ Dev инструменты
        └── SKILL.md
```

## Быстрый старт

### 1. Установите OpenClaw

```bash
npm install -g openclaw@latest
```

### 2. Запустите setup

```bash
./scripts/setup.sh
```

### 3. Настройте конфигурацию

Отредактируйте `~/.openclaw/openclaw.json`:

- Вставьте Telegram Bot Token
- Вставьте ваш Telegram User ID
- Добавьте API ключи брокеров (опционально)

### 4. Запустите Gateway

```bash
openclaw onboard --install-daemon
openclaw gateway --port 18789 --verbose
```

### 5. Отправьте сообщение боту в Telegram!

## Агенты

| Агент            | Модель  | Роль                             |
| ---------------- | ------- | -------------------------------- |
| 🎯 Orchestrator  | GPT-5.2 | Координация, делегирование задач |
| 📈 Forex Trader  | GPT-5.2 | Торговля на Forex                |
| 🪙 Crypto Trader | GPT-5.2 | Торговля криптовалютами          |
| 👨‍💻 Tech Lead     | GPT-5.2 | Архитектура, code review         |
| 🔧 Backend Dev   | GPT-5.2 | Серверная разработка             |
| 🎨 Frontend Dev  | GPT-5.2 | Клиентская разработка            |
| 🧪 QA Tester     | GPT-5.2 | Тестирование, автотесты          |

## Документация

- [ARCHITECTURE.md](ARCHITECTURE.md) — детальная архитектура системы
- [OpenClaw Docs](https://docs.openclaw.ai/) — документация OpenClaw
- [Multi-Agent Routing](https://docs.openclaw.ai/concepts/multi-agent) — настройка нескольких агентов
- [Skills](https://docs.openclaw.ai/tools/skills) — создание навыков

// Все токены и ключи должны храниться только в `~/.openclaw/openclaw.json` (реальные значения) или в TOOLS.md (safe-format). Никогда не публикуйте реальные данные в README.md.
