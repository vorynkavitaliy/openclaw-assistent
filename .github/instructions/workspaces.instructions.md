---
applyTo: 'workspaces/**'
---

При работе с workspace агентов:

- Каждый workspace (`workspaces/{agent-id}/`) содержит: SOUL.md, AGENTS.md, TOOLS.md, IDENTITY.md
- **SOUL.md** — личность и принципы агента. Не менять стиль/тон без согласования
- **AGENTS.md** — роль, задачи, инструменты. Обновлять при изменении функциональности
- **TOOLS.md** — API endpoints и credentials. Всегда использовать safe-формат (скрыть 80%: `7467…umn4`)
- **IDENTITY.md** — имя, эмодзи, версия агента
- Именование агентов: `<role>-<specialization>` (forex-trader, backend-dev)
- Язык агентов — русский
- НИКОГДА не вставлять реальные credentials в TOOLS.md — только safe-формат
