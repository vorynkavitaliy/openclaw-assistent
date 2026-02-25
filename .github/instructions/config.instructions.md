---
applyTo: 'openclaw.json,scripts/**'
---

При работе с конфигурацией OpenClaw:

- `openclaw.json` в корне — это ШАБЛОН (не содержит реальных credentials)
- Реальный конфиг: `~/.openclaw/openclaw.json` (JSON5, поддерживает `//` комментарии и trailing commas)
- Основные секции: `gateway` (port 18789), `channels.telegram`, `agents.defaults.model`
- Sandbox: `agents.defaults.sandbox.mode` должен быть `"off"` (без Docker)
- При изменении конфига: `openclaw gateway restart`
- Проверка: `openclaw status --deep`
- НИКОГДА не копировать `~/.openclaw/openclaw.json` в репозиторий
