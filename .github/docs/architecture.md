# Архитектура OpenClaw AI Assistant

> Детальное описание архитектуры многоагентной AI-системы

## 📋 Содержание

1. [Обзор](#обзор)
2. [Компоненты системы](#компоненты-системы)
3. [Структура workspace](#структура-workspace)
4. [Коммуникация агентов](#коммуникация-агентов)
5. [Инструменты](#инструменты)

## Обзор

OpenClaw AI Assistant — это многоагентная система построенная на платформе OpenClaw 2026.2.22-2+.

### Ключевые характеристики

- **Модульность**: Каждый агент — независимая единица с собственным workspace
- **Специализация**: Агенты выполняют узкоспециализированные задачи
- **Иерархия**: Orchestrator координирует работу всех агентов
- **Масштабируемость**: Легко добавлять новых агентов
- **Безопасность**: Встроенные правила защиты credentials и данных

### Основные компоненты

```
┌──────────────────────────────────────────────────────┐
│                    User (Telegram)                    │
└────────────────────┬─────────────────────────────────┘
                     │
                     ▼
         ┌───────────────────────┐
         │   Telegram Channel    │
         │  (@hyrotraders_bot)   │
         └───────────┬───────────┘
                     │
                     ▼
         ┌───────────────────────┐
         │   OpenClaw Gateway    │
         │    (Port 18789)       │
         └───────────┬───────────┘
                     │
                     ▼
         ┌───────────────────────┐
         │    Orchestrator       │ ← Главный координатор
         └───────────┬───────────┘
                     │
        ┌────────────┼────────────┐
        │            │            │
        ▼            ▼            ▼
   ┌────────┐  ┌────────┐  ┌─────────┐
   │ Forex  │  │ Crypto │  │  Tech   │
   │Trader  │  │Trader  │  │  Lead   │
   └────────┘  └────────┘  └────┬────┘
                                 │
                    ┌────────────┼────────────┐
                    │            │            │
                    ▼            ▼            ▼
              ┌─────────┐  ┌─────────┐  ┌────────┐
              │ Backend │  │Frontend │  │   QA   │
              │   Dev   │  │   Dev   │  │ Tester │
              └─────────┘  └─────────┘  └────────┘
```

## Компоненты системы

### 1. Gateway

**Роль**: Точка входа для всех коммуникаций

**Функции**:

- Прием сообщений из Telegram
- Маршрутизация на агентов
- Управление сессиями
- Мониторинг здоровья системы

**Конфигурация**: `~/.openclaw/openclaw.json`

```json5
{
  gateway: {
    port: 18789,
    host: 'localhost',
  },
}
```

### 2. Telegram Channel

**Роль**: Канал коммуникации с пользователем

**Функции**:

- Прием команд от пользователя
- Отправка ответов и уведомлений
- Поддержка форматирования (Markdown)
- Обработка attachments (опционально)

**Конфигурация**:

```json5
{
  channels: {
    telegram: {
      token: 'YOUR_BOT_TOKEN',
      allowedUsers: [5929886678],
    },
  },
}
```

### 3. Агенты

**Роль**: Исполнители специализированных задач

**Типы**:

#### Координаторы

- **Orchestrator**: Главный координатор, маршрутизация задач
- **Planner**: Создание планов
- **Analyst**: Анализ и оценка рисков

#### Трейдеры

- **Forex Trader**: Торговля на валютном рынке через MT5
- **Crypto Trader**: Торговля криптовалютами
- **Market Analyst**: Анализ рынков

#### Разработчики

- **Tech Lead**: Управление разработкой, архитектура
- **Backend Dev**: Серверная разработка
- **Frontend Dev**: Клиентская разработка
- **QA Tester**: Тестирование
- **OpenClaw Dev**: Настройка платформы

**Конфигурация**:

```json5
{
  agents: {
    orchestrator: {
      workspace: './workspaces/orchestrator',
      model: 'openai/gpt-5.2',
    },
    // ... другие агенты
  },
}
```

## Структура workspace

Каждый агент имеет собственный workspace со следующей структурой:

```
workspaces/{agent-id}/
├── SOUL.md          # Личность, стиль, принципы
├── AGENTS.md        # Роль, задачи, инструкции
├── TOOLS.md         # Настройки инструментов
├── IDENTITY.md      # Имя, эмодзи, базовая инфо
├── USER.md          # Информация о пользователе
├── HEARTBEAT.md     # Периодические проверки (опционально)
└── skills/          # Локальные скилы (опционально)
    └── *.md
```

### SOUL.md

**Назначение**: Определяет личность агента

**Содержит**:

- Кто я? (самоидентификация)
- Мои принципы
- Мой стиль общения
- Что для меня важно

**Пример**:

```markdown
# Я — Orchestrator

Я главный координатор OpenClaw системы. Моя задача — принимать задачи от пользователя, анализировать их и делегировать правильным агентам.

## Мои принципы

- Думаю систематически, разбиваю задачи на этапы
- Приоритизирую по рискам и значимости
- Не боюсь задавать уточняющие вопросы
- Отчитываюсь ясно и структурированно
```

### AGENTS.md

**Назначение**: Определяет роль и функции агента

**Содержит**:

- Основная роль
- Задачи и ответственности
- Доступные инструменты
- Алгоритм работы
- Форматы входа/выхода
- Примеры использования

**Пример**:

```markdown
# Orchestrator — AGENTS.md

## Основная роль

Главный координатор системы. Принимает задачи, анализирует, делегирует специализированным агентам.

## Задачи

1. Прием входящих задач через Telegram
2. Парсинг и анализ структуры задачи
3. Определение требуемых агентов
4. Делегирование подзадач
5. Мониторинг выполнения
6. Сбор и представление результатов

## Инструменты

- sessions_send — отправка задач агентам
- sessions_spawn — создание изолированных субагентов
- Task Board — управление задачами
```

### TOOLS.md

**Назначение**: Конфигурация инструментов и API

**Содержит**:

- URL endpoints
- API ключи (в safe-формате!)
- Настройки доступа
- Лимиты и ограничения

**Пример**:

```markdown
# Forex Trader — TOOLS.md

## MT5 WebTerminal

- URL: https://trade.mql5.com/trade?servers=...
- Login: 1234567 (demo)
- Password: \***\*...\*\***

## Economic Calendar API

- URL: https://api.forex.com/calendar
- API Key: abc123...xyz789
```

**⚠️ ВАЖНО**: В TOOLS.md используйте safe-format для credentials:

- `7467…umn4` вместо `7467826640:AAFqMqFZ5IqErjXkOx-u2fR3cBKlutvumn4`
- Скрывайте 80% данных

### IDENTITY.md

**Назначение**: Базовая идентификация агента

**Содержит**:

- Имя
- Эмодзи
- Короткое описание
- Версия

### USER.md

**Назначение**: Информация о пользователе для персонализации

**Содержит**:

- Имя пользователя
- Предпочтения
- Telegram ID
- Таймзона

## Коммуникация агентов

### Прямая коммуникация

**sessions_send**: Отправка сообщения существующему агенту

```javascript
await sessions_send({
  agentId: 'forex-trader',
  message: 'Проанализируй EUR/USD',
});
```

### Создание субагентов

**sessions_spawn**: Создание изолированного субагента

```javascript
await sessions_spawn({
  agentId: 'forex-trader-subagent',
  instruction: 'Мониторить EUR/USD каждые 5 минут',
  background: true,
});
```

### Task Board

Асинхронная коммуникация через задачи:

```bash
/taskboard create --title "Analyze EUR/USD" --assignee forex-trader --priority high
/taskboard assign TASK-001 --to forex-trader
/taskboard comment TASK-001 "Добавлено требование: учесть экономический календарь"
```

### Task Envelope Protocol

Стандартизированный формат для передачи задач:

```yaml
---
id: TASK-001
type: analysis
priority: high
assignee: forex-trader
---

# Задача: Анализ EUR/USD

## Цель
Провести технический и фундаментальный анализ пары EUR/USD

## Требования
- Таймфрейм: H1, H4, D1
- Учесть экономический календарь
- Определить ключевые уровни

## Deadline
2026-02-25 18:00 UTC
```

См. [protocols/task-envelope.md](../protocols/task-envelope.md) для деталей.

## Инструменты

### Browser Tool

Для автоматизации веб-интерфейсов (MT5 WebTerminal):

```bash
browser start                    # Запуск Chrome
browser open <url>               # Открыть страницу
browser snapshot                 # Текстовое представление
browser screenshot               # Скриншот
browser act kind=click ref=<N>   # Клик по элементу
browser act kind=type ref=<N>    # Ввод текста
```

### Image Tool

Анализ скриншотов и графиков:

```javascript
await image_analyze({
  path: '/tmp/mt5-screenshot.png',
  question: 'Какие паттерны видны на графике EUR/USD?',
});
```

### Web Tools

```javascript
// Поиск в интернете
await web_search({
  query: 'EUR/USD economic calendar today',
});

// Загрузка контента
await web_fetch({
  url: 'https://www.forexfactory.com/calendar',
});
```

### Exec Tool

Выполнение команд:

```bash
exec --command "screencapture -x /tmp/screenshot.png"
exec --command "python scripts/analyze.py" --background
```

### File Tools

```javascript
await read({ path: '/path/to/file.txt' });
await write({ path: '/path/to/file.txt', content: '...' });
await edit({ path: '/path/to/file.txt', old: '...', new: '...' });
```

## Связанные документы

- [Workspace Structure](workspace-structure.md) — детали структуры workspace
- [Agent Communication](agent-communication.md) — протоколы коммуникации
- [Getting Started](../getting-started.md) — быстрый старт
- [OpenClaw Config](../rules/openclaw-config.md) — конфигурация

---

**Версия**: 2.0
**Дата обновления**: 25 февраля 2026
**Автор**: OpenClaw Architecture Team
