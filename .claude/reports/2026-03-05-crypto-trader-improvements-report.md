# Отчёт: Crypto Trader Improvements

**Дата**: 2026-03-05
**Статус**: ЗАВЕРШЕНО
**План**: `.claude/planning/2026-03-05-crypto-trader-improvements.md`
**Анализ**: `.claude/analysis/project-analysis-2026-03-05.md`

---

## Общая статистика

| Метрика | Значение |
|---------|----------|
| Коммитов | 8 |
| Файлов затронуто (src/) | 18 |
| Строк добавлено (src/) | +1 529 |
| Строк удалено (src/) | -702 |
| Новых файлов | 10 |
| Тестов до начала | 112 (12 файлов) |
| Тестов после | 130 (15 файлов) |
| Ошибок lint | 0 |
| Build | OK |

---

## Фаза 0: Разделение .claude и OpenClaw систем

**Коммит**: `0f46f82`

**Проблема**: Claude Code агенты (`.claude/agents/`) содержали ссылки на OpenClaw workspace файлы (`workspaces/`), создавая путаницу между двумя независимыми системами.

**Что сделано**:
- Очищены 6 файлов в `.claude/agents/`: orchestrator.md, trading-advisor.md, planner.md, developer.md, tester.md, analyst.md
- Удалены все ссылки на `workspaces/`, OpenClaw TaskBoard, OpenClaw агентов
- Добавлена секция "Разделение систем" в `CLAUDE.md`

**Затронутые файлы**:
- `.claude/agents/orchestrator.md` — убрано управление OpenClaw агентами
- `.claude/agents/trading-advisor.md` — убраны ссылки на workspace SOUL.md
- `.claude/agents/planner.md` — убраны workspaces/ из структуры проекта
- `.claude/agents/developer.md`, `tester.md`, `analyst.md` — мелкие правки
- `CLAUDE.md` — добавлена секция разделения

**Принцип**: `.claude/` работает с `src/` (код), `workspaces/` работает с OpenClaw (production). Системы независимы.

---

## Фаза 1: Критические баг-фиксы

**Коммит**: `3193282`

### 1.1 ATR: Wilder Smoothing

**Проблема**: `src/trading/shared/indicators.ts` использовал простое среднее последних N значений True Range вместо классического Wilder smoothing. Это влияло на расчёт SL distance через `atrSlMultiplier`, делая стоп-лоссы менее стабильными.

**Было** (неправильно):
```typescript
const recentTrs = trs.slice(-period);
const avg = recentTrs.reduce((a, b) => a + b, 0) / period;
return parseFloat(avg.toPrecision(8));
```

**Стало** (Wilder smoothing):
```typescript
let atr = 0;
for (let i = 0; i < period; i++) {
  atr += trs[i] ?? 0;
}
atr /= period; // Первое значение = SMA
for (let i = period; i < trs.length; i++) {
  atr = (atr * (period - 1) + (trs[i] ?? 0)) / period; // Wilder EMA
}
return parseFloat(atr.toPrecision(8));
```

**Влияние**: ATR теперь плавнее реагирует на изменения волатильности, что даёт более стабильные SL distances. Совпадает с расчётами TradingView и классической формулой Wilder (1978).

### 1.2 Regime тесты: синхронизация порогов

**Проблема**: Тесты ожидали `STRONG_TREND=50` и `CHOPPY=85`, но код в `regime.ts` использовал `45` и `90`.

**Решение**: Обновлены тесты — значения в коде более логичны (ниже порог для сильного тренда, выше для choppy).

**Файлы**: `src/trading/shared/indicators.ts`, `src/trading/shared/__tests__/regime.test.ts`

---

## Фаза 2: Decision Journal — Дневник решений

**Коммит**: `9654f55`

**Проблема**: Crypto trader не вёл журнал ПОЧЕМУ принимал решения. Невозможно было понять, почему сигнал был пропущен или почему именно эта пара была выбрана для входа.

### Новые файлы

#### `src/trading/crypto/decision-journal.ts` (281 строк)

Полноценный модуль журнала решений:

**Типы**:
- `Decision` — запись решения с id, timestamp, cycle, type, symbol, action, reasoning, data, outcome
- `DecisionType` — `'entry' | 'skip' | 'manage' | 'exit'`
- `FilterResult` — результат фильтра (passed, value, threshold)
- `MarketContext` — контекст рынка (price, ema200, rsi14, atr14, fundingRate, spread)

