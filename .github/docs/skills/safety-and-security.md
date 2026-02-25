# Skill: Безопасность и защита

## Цель

Описать что НЕЛЬЗЯ делать, как защитить credentials, как обнаружить и среагировать на проблемы.

## Когда использовать

- **ВСЕГДА**. Этот скилл применяется к каждой задаче.

## Что НЕЛЬЗЯ делать (❌ ЗАПРЕЩЕНО)

### Credentials

- ❌ Коммитить пароли, токены, API-ключи в git.
- ❌ Логировать credentials в открытом виде.
- ❌ Отправлять credentials в Telegram сообщениях.
- ❌ Хранить реальные ключи в `.md` файлах репозитория.
- ❌ Использовать `echo $SECRET_KEY` без redirect в файл.

### Системные операции

- ❌ `sudo` команды без явного разрешения пользователя.
- ❌ `rm -rf /` или деструктивные операции.
- ❌ `git push --force` в `main`, `dev`, `staging` без подтверждения.
- ❌ `git reset --hard` без подтверждения.
- ❌ Удаление remote branch без подтверждения.

### Данные

- ❌ Торговать реальными деньгами без явного разрешения.
- ❌ Удалять чужие workspace файлы.
- ❌ Модифицировать `~/.openclaw/openclaw.json` без команды.

## Что НУЖНО делать (✓ ОБЯЗАТЕЛЬНО)

### Credentials

- ✓ Хранить в `~/.openclaw/openclaw.json` (защищённый файл).
- ✓ Или в переменных окружения (`OPENCLAW_*`).
- ✓ В `.md` файлах репо — только safe-format: `7467…umn4` (скрыть 80%).
- ✓ В `TOOLS.md` агента — safe-format + комментарий «спросить у пользователя».

### Safe-format примеры

```
# Токен
Реальный: [ПОЛНЫЙ ТОКЕН — НИКОГДА не хранить в файлах!]
Safe:     7467…umn4

# API Key
Реальный: sk-proj-DjpyLx3EGvoEgsTYbT8GNZ...
Safe:     sk-proj-Djpy…(hidden)

# Пароль
Реальный: !ea2*r$31!Quq
Safe:     !ea2…Quq
```

### Логирование

- ✓ Логировать действия, но НЕ sensitive данные.
- ✓ Пример хорошего лога: `"Авторизация в MT5: успешно"`.
- ❌ Пример плохого лога: `"Авторизация в MT5: логин=531182488, пароль=!ea2*r$31!Quq"`.

## Где хранить что

| Данные          | Где                             | Формат      |
| --------------- | ------------------------------- | ----------- |
| Bot Token       | `~/.openclaw/openclaw.json`     | Реальный    |
| API ключи       | `~/.openclaw/openclaw.json` env | Реальный    |
| MT5 credentials | `workspaces/*/TOOLS.md`         | Safe-format |
| Пароли брокеров | env vars или encrypted storage  | Реальный    |
| Всё в git       | Репозиторий                     | Safe-format |

## Процесс при обнаружении утечки

### Шаг 1: Немедленно

```
1. ОСТАНОВИТЬ текущую работу.
2. НЕ коммитить ничего.
3. Уведомить пользователя через Telegram.
```

### Шаг 2: Оценить

```
1. Что утекло? (токен, пароль, API key)
2. Куда утекло? (git history, лог, сообщение)
3. Был ли push в remote?
```

### Шаг 3: Исправить

```
1. Если в git history → git filter-branch или BFG.
2. Ротировать скомпрометированный credential.
3. Проверить access logs.
4. Создать анализ инцидента в .github/docs/analyses/.
```

## Безопасность агентов

### Sandbox

- `sandbox.mode: "non-main"` — агенты работают в sandbox для non-main задач.
- Если Docker недоступен — `sandbox.mode: "off"`.
- Трейдеры должны иметь ограниченный доступ к файлам разработки.

### Доступ между агентами

```json5
"tools": {
  "agentToAgent": {
    "enabled": true,
    "allow": ["orchestrator", "tech-lead", "backend-dev", ...]
  }
}
```

### Telegram DM Policy

- `dmPolicy: "allowlist"` — только пользователи из `allowFrom`.
- Проверить: `openclaw status --deep` → Telegram OK.

## Чеклист безопасности

- [ ] В git нет реальных credentials (grep: token, password, secret, api_key).
- [ ] `~/.openclaw/openclaw.json` содержит реальные ключи (не в репо).
- [ ] Telegram bot имеет `dmPolicy: "allowlist"`.
- [ ] `allowFrom` содержит только ваш Telegram ID.
- [ ] TOOLS.md файлы используют safe-format.
- [ ] Логи не содержат sensitive данных.
