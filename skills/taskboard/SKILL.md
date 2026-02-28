---
name: taskboard
description: 'Task management board (Jira-like) for AI agent team coordination. Create, assign, track, and manage tasks across all agents.'
metadata: { 'openclaw': { 'always': true, 'emoji': '📋' } }
user-invocable: true
---

# Task Board — Управление задачами

Ты имеешь доступ к системе управления задачами (Task Board). Это общая борда для всей команды агентов, аналог Jira.

## Расположение данных

- Файл задач: `{baseDir}/data/tasks.json`
- Уведомления: `{baseDir}/data/notifications.json`
- Скрипт управления: `{baseDir}/scripts/taskboard.sh`

## ⚠️ ВАЖНО: Идентификация агента

**ВСЕГДА** передавай `--agent` перед командой. Это записывает твой ID в историю задач.

```bash
bash {baseDir}/scripts/taskboard.sh --agent ТВОЙ_AGENT_ID команда [аргументы]
```

Без `--agent` в истории будет записано "unknown" — это нарушает трекинг.

## Команды

### Создание задачи

```bash
bash {baseDir}/scripts/taskboard.sh --agent ТВОЙ_ID create \
  --title "Название задачи" \
  --description "Подробное описание" \
  --type "task" \
  --assignee "agent-id" \
  --priority "high" \
  --labels "backend,api" \
  --parent "TASK-001"
```

Типы: `task`, `bug`, `feature`, `epic`
Приоритеты: `critical`, `high`, `medium`, `low`

### Список задач

```bash
# Все задачи
bash {baseDir}/scripts/taskboard.sh list

# Фильтрация по исполнителю
bash {baseDir}/scripts/taskboard.sh list --assignee backend-dev

# Фильтрация по статусу
bash {baseDir}/scripts/taskboard.sh list --status todo

# Комбинированная фильтрация
bash {baseDir}/scripts/taskboard.sh list --assignee backend-dev --status in_progress --priority high
```

### Получение задачи

```bash
bash {baseDir}/scripts/taskboard.sh get TASK-001
```

### Обновление задачи

```bash
# Изменить статус
bash {baseDir}/scripts/taskboard.sh --agent ТВОЙ_ID update TASK-001 --status in_progress

# Изменить приоритет
bash {baseDir}/scripts/taskboard.sh --agent ТВОЙ_ID update TASK-001 --priority critical

# Переназначить
bash {baseDir}/scripts/taskboard.sh --agent ТВОЙ_ID update TASK-001 --assignee frontend-dev
```

Статусы: `backlog` → `todo` → `in_progress` → `review` → `testing` → `done`

### Добавление комментария

```bash
bash {baseDir}/scripts/taskboard.sh --agent ТВОЙ_ID comment TASK-001 "Текст комментария"
```

### Уведомления (для orchestrator)

При каждом изменении статуса скрипт автоматически создаёт уведомление.

```bash
# Показать непрочитанные уведомления
bash {baseDir}/scripts/taskboard.sh notifications --unseen

# Все уведомления (последние 20)
bash {baseDir}/scripts/taskboard.sh notifications

# Отметить все как прочитанные
bash {baseDir}/scripts/taskboard.sh notifications --ack
```

### Статистика и удаление

```bash
bash {baseDir}/scripts/taskboard.sh stats
bash {baseDir}/scripts/taskboard.sh delete TASK-001
```

## Правила использования

1. **Создание задач**: Только Orchestrator и Tech Lead создают задачи (другие агенты могут создавать bug-репорты)
2. **Статусы**: Всегда обновляй статус при начале и завершении работы
3. **Комментарии**: Добавляй комментарии о прогрессе и результатах
4. **Назначение**: Каждая задача должна иметь assignee
5. **Связи**: Используй --parent для связи подзадач с родительской задачей

## Workflow

```
backlog → todo → in_progress → review → testing → done
```

- `backlog`: Задача создана, ждёт приоритизации
- `todo`: Задача готова к работе
- `in_progress`: Агент взял задачу в работу
- `review`: Код/результат готов к ревью (Tech Lead)
- `testing`: Передано на тестирование (QA Tester)
- `done`: Задача завершена и протестирована