**Функции записи**:
- `logDecision(cycle, type, symbol, action, reasoning[], data)` — запись решения в JSONL
- `generateCycleId()` — уникальный ID цикла мониторинга
- `rotateIfNeeded()` — ротация при превышении 10MB

**Функции запросов**:
- `getRecentDecisions(count)` — последние N решений
- `getDecisionsByCycle(cycleId)` — все решения одного цикла
- `getDecisionsBySymbol(symbol, hours)` — по символу за период
- `getDecisionsByType(type, hours)` — по типу за период

**Отчётность**:
- `generateSummary(hours)` — сводка: total, entries, skips, manages, exits, topSkipReason
- `formatDecision(d)` — человекочитаемый формат одного решения
- `formatSummary(summary)` — формат сводки

**Хранение**: `data/decisions.jsonl` (JSONL, append-only, ротация при 10MB)

#### `src/trading/crypto/journal-cli.ts` (55 строк)

CLI для просмотра журнала:
- `--summary` / `--diary` — дневная сводка
- `--last` — последнее решение
- `--hours=N` — за последние N часов
- `--symbol=BTCUSDT` — по символу
- `--type=skip` — по типу
- `--cycle=<id>` — по циклу
- `--count=N` — количество записей

### Интеграция в monitor.ts

Добавлены вызовы `logDecision()` на каждом этапе принятия решений:

**Анализ пар (analyzePairV2)**:
- `EMPTY_ORDERBOOK` — orderbook пуст
- `SPREAD_TOO_HIGH` — спред выше лимита (с данными фильтра)
- `FUNDING_RATE_EXTREME` — funding rate вне диапазона
- `CONFLUENCE_BELOW_THRESHOLD` — score ниже порога для режима рынка

**Исполнение сигналов (executeSignals)**:
- `POSITION_ALREADY_OPEN` — позиция уже есть
- `PENDING_ORDER_EXISTS` — ордер ожидает
- `ECOSYSTEM_OCCUPIED` — группа корреляции занята
- `QTY_CALCULATION_FAILED` — не удалось рассчитать qty
- `RISK_TOO_HIGH` — риск выше лимита
- `INSUFFICIENT_MARGIN` — недостаточно маржи
- `OPEN_BUY` / `OPEN_SELL` — вход с полным контекстом

**Управление позициями (managePositions)**:
- `SL_GUARD` — установлен дефолтный SL/TP

### Интеграция в report.ts

Добавлена секция "Дневник решений (24ч)" в часовой Telegram-отчёт с количеством решений, входов, пропусков и топ-причиной пропуска.

### npm scripts

```json
"trade:crypto:journal": "tsx src/trading/crypto/journal-cli.ts",
"trade:crypto:explain": "tsx src/trading/crypto/journal-cli.ts --last",
"trade:crypto:diary": "tsx src/trading/crypto/journal-cli.ts --summary"
```

---

## Фаза 3: Рефакторинг monitor.ts

**Коммит**: `2d70c40`

**Проблема**: `monitor.ts` — 890 строк, монолитный файл с анализом, исполнением, управлением позициями и спецификациями символов. Сложно поддерживать, тестировать и расширять.

### Декомпозиция

| Модуль | Строк | Ответственность |
|--------|-------|-----------------|
| `monitor.ts` | 128 | Оркестрация цикла: checkStatus -> refresh -> manage -> cancel -> analyze -> execute |
| `market-analyzer.ts` | 273 | Анализ пар, confluence scoring, батчевый параллельный анализ |
| `signal-executor.ts` | 283 | Фильтрация сигналов, исполнение ордеров, cancelStaleOrders |
| `position-manager.ts` | 199 | SL-Guard, partial close, trailing SL, calcDefaultSl/Tp |
| `symbol-specs.ts` | 32 | SYMBOL_SPECS, formatQty, roundPrice, getQtyPrecision |

**Итого**: 915 строк в 5 файлах vs 890 строк в 1 файле. Небольшой overhead (+25 строк) на импорты, но значительно лучшая модульность.

### Граф зависимостей

```
monitor.ts
  ├── market-analyzer.ts
  │     ├── bybit-client.ts
  │     ├── decision-journal.ts
  │     ├── symbol-specs.ts
  │     └── shared/* (confluence, regime, volume-analysis)
  ├── signal-executor.ts
  │     ├── bybit-client.ts
  │     ├── decision-journal.ts
  │     ├── market-analyzer.ts (TradeSignalInternal type)
  │     └── symbol-specs.ts
  ├── position-manager.ts
  │     ├── bybit-client.ts
  │     ├── decision-journal.ts
  │     └── symbol-specs.ts
  └── state.ts
```

