# Tester Agent Memory — openclaw-assistent

## Статус тестов (последний аудит: 2026-03-05)

- 150 тестов в 18 файлах (9 src + 9 dist-дубли), все зелёные
- `npm run build` — без ошибок TypeScript
- `npm run lint` — 0 errors, 33 warnings (console.log в Forex/CLI файлах)
- `npm run test:run` — все проходят

## Покрытые модули (src/)

| Файл | Тест |
|------|------|
| src/trading/shared/indicators.ts | __tests__/indicators.test.ts (22 теста) |
| src/trading/shared/confluence.ts | __tests__/confluence.test.ts (11 тестов) |
| src/trading/shared/regime.ts | __tests__/regime.test.ts (6 тестов) |
| src/trading/shared/levels.ts | __tests__/levels.test.ts (5 тестов) |
| src/trading/shared/orderflow.ts | __tests__/orderflow.test.ts (6 тестов) |
| src/trading/shared/volume-analysis.ts | __tests__/volume-analysis.test.ts (6 тестов) |
| src/trading/crypto/rate-limiter.ts | __tests__/rate-limiter.test.ts (5 тестов) |
| src/trading/crypto/symbol-specs.ts | __tests__/symbol-specs.test.ts (9 тестов) |
| src/utils/retry.ts | __tests__/retry.test.ts (5 тестов) |

## КРИТИЧЕСКИ НЕ ПОКРЫТЫ (приоритет 1)

- `src/trading/shared/risk.ts` — calculatePositionSize, canTrade, isValidRiskReward
- `src/trading/crypto/state.ts` — recordTrade, checkDayLimits, canTrade, calcPositionSize
- `src/trading/crypto/signal-executor.ts` — executeSignals (фильтры: ecosystem, SL/TP, margin)
- `src/trading/crypto/position-manager.ts` — calcDefaultSl, calcDefaultTp, managePositions

## НЕ ПОКРЫТЫ (приоритет 2-3)

- `src/trading/crypto/config.ts` — defaults
- `src/trading/crypto/decision-journal.ts`
- `src/trading/crypto/market-analyzer.ts`
- `src/trading/forex/config.ts`
- `src/utils/config.ts`
- `src/utils/logger.ts`

## Важные паттерны для тестов

- state.ts использует fs напрямую → мокировать через `vi.mock('node:fs')` или tmpdir
- signal-executor зависит от bybit-client и state → `vi.mock('./bybit-client.js')` + `vi.mock('./state.js')`
- position-manager зависит от bybit-client → `vi.mock('./bybit-client.js')`
- risk.ts — чистые функции, моки не нужны
- Vitest в проекте настроен для ES Modules, импорты с `.js`
- dist/ тесты — дубли src/ тестов (артефакты build), не добавлять новые там

## Lint замечания

- 33 warning — console.log в Forex/CLI/logger файлах (допустимо для CLI)
- 1 unused eslint-disable в bot.ts (строка 190)
- Не блокируют CI, но желательно исправить в logger.ts (там должен быть createLogger)
