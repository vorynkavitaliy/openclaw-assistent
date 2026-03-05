---
type: plan
title: "Crypto Trader: баг-фиксы, рефакторинг и дневник решений"
date: 2026-03-05
status: active
priority: high
complexity: XL
scope: crypto-trader
---

# План: Crypto Trader — баг-фиксы, рефакторинг и дневник решений

## Контекст

По результатам полного анализа проекта (`.claude/analysis/project-analysis-2026-03-05.md`)
выявлены критические баги, технический долг и отсутствие системы аналитики решений.

Этот план — первый скоуп работ, фокус на crypto trader.

## Принцип разделения

- `.claude/` — Claude Code, инструменты РАЗРАБОТКИ проекта
- `workspaces/` + `openclaw.json` — OpenClaw, PRODUCTION система агентов
- Эти системы НЕЗАВИСИМЫ. `.claude/agents/` НЕ ссылается на `workspaces/` и наоборот

---

## Фаза 0: Разделение .claude и OpenClaw

### Задача

Убрать из `.claude/agents/*.md` все ссылки на OpenClaw workspaces. Claude Code агенты
работают с исходным кодом (`src/`), а не с конфигурацией OpenClaw (`workspaces/`).

### Шаги

- [ ] **0.1** Аудит файлов `.claude/agents/*.md` — найти все ссылки на `workspaces/`
- [ ] **0.2** `orchestrator.md` — убрать управление OpenClaw агентами, оставить только
      координацию разработки (декомпозиция задач, делегирование developer/tester/planner)
- [ ] **0.3** `trading-advisor.md` — убрать прямые ссылки на `workspaces/crypto-trader/SOUL.md`
      и т.п. Советник работает с кодом в `src/trading/`, а не с workspace файлами
- [ ] **0.4** `planner.md` — убрать "OpenClaw агенты" из структуры проекта, оставить `src/`
- [ ] **0.5** `developer.md`, `tester.md`, `analyst.md` — проверить и очистить
- [ ] **0.6** `.claude/rules/*.md` — проверить, убрать ссылки на OpenClaw workspace
- [ ] **0.7** Добавить в CLAUDE.md явную секцию "Разделение систем"

**Критерий готовности**: `grep -r "workspaces/" .claude/agents/ .claude/rules/` возвращает 0 результатов.

**Оценка**: ~1 час

---

## Фаза 1: Критические баг-фиксы

### 1.1 ATR — исправить формулу (Wilder smoothing)

**Проблема**: `indicators.ts:279-302` использует простое среднее последних N значений TR
вместо Wilder smoothing (как RSI/ADX). Это влияет на расчёт SL distance через `atrSlMultiplier`.

**Исправление**:
```typescript
// БЫЛО: simple average
const recentTrs = trs.slice(-period);
return recentTrs.reduce((a, b) => a + b, 0) / period;

// ДОЛЖНО БЫТЬ: Wilder smoothing
let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
for (let i = period; i < trs.length; i++) {
  atr = (atr * (period - 1) + (trs[i] ?? 0)) / period;
}
return atr;
```

- [ ] **1.1.1** Исправить `calculateAtr()` в `src/trading/shared/indicators.ts`
- [ ] **1.1.2** Обновить тест `indicators.test.ts` — проверить ATR с эталонными значениями TradingView
- [ ] **1.1.3** Проверить что SL расстояния в monitor.ts остаются разумными

**Оценка**: 30 мин

### 1.2 Тесты regime — синхронизация порогов

**Проблема**: `regime.ts` возвращает STRONG_TREND=45, CHOPPY=90, но тесты ожидают 50 и 85.

- [ ] **1.2.1** Обновить тесты в `regime.test.ts` чтобы соответствовали текущим значениям в коде
      (значения в коде более логичны: lower threshold для сильного тренда, higher для choppy)
- [ ] **1.2.2** Убедиться что все 112 тестов проходят (`npm run test:run`)

**Оценка**: 15 мин

---

## Фаза 2: Дневник решений (Decision Journal)

### Концепция