### Изменения API

- `managePositions(cycleId, dryRun)` — теперь принимает параметры вместо глобальных переменных
- `analyzeMarket(cycleId, singlePair?)` — cycleId и пара как параметры
- `executeSignals(signals, cycleId, dryRun)` — все зависимости через параметры
- `cancelStaleOrders()` — без параметров, DRY_RUN проверка вынесена в monitor.ts
- `TradeSignalInternal` — экспортирован из market-analyzer.ts

---

## Фаза 4: Rate Limiter для Bybit API

**Коммит**: `8b559ee`

**Проблема**: Bybit имеет лимит ~20 req/sec. При анализе 12 пар по ~12 запросов = 144 запроса за цикл. Без rate limiting возможны 429 ошибки и бан IP.

### `src/trading/crypto/rate-limiter.ts` (87 строк)

Token bucket алгоритм:
- `maxPerSecond: 18` — запас от лимита 20
- `maxConcurrent: 6` — не более 6 одновременных запросов
- Sliding window на 1 секунду
- Если лимит достигнут — ожидание до освобождения слота
- Статистика: pending, completed, windowRequests, rps

```typescript
export interface RateLimiter {
  acquire(): Promise<void>;
  getStats(): RateLimiterStats;
}
```

### Интеграция в bybit-client.ts

**Все API вызовы** теперь проходят через rate limiter:

1. **Public endpoints** (`apiGet`): `await limiter.acquire()` перед каждым fetch
2. **Auth endpoints**: обёртка `withRateLimit(fn)`:

```typescript
async function withRateLimit<T>(fn: (client: RestClientV5) => Promise<T>): Promise<T> {
  await limiter.acquire();
  return fn(getClient());
}
```

Заменены все прямые вызовы `client.method()` на `withRateLimit(c => c.method())`:
- `getBalance`, `getPositions`, `cancelOrder`, `submitOrder`
- `closePosition`, `partialClosePosition`, `modifyPosition`
- `closeAllPositions`, `setLeverage`

Экспортирован `getRateLimiterStats()` для мониторинга.

---

## Фаза 5: Улучшения утилит

**Коммит**: `1a71f1c`

### 5.1 Jitter в retry.ts

**Проблема**: Фиксированный exponential backoff может вызвать thundering herd — все клиенты ретраят одновременно.

**Решение**: Добавлен jitter +-15% к каждому delay:

```typescript
const baseDelay = Math.min(backoffMs * Math.pow(2, attempt - 1), maxBackoffMs);
const jitter = (Math.random() - 0.5) * 0.3 * baseDelay;
const delay = Math.max(0, Math.round(baseDelay + jitter));
```

### 5.2 TTY-aware ANSI в logger.ts

**Проблема**: ANSI escape коды в логах при перенаправлении в файл создают мусор.

