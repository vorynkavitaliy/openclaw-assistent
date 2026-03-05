# Crypto Trading Bot

Автоматическая торговля криптовалютами на Bybit + Forex через cTrader FIX 4.4.
TypeScript/Node.js (ES Modules). Управление через Telegram бот.

## Язык общения

Все ответы, документация, комментарии в коде и коммиты — **на русском языке**.

## Архитектура

```
Telegram Bot (src/bot.ts) — принимает команды /start, /stop, /status, /report
    ↓
System Cron (*/5) → monitor.ts — анализ рынка каждые 5 мин (бесплатно)
    ↓
LLM Advisor (event-driven) — вызывается ТОЛЬКО при наличии сигналов
    ↓
Signal Executor → Bybit API — исполнение ордеров
```

## Сборка и проверка качества

```bash
npm run build          # tsc компиляция → dist/
npm run typecheck      # проверка типов без сборки
npm run lint           # ESLint src/
npm run lint:fix       # ESLint с автоисправлением
npm run format         # Prettier форматирование
npm run test:run       # Vitest (все тесты, однократно)
npm run test           # Vitest watch mode
```

Перед коммитом: `npm run lint && npm run build`
Коммит-формат: `feat(crypto):`, `fix(forex):`, `refactor(shared):`, `test(indicators):`

## Запуск

```bash
npm run bot                    # Telegram бот (long polling)
npm run trade:crypto:monitor   # Ручной запуск мониторинга
npm run trade:crypto:report    # Отчёт по крипто-позициям
npm run trade:crypto:kill      # СТОП: закрыть все позиции (необратимо!)
npm run trade:forex:monitor    # cTrader мониторинг
npm run market:digest          # RSS дайджест рынка

# Управление трейдером через скрипты
bash scripts/trading_control.sh start crypto-trader   # Создать cron */5
bash scripts/trading_control.sh stop crypto-trader    # Убрать cron
bash scripts/trading_control.sh status                # Статус
```

## Структура src/

```
src/
├── bot.ts              — Telegram бот (polling, команды /start /stop /status /report)
├── trading/
│   ├── crypto/         — Bybit: bybit-client.ts, monitor.ts, killswitch.ts, report.ts, state.ts, config.ts
│   ├── forex/          — cTrader FIX4.4: client.ts, fix-connection.ts, monitor.ts, trade.ts, config.ts
│   └── shared/         — types.ts, indicators.ts (EMA/RSI/ATR), risk.ts, confluence.ts, regime.ts
├── market/digest.ts    — RSS market digest
└── utils/              — config.ts, logger.ts, telegram.ts, env.ts, args.ts, retry.ts, process.ts
```

## Конвенции кода

Детальные правила — в `.claude/rules/`. Ключевые:

- **ES Module импорты** — расширение `.js` обязательно:
  ```typescript
  import { createLogger } from '../../utils/logger.js';   // OK
  import { createLogger } from '../../utils/logger';      // ОШИБКА
  ```
- **Логгер**: `const log = createLogger('module-name')` из `../../utils/logger.js`
- **Типы**: все из `src/trading/shared/types.ts` (Position, OHLC, OrderParams, MarketAnalysis...)
- **Конфиг**: `getBybitCredentials()` из `../../utils/config.js`
- **Ретрай**: `retryAsync(fn, { retries, backoffMs })` из `../../utils/retry.js`
- **Strict TypeScript**: `noUnusedLocals`, `noImplicitReturns`, `noUncheckedIndexedAccess`

## Credentials

- `.env` в корне проекта (НЕ коммитить!) — TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, OPENROUTER_API_KEY
- `~/.openclaw/credentials.json` — Bybit API keys, cTrader FIX credentials
- **НИКОГДА** не хардкодить API ключи, токены, пароли в коде
- Проверка утечек: `grep -r 'apiKey\s*=\s*"' src/`

## Технические индикаторы (src/trading/shared/indicators.ts)

```typescript
calculateEma(prices: number[], period: number): number[]
calculateRsi(prices: number[], period: number): number[]
calculateAtr(ohlc: OHLC[], period: number): number[]
buildMarketAnalysis(ohlc: OHLC[], meta): MarketAnalysis
```

## Контекстные файлы

- Архитектура: @.github/docs/architecture.md
- Правила код-ревью: @.github/docs/rules/code-review.md
- Правила безопасности: @.github/docs/rules/security.md