Crypto trader должен вести полный дневник ВСЕХ решений — не только выполненных, но и
отклонённых. Это позволит:
- Анализировать ПОЧЕМУ трейдер сделал именно так
- Учиться на отклонённых сигналах
- По запросу дать отчёт с обоснованием каждого решения
- Улучшать стратегию на основе ретроспективного анализа

### Новые типы событий

Текущие события в `state.ts`:
- `order_opened`, `trade`, `sl_guard`, `partial_close`, `trailing_sl`, `monitor`, `report`

Добавить:
- `signal_rejected` — сигнал отклонён (с полным reasoning)
- `filter_blocked` — пара заблокирована фильтром (spread, funding, ecosystem)
- `analysis_summary` — итог анализа пары (даже если нет сигнала)
- `decision` — обобщённое решение цикла с reasoning

### Шаги

- [ ] **2.1** Создать `src/trading/crypto/decision-journal.ts` — новый модуль

```typescript
interface Decision {
  id: string;                    // uuid
  timestamp: string;
  cycle: string;                 // ID цикла мониторинга
  type: 'entry' | 'skip' | 'manage' | 'exit';
  symbol: string;
  action: string;                // 'OPEN_LONG' | 'SKIP_SPREAD' | 'PARTIAL_CLOSE' | ...
  reasoning: string[];           // Массив причин, почему принято это решение
  data: {
    confluenceScore?: number;
    confluenceSignal?: string;
    confidence?: number;
    regime?: string;
    filters?: Record<string, { passed: boolean; value: string; threshold: string }>;
    marketContext?: {
      price: number;
      ema200?: number;
      rsi14?: number;
      atr14?: number;
      fundingRate?: number;
      spread?: number;
    };
  };
  outcome?: {                    // Заполняется post-factum
    pnl?: number;
    result?: 'win' | 'loss' | 'breakeven';
    hindsight?: string;          // Что бы сделал иначе (для обучения)
  };
}
```

- [ ] **2.2** Функции журнала:
  - `logDecision(decision)` — записать решение в JSONL файл
  - `getDecisionsBySymbol(symbol, hours?)` — все решения по символу
  - `getDecisionsByCycle(cycleId)` — все решения одного цикла
  - `getRecentDecisions(count)` — последние N решений
  - `generateDecisionReport(hours?)` — краткий отчёт по решениям

- [ ] **2.3** Интегрировать в `monitor.ts`:
  - В начале каждого цикла — генерировать `cycleId`
  - После каждого фильтра — если пара отклонена, `logDecision(type='skip')`
  - После confluence scoring — если score < threshold, `logDecision(type='skip')` с reasoning
  - При открытии позиции — `logDecision(type='entry')` с полным контекстом
  - При управлении позицией — `logDecision(type='manage')` с reasoning
  - При отклонении сигнала (max positions, ecosystem) — `logDecision(type='skip')`

- [ ] **2.4** Интегрировать в `report.ts`:
  - Добавить секцию "Решения за цикл" в Telegram отчёт
  - Показать: сколько пар проанализировано, сколько отклонено (по причинам), сколько выполнено
  - По каждому выполненному — краткое reasoning (1-2 строки)

- [ ] **2.5** CLI для анализа журнала:
  - `npm run trade:crypto:journal` — вывод последних решений
  - `--hours=24` — за последние N часов
  - `--symbol=BTCUSDT` — по символу
  - `--type=skip` — только отклонённые

**Оценка**: 4-5 часов

---

## Фаза 3: Рефакторинг monitor.ts

### Цель

Разбить 747-строчный файл на модули с чёткой ответственностью.

### Новая структура

```
src/trading/crypto/
├── monitor.ts              — Оркестрация цикла (entry point, ~100 строк)
├── position-manager.ts     — SL-Guard, partial close, trailing SL (~150 строк)
├── market-analyzer.ts      — Анализ пар, генерация сигналов (~200 строк)
├── signal-executor.ts      — Фильтрация и исполнение сигналов (~150 строк)
├── symbol-specs.ts         — SYMBOL_SPECS, formatQty, roundPrice (~50 строк)
├── decision-journal.ts     — Из Фазы 2
└── ... (остальные файлы без изменений)
```