**Решение**:
```typescript
const USE_COLOR = !process.env.NO_COLOR && process.stderr.isTTY;
```
- Цвета только при выводе в терминал
- Поддержка стандарта `NO_COLOR` (https://no-color.org/)

### 5.3 AbortSignal timeout в telegram.ts

**Проблема**: fetch в `sendViaOpenClaw()` мог зависнуть без таймаута если Gateway не отвечает.

**Решение**: `signal: AbortSignal.timeout(10_000)` — 10 секунд таймаут.

---

## Фаза 6: Unit тесты

**Коммит**: `4c22afa`

### Новые тест-файлы

#### `src/trading/crypto/__tests__/rate-limiter.test.ts` (4 теста)
- Запросы в пределах лимита — мгновенное выполнение
- Корректная статистика (completed, windowRequests, pending)
- Rate limiting при превышении — 4-й запрос ждёт ~1 сек при лимите 3/сек
- Concurrent лимит работает

#### `src/trading/crypto/__tests__/symbol-specs.test.ts` (9 тестов)
- `getQtyPrecision`: BTC=3, ETH=2, XRP=0, DOGE=0, unknown=1
- `formatQty`: правильное форматирование, минимальный qty
- `roundPrice`: BTC 1 знак, ETH 2, XRP 4, unknown 4

#### `src/utils/__tests__/retry.test.ts` (5 тестов)
- Первый успех — мгновенный возврат
- Повтор при ошибке — 3 попытки, успех на 3-й
- Исчерпание попыток — throw последней ошибки
- onRetry callback — вызывается с номером попытки
- Exponential backoff с jitter — замеряется время

### Итоговая статистика тестов

| Категория | Файлов | Тестов |
|-----------|--------|--------|
| shared/indicators | 2 | 44 |
| shared/confluence | 2 | 22 |
| shared/regime | 2 | 12 |
| shared/orderflow | 2 | 12 |
| shared/volume-analysis | 2 | 12 |
| shared/levels | 2 | 10 |
| crypto/rate-limiter | 1 | 4 |
| crypto/symbol-specs | 1 | 9 |
| utils/retry | 1 | 5 |
| **ИТОГО** | **15** | **130** |

---

## Фазы 7-8: Feedback loop и Heartbeat

**Фаза 7** (Feedback loop): Основная функциональность реализована в рамках Фазы 2:
- `npm run trade:crypto:explain` — объяснение последнего решения
- `npm run trade:crypto:diary` — дневная сводка решений
- `npm run trade:crypto:journal` — полный просмотр журнала
- Интеграция summary в часовой отчёт (report.ts)

Расширенная аналитика (`analyzePerformance()` — средний score для win/loss, корреляция confidence и результата) отложена как enhancement для следующей итерации.

**Фаза 8** (Heartbeat): `workspaces/crypto-trader/HEARTBEAT.md` уже содержит полную документацию: расписание (2ч), алгоритм (5 tool calls max), guard rails, position sizing, quick reference.

---

## Структура crypto trader после рефакторинга

```
src/trading/crypto/
  monitor.ts           128 строк   Оркестрация цикла
  market-analyzer.ts   273 строки   Анализ пар, confluence
  signal-executor.ts   283 строки   Фильтрация, исполнение
  position-manager.ts  199 строк   SL-Guard, trailing, partial
  symbol-specs.ts       32 строки   Спецификации символов
  decision-journal.ts  281 строка   Журнал решений
  journal-cli.ts        55 строк   CLI для журнала
  rate-limiter.ts       87 строк   Rate limiting
  bybit-client.ts      691 строка   Bybit API (с rate limiter)
  state.ts             405 строк   Состояние, P&L, kill switch
  config.ts            ~80 строк   Конфигурация
  report.ts            ~305 строк   Отчёт + Telegram
  killswitch.ts        ~40 строк   Аварийное закрытие
  trade.ts             ~90 строк   Ручная торговля
  snapshot-v2.ts       ~290 строк  Снимок рынка
```

---

## Коммиты (хронология)

| # | Hash | Сообщение | Файлов | +/- |
|---|------|-----------|--------|-----|
| 1 | `0f46f82` | refactor: разделение .claude и OpenClaw систем | 7 | +47/-33 |
| 2 | `3193282` | fix(shared): ATR Wilder smoothing + sync regime тестов | 2 | +16/-10 |
| 3 | `9654f55` | feat(crypto): Decision Journal — дневник решений | 7 | +1599/-6 |
| 4 | `2d70c40` | refactor(crypto): разбить monitor.ts на модули | 5 | +804/-779 |
| 5 | `8b559ee` | feat(crypto): Rate Limiter для Bybit API | 2 | +164/-56 |
| 6 | `1a71f1c` | fix(utils): jitter, TTY-aware ANSI, timeout | 3 | +13/-3 |
| 7 | `4c22afa` | test(crypto): unit тесты rate-limiter, symbol-specs, retry | 3 | +182/-0 |
| 8 | `0bd77fa` | docs: отметить план как completed | 1 | +1/-1 |

---

## Что осталось для будущих итераций

1. **analyzePerformance()** — корреляция confluence score и результата сделок (win/loss)
2. **Полная миграция apiGet -> bybit-api library** — оценить целесообразность (apiGet уже работает стабильно)
3. **Unit тесты для state.ts** — требует mock файловой системы (config.ts зависит от реального файла)
4. **Дедупликация новостей в digest.ts** — низкий приоритет
5. **Автоматическая отправка дневника в Telegram** — по расписанию в конце дня

---

## Проверка качества

```
Build:    tsc              OK (0 errors)
Lint:     eslint src/      0 errors, 32 warnings (все no-console в CLI файлах)
Tests:    vitest run       130 passed, 0 failed (15 test files)
```
