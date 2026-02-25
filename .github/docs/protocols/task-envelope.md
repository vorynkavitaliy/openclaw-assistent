---
version: 1
date: 2026-02-24
---

# Task Envelope для OpenClaw проекта

Унифицированный формат для создания планов, анализов и делегирования задач в системе OpenClaw.

## Правила

1. **Всегда указывать** `allowed_paths` и `forbidden_paths`
2. Если задача про агента — только `workspaces/{agent-id}/**` разрешён
3. Если задача про инструменты — только `scripts/` и `openclaw.json`
4. Артефакты (планы, анализы) **только в `.github/docs/`**
5. Если требования неясны — задать **до 3 уточняющих вопросов**

## Структура Task Envelope (YAML)

```yaml
---
id: <TASK-ID или freeform-id>
date: <YYYY-MM-DD>
title: <короткое название задачи>
assignee: <orchestrator|analyst|planner>
kind: <plan|analysis|implementation>

# Контекст задачи
context:
  goal: <одно предложение что нужно достичь>
  background: <почему это важно, что есть сейчас>

  # Тип задачи
  task_class: <agent-setup|integration|bug-fix|feature|architecture|testing>

  # Какие скилы нужны
  skills_to_apply:
    - agent-workspace-structure
    - telegram-integration
    - risk-analysis

  # Ограничения
  constraints:
    - не менять существующие агенты без согласования
    - все планы в .github/docs/plans/*.md (markdown)
    - все анализы в .github/docs/analyses/*.md (markdown)
    - креденшалы не в git (только в ~/.openclaw/)

# Область работы
scope:
  allowed_paths:
    - workspaces/{agent-id}/**
    - .github/docs/**
    - openclaw.json

  forbidden_paths:
    - backend/**
    - node_modules/**
    - .git/

# Входные данные
inputs:
  files:
    - path: <если нужны конкретные файлы>
    - path: .github/copilot-instructions.md

  notes:
    - дополнительная контекст
    - текущий статус

# Что должно быть получено
deliverables:
  - тип: plan (или analysis, или implementation)
    описание: <что должно быть сделано>
    location: .github/docs/plans/<id>-<title>.md

# Выход
output:
  format: markdown
  structure:
    - Summary (резюме)
    - Main content (содержание плана/анализа)
    - DoD или Recommendations (что проверять)
    - Artifacts (что создано)

definition_of_done:
  - план имеет 5-10 шагов (каждый проверяемый)
  - риски и вопросы явно описаны
  - файл сохранен в .github/docs/{plans|analyses}/
  - задача отмечена как done в системе
```

## Ответ на Task Envelope (Markdown)

```markdown
## Summary

- <1-2 пули с главным выводом>

## Main Content

### [Для плана]

- **Цель**: ...
- **Шаги**: 1. ... 2. ... 3. ...
- **DoD**: [ ] ... [ ] ...
- **Риски**: ...

### [Для анализа]

- **Предположения**: ...
- **Риски**: ...
- **Открытые вопросы**: ...
- **Рекомендации**: ...

## Artifacts

- created: `.github/docs/plans/<id>-<title>.md`
- format: markdown
- size: ~<KB>

## Validation Checklist

- [ ] Файл создан и сохранён
- [ ] Структура соответствует протоколу
- [ ] Фронтматтер заполнен (date, id, title)
- [ ] Все ссылки на файлы рабочие
```

## Как использовать

1. **Для создания плана**:
   - Заполнить envelope выше
   - Ответить с структурой "## Summary / ## Plan / ## DoD / ## Risks"
   - Сохранить в `.github/docs/plans/<id>-<title>.md`

2. **Для создания анализа**:
   - Заполнить envelope
   - Ответить с структурой "## Summary / ## Assumptions / ## Risks / ## Questions / ## Recommendations"
   - Сохранить в `.github/docs/analyses/<id>-<title>.md`

3. **Для выполнения задачи**:
   - Заполнить envelope
   - Выполнить и вернуть результаты
   - Обновить statuses в других файлах если нужно

## Приоритет правил

1. **Пользователь** (что просит)
2. **`.github/copilot-instructions.md`** (основные правила проекта)
3. **`.github/docs/protocols/task-envelope.md`** (этот файл)
4. **`.github/docs/rules/*`** (специфические правила)

При конфликте — верх правит пользователь, затем инструкция, затем протокол.
