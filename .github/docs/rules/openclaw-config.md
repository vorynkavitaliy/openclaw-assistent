# Правила конфигурации OpenClaw

Обязательные правила при работе с конфигурацией OpenClaw платформы.

## 1. Файл openclaw.json

### Формат

JSON5 (поддерживает комментарии `//` и trailing commas).

### Местоположение

- **В репо**: `openclaw.json` (шаблон с safe-format credentials)
- **Рабочий**: `~/.openclaw/openclaw.json` (реальные credentials)
- **НЕ копировать** рабочий файл в репо!

### Обязательные секции

```json5
{
  gateway: {}, // Порт, параметры Gateway
  channels: {}, // Telegram, WebChat и другие каналы
  bindings: {}, // Привязка каналов к агентам
  agents: {}, // Список агентов, модели, sandbox
  tools: {}, // Browser, agentToAgent, subagents
  skills: {}, // Shared skills
  messages: {}, // Настройки сообщений
}
```

### Параметры Gateway

| Поле           | Тип    | Описание                       | Default |
| -------------- | ------ | ------------------------------ | ------- |
| `gateway.port` | number | Порт Gateway (только loopback) | 18789   |

### Параметры Channels

| Поле                          | Тип     | Описание                   |
| ----------------------------- | ------- | -------------------------- |
| `channels.telegram.enabled`   | boolean | Включить Telegram          |
| `channels.telegram.token`     | string  | Bot Token от @BotFather    |
| `channels.telegram.dmPolicy`  | string  | `"allowlist"` или `"open"` |
| `channels.telegram.allowFrom` | array   | `["tg:<USER_ID>"]`         |
| `channels.webchat.enabled`    | boolean | Включить WebChat           |

### Параметры Bindings

```json5
"bindings": {
  "telegram.dm": "orchestrator",   // Кто получает DM из Telegram
  "webchat.dm": "orchestrator"     // Кто получает DM из WebChat
}
```

### Параметры Agents

| Поле                           | Тип    | Описание                  |
| ------------------------------ | ------ | ------------------------- |
| `agents.defaults.model`        | string | Модель по умолчанию       |
| `agents.defaults.sandbox.mode` | string | `"non-main"`, `"off"`     |
| `agents.list[].id`             | string | Уникальный ID агента      |
| `agents.list[].name`           | string | Читаемое имя              |
| `agents.list[].model`          | string | Модель (override default) |
| `agents.list[].workspace`      | string | Путь к workspace          |

### Параметры Tools

| Поле                          | Тип     | Описание                    |
| ----------------------------- | ------- | --------------------------- |
| `tools.browser.enabled`       | boolean | Browser Tool (CDP)          |
| `tools.agentToAgent.enabled`  | boolean | Коммуникация между агентами |
| `tools.agentToAgent.allow`    | array   | Список agent ID с доступом  |
| `tools.subagents.tools.allow` | array   | Инструменты для субагентов  |

### Доступные subagent tools

```json5
"tools": {
  "subagents": {
    "tools": {
      "allow": [
        "exec",              // Выполнение команд
        "read",              // Чтение файлов
        "write",             // Запись файлов
        "edit",              // Редактирование файлов
        "apply_patch",       // Применение патчей
        "browser",           // Управление браузером
        "sessions_list",     // Список сессий
        "sessions_history",  // История сессий
        "sessions_send"      // Отправка сообщений агентам
      ]
    }
  }
}
```

### Параметры Skills

| Поле                            | Тип     | Описание                  |
| ------------------------------- | ------- | ------------------------- |
| `skills.load.watch`             | boolean | Hot-reload при изменениях |
| `skills.load.watchDebounceMs`   | number  | Debounce для watch (ms)   |
| `skills.entries.<name>.enabled` | boolean | Включить skill            |
| `skills.entries.<name>.env`     | object  | Env vars для skill        |

## 2. CLI команды OpenClaw

### Gateway

```bash
openclaw gateway --port 18789 --verbose   # Запуск с логами
openclaw gateway stop                     # Остановка
openclaw gateway restart                  # Перезапуск
openclaw onboard --install-daemon         # Установить как daemon (LaunchAgent)
```

### Статус

```bash
openclaw status                           # Базовая проверка (Gateway, Telegram, агенты)
openclaw status --deep                    # Полный аудит всех подсистем
```

### Агенты

```bash
openclaw agents list                      # Список агентов
openclaw agents list --bindings           # С привязками каналов
openclaw agents add <agent-id>            # Добавить нового агента
openclaw agent --agent <id> --message "text"         # Тест агента
openclaw agent --agent <id> --message "text" --deliver  # С доставкой в канал
```

### Каналы

```bash
openclaw channels login --channel telegram  # Авторизация Telegram бота
```

### Логи

```bash
openclaw logs --follow                    # Логи в реальном времени
tail -50 /tmp/openclaw/openclaw-*.log     # Последние записи
```

## 3. Правила изменения конфигурации

### ✓ Обязательно

- После любого изменения `openclaw.json` → `openclaw status --deep`.
- После добавления агента → `openclaw agent --agent <id> --message "PING"`.
- Credentials только в `~/.openclaw/openclaw.json`, в репо — safe-format.
- Hot-reload работает для skills и модели (не нужен restart).
- Restart нужен для: новые агенты, изменение bindings, изменение channels.

### ✗ Запрещено

- Коммитить `~/.openclaw/openclaw.json` с реальными токенами в git.
- Менять `gateway.port` без обновления документации.
- Удалять агента из `agents.list` без удаления из `tools.agentToAgent.allow`.
- Менять `dmPolicy` на `"open"` без обсуждения с пользователем.

## 4. Workspace файлы

### Обязательные файлы для каждого агента

| Файл           | Обязательный | Описание                       |
| -------------- | ------------ | ------------------------------ |
| `SOUL.md`      | ✓ Да         | Личность, стиль, принципы      |
| `AGENTS.md`    | ✓ Да         | Роль, задачи, инструменты      |
| `TOOLS.md`     | Опционально  | Credentials (safe-format), API |
| `IDENTITY.md`  | Опционально  | Имя, эмодзи                    |
| `USER.md`      | Опционально  | Информация о пользователе      |
| `HEARTBEAT.md` | Опционально  | Периодические задачи           |

### Где лежат workspace'ы

- **В репо**: `workspaces/{agent-id}/` (шаблоны)
- **Рабочие**: `~/.openclaw/workspace-{agent-id}` (копии)
- **Agent dir**: `~/.openclaw/agents/{agent-id}/agent`

## 5. Версии и совместимость

- **OpenClaw**: 2026.2.22-2
- **Node.js**: ≥ 22
- **Конфиг**: JSON5 формат
- **Hot-reload**: модель агента, skills (без restart)
- **Restart нужен**: agents.list, bindings, channels, tools
