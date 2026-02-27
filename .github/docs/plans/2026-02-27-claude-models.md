---
id: PLAN-2026-02-27-002
title: 'Подключение Claude моделей для dev-агентов'
date: 2026-02-27
version: 1.0
status: draft
priority: high
author: orchestrator
assignees:
  - orchestrator
parent: PLAN-2026-02-27-001
---

# Подключение Claude моделей для dev-агентов

> Вынесено из основного плана рефакторинга (PLAN-2026-02-27-001) для отдельной проработки.

## Проблема

Все агенты используют `openai/gpt-5.2`. Для разработки (backend-dev, frontend-dev, qa-tester) хочется использовать Claude — лучше для кода.

## Варианты подключения Claude

OpenClaw нативно поддерживает Claude через несколько провайдеров:

### Вариант A: OpenRouter

**Плюсы**: единый ключ, доступ ко всем Claude моделям, pay-per-use
**Цена**: ~$3/M input, ~$15/M output для Claude Sonnet 4.5

```bash
# 1. Получить API ключ на https://openrouter.ai/
# 2. Добавить в OpenClaw:
openclaw models auth paste-token
# → выбрать openrouter, вставить ключ

# 3. Назначить модель dev-агентам:
```

```json5
// ~/.openclaw/openclaw.json → agents.list
{
  "id": "backend-dev",
  "model": "openrouter/anthropic/claude-sonnet-4.5"  // или claude-opus-4.6
},
{
  "id": "frontend-dev",
  "model": "openrouter/anthropic/claude-sonnet-4.5"
},
{
  "id": "qa-tester",
  "model": "openrouter/anthropic/claude-sonnet-4.5"
},
{
  "id": "tech-lead",
  "model": "openrouter/anthropic/claude-opus-4.6"  // для архитектурных решений
}
```

### Вариант B: Amazon Bedrock

**Плюсы**: enterprise, pay-per-use, no rate limits
**Минусы**: нужен AWS аккаунт, сложнее setup

```bash
openclaw models auth login  # → выбрать amazon-bedrock
```

```json5
{
  id: 'backend-dev',
  model: 'amazon-bedrock/anthropic.claude-sonnet-4-6',
}
```

### Вариант C: Anthropic напрямую

**Плюсы**: минимальная задержка
**Минусы**: нужен Anthropic API ключ

```bash
openclaw models auth paste-token  # → выбрать anthropic
```

```json5
{
  id: 'backend-dev',
  model: 'anthropic/claude-sonnet-4-5',
}
```

### Вариант D: Другой подход (TBD)

Владелец хочет попробовать альтернативный способ подключения. Детали уточняются.

## Рекомендуемая конфигурация моделей

| Агент          | Модель                                 | Причина                                        |
| -------------- | -------------------------------------- | ---------------------------------------------- |
| orchestrator   | openai/gpt-5.2                         | Хорош для координации и планирования           |
| tech-lead      | openrouter/anthropic/claude-opus-4.6   | Архитектура, code review                       |
| backend-dev    | openrouter/anthropic/claude-sonnet-4.5 | Оптимальное соотношение цена/качество для кода |
| frontend-dev   | openrouter/anthropic/claude-sonnet-4.5 | Код + UI                                       |
| qa-tester      | openrouter/anthropic/claude-sonnet-4.5 | Тесты                                          |
| forex-trader   | openai/gpt-5.2                         | Анализ + торговля                              |
| crypto-trader  | openai/gpt-5.2                         | Анализ + торговля                              |
| market-analyst | openai/gpt-5.2                         | Аналитика                                      |

## Fallback стратегия

```json5
// ~/.openclaw/openclaw.json → agents.defaults
{
  models: {
    'openrouter/anthropic/claude-sonnet-4.5': {},
    'openai/gpt-5.2': {},
    'openrouter/anthropic/claude-haiku-4.5': { alias: 'fast' },
  },
  model: {
    primary: 'openai/gpt-5.2',
    fallback: ['openrouter/anthropic/claude-sonnet-4.5'],
  },
}
```

## Доступные Claude модели в OpenClaw

Полный список (из `openclaw models list --all`):

| Провайдер                   | Модель                                                    | Контекст |
| --------------------------- | --------------------------------------------------------- | -------- |
| `anthropic/`                | claude-opus-4-5, claude-opus-4-1, claude-sonnet-4-5 и др. | 195k     |
| `openrouter/anthropic/`     | claude-opus-4.6, claude-sonnet-4.5                        | до 977k  |
| `amazon-bedrock/anthropic.` | claude-sonnet-4-6, claude-opus-4-\*                       | 195k     |

## DoD

- [ ] Выбран провайдер и способ подключения
- [ ] API ключ добавлен в OpenClaw
- [ ] Dev-агенты переключены на Claude модель
- [ ] Fallback настроен
- [ ] Протестировано: `openclaw agent --agent backend-dev --message "Напиши hello world на TypeScript"`

## Оценка: 1-2 часа (после принятия решения по провайдеру)
