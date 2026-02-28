---
name: "Добавить скил"
description: "Создаёт новый skill для агентов: файл в skills/<name>/SKILL.md и документацию в .github/docs/skills/. Обновляет списки скилов."
agent: "agent"
tools: ["read", "edit", "search"]
argument-hint: "Название и описание скила (например: 'binance-api — работа с Binance REST API')"
---

Создай новый OpenClaw skill: ${input:skill_spec:например 'bybit-monitor — мониторинг позиций на Bybit'}

## Шаги

1. Изучи существующий скил как образец: `skills/dev-tools/SKILL.md`
2. Создай директорию `skills/<skill-name>/`
3. Создай `skills/<skill-name>/SKILL.md`:

```yaml
---
name: <skill-name>
description: "<что делает, когда использовать> — до 1024 символов"
user-invocable: true
---
```

Тело (на русском):
- **Назначение** — кому и зачем нужен
- **Требования** — что должно быть настроено (credentials в `~/.openclaw/openclaw.json`, npm deps)
- **Команды** — конкретные bash/tsx команды из `src/` или npm scripts
- **Примеры** — реальные сценарии использования
- **Связанные модули** — файлы в `src/` которые этот скил использует

## Доступные npm скрипты для ссылок

```
npm run trade:crypto:monitor   → src/trading/crypto/monitor.ts
npm run trade:crypto:kill      → src/trading/crypto/killswitch.ts
npm run trade:crypto:report    → src/trading/crypto/report.ts
npm run trade:forex:monitor    → src/trading/forex/monitor.ts
npm run market:digest          → src/market/digest.ts
npx tsx src/trading/forex/trade.ts --action <open|close|status>
```

## Правила

- Язык — русский
- Только реальные команды которые существуют в проекте
- Credentials — только safe-формат или ссылка на `~/.openclaw/openclaw.json`
