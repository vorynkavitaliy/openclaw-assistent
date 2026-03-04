# Tech Lead — MEMORY.md

Долгосрочная память технического лидера. Обновляется по мере накопления опыта.

## Стек проекта OpenClaw AI Assistant

- **Runtime**: Node.js ≥22, TypeScript 5.x, ES Modules
- **Build**: `npm run build` → tsc → `dist/`
- **Test**: Vitest (`npm run test:run`)
- **Lint**: ESLint + Prettier (`npm run lint`, `npm run lint:fix`)
- **Imports**: расширение `.js` обязательно в TS (ES Module convention)

## Структура проекта

```
src/
├── trading/
│   ├── crypto/     — Bybit: monitor.ts, bybit-client.ts, state.ts, config.ts
│   ├── forex/      — cTrader FIX4.4: monitor.ts, trade.ts, client.ts
│   └── shared/     — types.ts, indicators.ts, confluence.ts, risk.ts
├── market/         — digest.ts (RSS)
└── utils/          — logger.ts, config.ts, telegram.ts, retry.ts
```

## Ключевые соглашения

- Logger: `createLogger('module-name')` — `console.log` запрещён
- Типы: всё из `src/trading/shared/types.ts`
- Конфиг credentials: `~/.openclaw/openclaw.json` через `utils/config.ts`
- Retry: `retryAsync(fn, { retries, backoffMs })` из `utils/retry.js`
- Strict TypeScript: `noUnusedLocals`, `noImplicitReturns`, `noUncheckedIndexedAccess`

## Архитектурные решения

- **Bybit Client**: функциональный стиль (не класс), каждая функция = отдельный API вызов
- **Monitor**: цикл анализа + исполнения, state management через `state.ts`
- **Confluence scoring**: модульная система весов (-100..+100)
- **Indicators**: чистые функции, принимают массивы OHLC

## Pre-commit чеклист

```bash
npm run lint && npm run build
```

Формат коммита: `feat(crypto):`, `fix(forex):`, `refactor(shared):`, `test(indicators):`

## Команды QA

```bash
npm run lint            # ESLint
npm run typecheck       # TypeScript без сборки
npm run build           # Full build
npm run test:run        # Все тесты однократно
```

## Уроки и инсайты

- При добавлении нового поля в TradingConfig — добавлять в оба: `types.ts` + `config.ts`
- Bybit API: стоимость символов (qty/price precision) хардкодится в `SYMBOL_SPECS` в `monitor.ts`
- Confluence система легко расширяется: добавить новый компонент в scoring + вес в конфиг
- ES Module + `noUncheckedIndexedAccess`: всегда проверять что массивы не пустые перед `[0]`
- Telegram notifications: `utils/telegram.ts` — использовать для важных событий
