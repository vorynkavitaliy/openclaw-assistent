# OpenClaw AI Assistant — Copilot Instructions

Многоагентная AI-система на платформе OpenClaw для автоматизации торговли. Язык проекта — русский.

## Стек

- **Runtime**: Node.js ≥ 20, TypeScript 5, ES Modules (`"type": "module"`)
- **Зависимости**: `bybit-api` (крипто), `rss-parser` (дайджест)
- **Инструменты**: ESLint + Prettier, Vitest, tsx
- **OpenClaw**: v2026.2.22-2, Gateway порт 18789, Telegram @hyrotraders_bot
- **Конфиг**: шаблон `openclaw.json` в корне; реальный конфиг в `~/.openclaw/openclaw.json`

## Структура src/

```
src/
├── trading/
│   ├── crypto/         — Bybit (bybit-api): monitor, killswitch, report, state, config
│   ├── forex/          — cTrader/FIX4.4: client, fix-connection, monitor, trade, config
│   └── shared/         — types.ts, indicators.ts (EMA/RSI/ATR), risk.ts, index.ts
├── market/digest.ts    — RSS market digest (rss-parser)
└── utils/              — config.ts, logger.ts, telegram.ts, index.ts
```

## Агенты

```
User (Telegram) → orchestrator (event-driven, no heartbeat)
                    ├── forex-trader (heartbeat 10m, autonomous trading)
                    ├── crypto-trader (heartbeat 10m, autonomous trading)
                    ├── tech-lead (on-demand via sessions_send)
                    │     ├── backend-dev (on-demand)
                    │     └── frontend-dev (on-demand)
                    ├── qa-tester (on-demand via sessions_send)
                    └── market-analyst (on-demand via sessions_send)
```

- **orchestrator** — event-driven (NO heartbeat), маршрутизация задач, Telegram. Создаёт задачи, но НЕ меняет их статусы.
- **forex-trader / crypto-trader** — автономная торговля (heartbeat 10m), адаптивный режим (0-1 позиций = полный анализ, 2+ = лёгкий мониторинг), обязательный Telegram отчёт после каждого цикла
- **tech-lead / backend-dev / frontend-dev / qa-tester / market-analyst** — on-demand (без heartbeat), активируются только через sessions_send

## Ключевые npm скрипты

```bash
npm run build                  # tsc компиляция
npm run lint                   # ESLint src/
npm run test:run               # Vitest (все тесты)
npm run trade:crypto:monitor   # Bybit мониторинг
npm run trade:crypto:kill      # Killswitch (закрыть все крипто-позиции)
npm run trade:forex:monitor    # cTrader мониторинг
npm run market:digest          # RSS дайджест рынка
```

## Правила безопасности (КРИТИЧНО)

- **НИКОГДА** не коммитить реальные API ключи, токены, пароли
- Credentials только в `~/.openclaw/openclaw.json` или env vars
- В документации safe-формат: `7467…umn4` (скрыть 80%)
- `keys.md` в `.gitignore` — не коммитить

## Конвенции кода

- Импорты с расширением `.js` (ES Module требование)
- Логгер: `createLogger('module-name')` из `utils/logger.ts`
- Типы: использовать из `src/trading/shared/types.ts`
- Коммиты: `feat(crypto):`, `fix(forex):`, `refactor(shared):`, `test(indicators):`
- Перед коммитом: `npm run lint && npm run build`
