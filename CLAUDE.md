# OpenClaw AI Assistant

Мультиагентная система автоматизации торговли на платформе OpenClaw.
TypeScript/Node.js (ES Modules), Bybit (крипто) + cTrader FIX 4.4 (Forex).

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

## Торговые модули (запуск)

```bash
npm run trade:crypto:monitor   # Bybit мониторинг позиций
npm run trade:crypto:report    # Отчёт по крипто-позициям
npm run trade:crypto:kill      # СТОП: закрыть все крипто-позиции (необратимо!)
npm run trade:forex:monitor    # cTrader мониторинг
npm run trade:forex:trade      # cTrader ручная торговля
npm run market:digest          # RSS дайджест рынка
```

## Структура src/

```
src/
├── trading/
│   ├── crypto/         — Bybit: bybit-client.ts, monitor.ts, killswitch.ts, report.ts, state.ts, config.ts
│   ├── forex/          — cTrader FIX4.4: client.ts, fix-connection.ts, monitor.ts, trade.ts, config.ts
│   └── shared/         — types.ts, indicators.ts (EMA/RSI/ATR), risk.ts, index.ts
├── market/digest.ts    — RSS market digest
└── utils/              — config.ts, logger.ts, telegram.ts, args.ts, retry.ts, process.ts
```

## Конвенции кода

- **ES Module импорты** — расширение `.js` обязательно:
  ```typescript
  import { createLogger } from '../../utils/logger.js';   // ✅
  import { createLogger } from '../../utils/logger';      // ❌
  ```
- **Логгер**: `const log = createLogger('module-name')` из `../../utils/logger.js`
- **Типы**: все из `src/trading/shared/types.ts` (Position, OHLC, OrderParams, MarketAnalysis, TradingConfig...)
- **Конфиг**: `getBybitCredentials()`, `getForexConfig()` из `../../utils/config.js`
- **Ретрай**: `retryAsync(fn, { retries, backoffMs })` из `../../utils/retry.js`

## Безопасность (КРИТИЧНО)

- **НИКОГДА** не хардкодить API ключи, токены, пароли в коде
- Credentials → только `~/.openclaw/openclaw.json` или env vars
- В документации → safe-формат: `7467…umn4` (80% значения скрыть)
- `keys.md` в `.gitignore` — не коммитить
- Проверка утечек: `grep -r 'apiKey\s*=\s*"' src/`

## Технические индикаторы (src/trading/shared/indicators.ts)

```typescript
calculateEma(prices: number[], period: number): number[]
calculateRsi(prices: number[], period: number): number[]
calculateAtr(ohlc: OHLC[], period: number): number[]
buildMarketAnalysis(ohlc: OHLC[], meta): MarketAnalysis
```

Интерпретация `MarketAnalysis`:
- `bias.emaTrend: BULLISH` — цена выше EMA50 > EMA200
- `bias.rsiZone: OVERBOUGHT` — RSI > 70
- `marketInfo.fundingSignal: LONGS_OVERHEATED` — funding rate > 0.03%

## OpenClaw платформа

- Gateway: `ws://127.0.0.1:18789` | Config: `~/.openclaw/openclaw.json`
- Telegram: @hyrotraders_bot | Агенты: orchestrator, developer, qa-tester, analyst
- Skills: `skills/` (OpenClaw) vs `.claude/skills/` (Claude Code — разные системы!)