### Шаги

- [ ] **3.1** Извлечь `symbol-specs.ts`:
  - `SYMBOL_SPECS` объект
  - `formatQty()`, `roundPrice()`, `getQtyPrecision()`

- [ ] **3.2** Извлечь `position-manager.ts`:
  - `managePositions()` — SL-Guard, partial close, trailing SL
  - `calcDefaultSl()`, `calcDefaultTp()`
  - Импортирует: bybit-client, state, config, symbol-specs, decision-journal

- [ ] **3.3** Извлечь `market-analyzer.ts`:
  - `analyzeMarket()` — параллельный анализ всех пар
  - `analyzePairV2()` — анализ одной пары
  - Импортирует: bybit-client, config, shared/*, decision-journal

- [ ] **3.4** Извлечь `signal-executor.ts`:
  - `executeSignals()` — фильтрация и открытие позиций
  - `cancelStaleOrders()`
  - `getEcosystemGroup()`
  - Импортирует: bybit-client, state, config, symbol-specs, decision-journal

- [ ] **3.5** Обновить `monitor.ts`:
  - Только оркестрация: checkStatus → refresh → manage → analyze → cancel → execute
  - Импортирует: position-manager, market-analyzer, signal-executor, state

- [ ] **3.6** Проверить что всё компилируется (`npm run build`)

- [ ] **3.7** Прогнать тесты (`npm run test:run`)

**Оценка**: 3-4 часа

---

## Фаза 4: Унификация Bybit API клиента + Rate Limiter

### 4.1 Унификация API

**Проблема**: Два способа доступа — `apiGet()` (прямой fetch) и `getClient()` (bybit-api library).

- [ ] **4.1.1** Проанализировать какие endpoints используют `apiGet()`, какие `getClient()`
- [ ] **4.1.2** Перевести ВСЁ на `bybit-api` library (она уже обрабатывает auth, timestamps)
- [ ] **4.1.3** Удалить `apiGet()`, `API_BASE`, прямые fetch вызовы
- [ ] **4.1.4** Обновить все функции: getKlines, getMarketInfo, getOrderbook, getOIHistory,
      getFundingHistory, getRecentTrades

### 4.2 Rate Limiter

**Проблема**: Bybit лимит 20 req/sec. При анализе 12 пар × ~12 запросов = 144 запроса.

- [ ] **4.2.1** Создать `src/trading/crypto/rate-limiter.ts`:

```typescript
interface RateLimiter {
  acquire(): Promise<void>;  // Ждёт пока слот свободен
  getStats(): { pending: number; completed: number; rps: number };
}

function createRateLimiter(options: {
  maxPerSecond: number;     // 18 (оставляем запас от 20)
  maxConcurrent?: number;   // 5
}): RateLimiter;
```

- [ ] **4.2.2** Интегрировать в bybit-client.ts — каждый API вызов проходит через `limiter.acquire()`
- [ ] **4.2.3** Добавить логирование rate limiter stats в monitor events

**Оценка**: 3-4 часа

---

## Фаза 5: Улучшения утилит

### 5.1 Jitter в retry.ts

- [ ] **5.1.1** Добавить jitter в exponential backoff:
```typescript
const jitter = Math.random() * 0.3 * delay; // ±15% jitter
await sleep(delay + jitter - jitter/2);
```

### 5.2 TTY-aware ANSI коды в logger

- [ ] **5.2.1** Проверять `process.stderr.isTTY` перед добавлением ANSI цветов
- [ ] **5.2.2** Env var `NO_COLOR=1` для принудительного отключения

### 5.3 AbortController таймауты для fetch

- [ ] **5.3.1** В `telegram.ts` — добавить AbortController с 10s таймаутом
- [ ] **5.3.2** В `bybit-client.ts` — убедиться что все fetch имеют таймаут

### 5.4 Дедупликация новостей в digest

- [ ] **5.4.1** Дедупликация по `link` или `title` в `digest.ts`

### 5.5 XML parser вместо regex в digest

- [ ] **5.5.1** Оценить добавление `fast-xml-parser` как dev dependency
- [ ] **5.5.2** Если слишком тяжело — оставить regex но добавить try-catch и fallback

**Оценка**: 2-3 часа

---

## Фаза 6: Unit тесты для crypto/ и utils/

### Приоритет тестирования

1. `state.ts` — checkDayLimits, canTrade, calcPositionSize, resetDaily
2. `risk.ts` — calculatePositionSize, isValidRiskReward (уже в shared, но 0 тестов)
3. `decision-journal.ts` — logDecision, getDecisionsBySymbol
4. `rate-limiter.ts` — acquire, concurrency
5. `utils/retry.ts` — exponential backoff, jitter
6. `utils/config.ts` — загрузка credentials, fallbacks

### Шаги

- [ ] **6.1** Создать `src/trading/crypto/__tests__/state.test.ts`
- [ ] **6.2** Создать `src/trading/shared/__tests__/risk.test.ts`
- [ ] **6.3** Создать `src/trading/crypto/__tests__/decision-journal.test.ts`
- [ ] **6.4** Создать `src/trading/crypto/__tests__/rate-limiter.test.ts`
- [ ] **6.5** Создать `src/utils/__tests__/retry.test.ts`
- [ ] **6.6** Создать `src/utils/__tests__/config.test.ts`
- [ ] **6.7** Убедиться что все тесты проходят (`npm run test:run`)

**Оценка**: 3-4 часа

---

## Фаза 7: Feedback loop и отчётность по действиям

### 7.1 Отчёт по требованию

Crypto trader должен по требованию дать ответ ПОЧЕМУ он решил сделать именно так.

- [ ] **7.1.1** Добавить CLI команду `npm run trade:crypto:explain`:
  - `--last` — объяснить последнее решение
  - `--symbol=BTCUSDT` — объяснить решения по символу за последние 24h
  - `--cycle=<id>` — объяснить все решения одного цикла

- [ ] **7.1.2** Формат вывода:
```
=== Решение: OPEN LONG BTCUSDT ===
Время: 2026-03-05 14:30:00 UTC
Цикл: cycle-abc123

ПОЧЕМУ ВОШЛИ:
  - Confluence Score: +67 (LONG)
  - Режим рынка: WEAK_TREND (порог: 60)
  - Confidence: 85%
  - Trend: BULLISH (D1+H1 aligned)
  - RSI14: 42 (зона входа для лонга)
  - Funding: 0.01% (нейтральный)

ФИЛЬТРЫ (все прошли):
  + Spread: 0.03% < 0.1% (OK)
  + Funding rate: 0.01% в диапазоне (OK)
  + Экосистема: BTC группа свободна (OK)
  + Маржа: $150 required, $2400 available (OK)

ПАРАМЕТРЫ СДЕЛКИ:
  Entry: $67,450 (Limit)
  SL: $66,200 (ATR×1.5 = $1,250)
  TP: $70,000 (RR = 2.04)
  Qty: 0.022 BTC
  Риск: 1.8% ($43.5)

=== Решения SKIP этого цикла ===
  ETHUSDT: SKIP — confluence 28 < threshold 60 (WEAK_TREND)
  SOLUSDT: SKIP — spread 0.15% > 0.1%
  XRPUSDT: SKIP — ecosystem occupied (XRP group: ADAUSDT open)
```

### 7.2 Дневник трейдера (daily summary)

- [ ] **7.2.1** В конце торгового дня (или по запросу) — генерировать дневник:
```
=== Дневник Crypto Trader: 2026-03-05 ===

ИТОГ ДНЯ:
  Циклов мониторинга: 12
  Пар проанализировано: 144 (12 × 12 пар)
  Сигналов найдено: 8
  Сигналов выполнено: 3
  Сигналов отклонено: 5

ПРИЧИНЫ ОТКЛОНЕНИЙ:
  Confluence < threshold: 3
  Ecosystem occupied: 1
  Max positions reached: 1

ВЫПОЛНЕННЫЕ СДЕЛКИ:
  1. BTCUSDT LONG +$45.20 (WIN) — confluence 67, confidence 85%
  2. ETHUSDT SHORT -$22.10 (LOSS) — confluence 52, confidence 62%
  3. SOLUSDT LONG +$12.30 (WIN) — confluence 71, confidence 88%

УРОКИ ДНЯ:
  - ETHUSDT short при confluence 52 оказался убыточным (ниже threshold 60 для WEAK_TREND)
  - BTC и SOL лонги при confidence > 80% дали прибыль
  - Рекомендация: повысить минимальный confidence до 75%
```

- [ ] **7.2.2** Добавить `npm run trade:crypto:diary` — генерация дневника
- [ ] **7.2.3** Автоматическая отправка дневника в Telegram в конце дня (опционально)

### 7.3 Обучение на истории

- [ ] **7.3.1** Добавить в `decision-journal.ts` функцию `analyzePerformance()`:
  - Средний confluence score для win vs loss trades
  - Средний confidence для win vs loss
  - Какие фильтры чаще всего блокируют (и правильно ли)
  - Какие режимы рынка наиболее прибыльны
  - Рекомендации по корректировке параметров

**Оценка**: 4-5 часов

---

## Фаза 8: Heartbeat механизм (документация)

### Задача

Явно задокументировать как работает heartbeat для crypto trader в OpenClaw.

- [ ] **8.1** Создать `workspaces/crypto-trader/HEARTBEAT.md` (если нет) или обновить:
  - Расписание: каждые 2 часа
  - Кто запускает: OpenClaw scheduler
  - Что выполняет: `npm run trade:crypto:monitor`
  - Как остановить: Kill Switch (`npm run trade:crypto:kill --on`)
  - Условия пропуска: Stop Day, Kill Switch active

- [ ] **8.2** Обновить `workspaces/orchestrator/AGENTS.md`:
  - Добавить секцию "Heartbeat расписание" с таблицей всех агентов

**Оценка**: 30 мин

---

## Порядок выполнения

```
Фаза 0: Разделение .claude/OpenClaw     (~1ч)    — ПЕРВАЯ, блокирует остальное
    │
    ▼
Фаза 1: Критические баг-фиксы           (~45мин)  — ATR + regime тесты
    │
    ▼
Фаза 2: Дневник решений                  (~4-5ч)  — Новый модуль decision-journal
    │
    ├── Фаза 3: Рефакторинг monitor.ts   (~3-4ч)  — Зависит от Phase 2 (интеграция)
    │
    └── Фаза 5: Улучшения утилит         (~2-3ч)  — Независимая
    │
    ▼
Фаза 4: API унификация + Rate Limiter    (~3-4ч)  — После рефакторинга
    │
    ▼
Фаза 6: Unit тесты                       (~3-4ч)  — После всех изменений кода
    │
    ▼
Фаза 7: Feedback loop и отчётность       (~4-5ч)  — Зависит от Phase 2 + 3
    │
    ▼
Фаза 8: Heartbeat документация           (~30мин) — В любой момент
```

**Общая оценка**: ~22-28 часов работы

---

## Критерии готовности (Definition of Done)

- [ ] `grep -r "workspaces/" .claude/agents/` — 0 результатов
- [ ] `npm run build` — без ошибок
- [ ] `npm run test:run` — все тесты проходят (0 fail)
- [ ] `npm run lint` — без ошибок
- [ ] ATR использует Wilder smoothing
- [ ] Decision journal записывает ВСЕ решения (entry + skip + manage)
- [ ] monitor.ts < 150 строк (оркестрация)
- [ ] Bybit API — единый способ доступа (через bybit-api library)
- [ ] Rate limiter — max 18 req/sec
- [ ] `npm run trade:crypto:explain --last` — выводит reasoning последнего решения
- [ ] `npm run trade:crypto:diary` — выводит дневник за день
- [ ] Покрытие тестами: state, risk, decision-journal, rate-limiter, retry, config

---

*План составлен на основе анализа `.claude/analysis/project-analysis-2026-03-05.md`*
