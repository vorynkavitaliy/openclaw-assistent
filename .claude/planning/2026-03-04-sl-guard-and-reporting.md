---
id: PLAN-002
title: SL-Guard и расширенная отчётность крипто-трейдера
status: draft
created: 2026-03-04
priority: high
---

## Цель

Устранить два критических недостатка торгового бота:

1. **Безопасность (P0)** — позиции могут существовать без стоп-лосса. Если Bybit принял
   ордер, но SL не применился, или если `sl === 0` в `managePositions()` — позиция
   пропускается вместо аварийного закрытия. Это прямой риск потери депозита.

2. **Отчётность (P1)** — оркестратор и пользователь не видят полной картины: нет истории
   закрытых сделок, нет лога ошибок API, `getTodayTrades()` возвращает только события
   типа `'trade'`, игнорируя `order_opened`, `partial_close`, `trailing_sl` и ошибки.

---

## Затронутые модули

| Файл | Что изменится |
|------|---------------|
| `src/trading/crypto/monitor.ts` | SL-верификация после submitOrder; аварийное закрытие в managePositions |
| `src/trading/crypto/state.ts` | Новая функция `getTodayEvents()`; логирование `api_error` |
| `src/trading/crypto/report.ts` | Секции "История событий" и "Ошибки API"; расширенный `ReportData` |

Не затронуты: `bybit-client.ts`, `config.ts`, `shared/types.ts`

---

## Анализ проблем

### Проблема 1 — точки отказа без SL

**Точка А: `managePositions()`, строка 113**
```
if (slDistance === 0) continue;  // позиция пропускается навсегда
```
Пока SL не появится, позиция не управляется. Если SL так и не установился — она
висит без защиты до стоп-дня или ручного вмешательства.

**Точка Б: `executeSignals()`, строки 367-395**
```typescript
const orderRes = await submitOrder({ ..., stopLoss: String(sig.sl) });
// После этой строки — нет проверки, действительно ли SL применился
state.logEvent('order_opened', { sl: sig.sl, ... });
```
Bybit может принять ордер (retCode === 0, orderId получен), но SL отбросить при
определённых условиях (цена уже прошла SL-уровень на момент заполнения лимитного
ордера). `submitOrder` не возвращает подтверждение SL — только orderId.

**Точка В: `executeSignals()`, строки 394-396**
```typescript
} catch (err) {
  results.push({ ...sig, action: `ERROR: ${(err as Error).message}` });
}
```
Ошибка submitOrder логируется в массив `results` для JSON-вывода, но не записывается
в `events.jsonl`. Оркестратор при следующем запуске не знает, что была ошибка.

### Проблема 2 — неполнота отчёта

`getTodayTrades()` в `state.ts` строка 369:
```typescript
return getRecentEvents(200).filter((e) => e.type === 'trade' && e.ts?.startsWith(today));
```
Это отображает только события от `recordTrade()`, который вызывается только при
фактическом закрытии позиции. События `order_opened`, `partial_close`, `trailing_sl`,
`api_error`, `stop_day` — в отчёте отсутствуют.

В `report.ts` поле `trades` используется но не отображается в Telegram-сообщении
(`formatTelegramReport` его не рендерит).

---

## Этапы реализации

### Этап 1 — `state.ts`: функция `getTodayEvents()` (developer, S)

**Зависимости:** нет (изолированное добавление)

**Что сделать:**

Добавить новую экспортируемую функцию рядом с `getTodayTrades()`:

```
getTodayEvents(types?: string[]): StoredEvent[]
```

Логика:
- Читать все события за сегодня из `events.jsonl` (через `getRecentEvents(500)` с
  увеличенным лимитом)
- Фильтровать по полю `ts` (сравнение с `today = new Date().toISOString().slice(0,10)`)
- Если передан параметр `types` — дополнительно фильтровать по `e.type`
- Вернуть массив `StoredEvent[]` в хронологическом порядке

Это позволит `report.ts` запрашивать любое подмножество событий за сутки.

---

### Этап 2 — `state.ts`: константа типов API-ошибок (developer, S)

**Зависимости:** нет

**Что сделать:**

Экспортировать константу (или тип) для категоризации ошибок, чтобы `monitor.ts`
мог передавать структурированный контекст:

```
export const API_ERROR_TYPES = {
  SUBMIT_ORDER: 'api_error_submit_order',
  VERIFY_SL: 'api_error_verify_sl',
  CLOSE_POSITION: 'api_error_close_position',
  MODIFY_SL: 'api_error_modify_sl',
} as const;
```

Затем в `logEvent` при ошибках использовать эти типы — так в отчёте можно будет
группировать ошибки по категориям.

---

### Этап 3 — `monitor.ts`: логирование ошибок `submitOrder` в events.jsonl (developer, S)

**Зависимости:** Этап 2

**Что сделать:**

В `executeSignals()`, блок `catch` (строки 394-396):

Текущее:
```typescript
} catch (err) {
  results.push({ ...sig, action: `ERROR: ${(err as Error).message}` });
}
```

Добавить после `results.push(...)`:
```typescript
state.logEvent(API_ERROR_TYPES.SUBMIT_ORDER, {
  symbol: sig.pair,
  side: sig.side,
  entry: sig.entryPrice,
  sl: sig.sl,
  error: (err as Error).message,
});
```

Это обеспечивает трассируемость: оркестратор при следующем запросе отчёта увидит
конкретные отказы API с временными метками.

---

### Этап 4 — `monitor.ts`: SL-верификация после submitOrder (developer, M)

**Зависимости:** Этапы 2, 3

**Что сделать:**

После успешного `submitOrder` в `executeSignals()` (после строки 393) добавить
асинхронную верификацию SL. Ждать заполнения ордера — не требуется (это лимитный
ордер, он может ждать). Поэтому верификация нужна только для уже открытых позиций,
что покрывается Этапом 5.

Для `executeSignals` достаточно:
- Если `submitOrder` выбросил ошибку → логировать в `api_error_submit_order`
  (уже описано в Этапе 3)
- Если `submitOrder` успешен → доверять Bybit API, что SL принят вместе с ордером.
  Итоговая верификация произойдёт в следующем цикле через `managePositions()` (Этап 5)

Важный нюанс архитектуры: `submitOrder` для лимитного ордера создаёт ордер в стакане,
а SL применяется после исполнения. Поэтому немедленная верификация через
`getPositions()` сразу после `submitOrder` ненадёжна — позиция может ещё не открыться.
Верификация актуальна только когда позиция уже числится в `state.get().positions` с
ненулевым `size`.

---

### Этап 5 — `monitor.ts`: аварийное закрытие в `managePositions()` (developer, M)

**Зависимости:** Этапы 2, 3

**Это критический этап безопасности.**

**Что изменить:**

В `managePositions()`, строки 112-113:

Текущее:
```typescript
const slDistance = Math.abs(entry - sl);
if (slDistance === 0) continue;
```

Заменить на логику аварийного закрытия:
```
if (slDistance === 0 && !DRY_RUN):
  1. Залогировать warn: "Position without SL detected, emergency close"
  2. state.logEvent(API_ERROR_TYPES.VERIFY_SL, { symbol, entry, sl: 0, action: 'emergency_close' })
  3. Вызвать closePosition(pos.symbol) из bybit-client.ts
  4. Залогировать результат в actions: { type: 'emergency_close', symbol, reason: 'no_sl', result: 'OK'/'ERROR' }
  5. При ошибке закрытия — логировать в api_error_close_position
  6. В обоих случаях — continue (не управлять trailing/partial)

if (slDistance === 0 && DRY_RUN):
  1. Залогировать warn: "DRY_RUN: Position without SL would be closed"
  2. Добавить в actions: { type: 'emergency_close_dry_run', symbol }
  3. continue
```

**Важно:** импортировать `closePosition` из `./bybit-client.js` (уже есть в импортах,
строка 23 — проверить наличие).

Проверка: в `bybit-client.ts` функция `closePosition(symbol)` уже существует (строки
304-343) и используется в `killswitch.ts`. Импортировать не нужно — уже в импортах
`monitor.ts` строка 23 перечислена вся нужная функция, но `closePosition` там нет.
Добавить `closePosition` в список импортов из `./bybit-client.js`.

---

### Этап 6 — `report.ts`: расширить `ReportData` и `collectData()` (developer, S)

**Зависимости:** Этап 1

**Что сделать:**

В интерфейс `ReportData` добавить поля:
```typescript
todayEvents: Array<{
  ts: string;
  type: string;
  [key: string]: unknown;
}>;
apiErrors: Array<{
  ts: string;
  type: string;
  symbol?: string;
  error?: string;
}>;
```

В функцию `collectData()` добавить вызовы:
```typescript
const todayEvents = state.getTodayEvents([
  'order_opened', 'partial_close', 'trailing_sl', 'trade',
  'stop_day', 'kill_switch_on', 'kill_switch_off',
]);

const apiErrors = state.getTodayEvents([
  'api_error_submit_order', 'api_error_verify_sl',
  'api_error_close_position', 'api_error_modify_sl',
]);
```

Вернуть оба поля в `ReportData`.

---

### Этап 7 — `report.ts`: рендер "История событий" в Telegram (developer, S)

**Зависимости:** Этап 6

**Что добавить в `formatTelegramReport()`:**

После блока "Дневная статистика" добавить секцию "История за сутки":

Правила форматирования:
- Показывать не более 10 последних значимых событий (order_opened, partial_close,
  trailing_sl, trade, stop_day)
- Для `order_opened`: `"⏳ Открыт ордер BTCUSDT LONG | SL: 94200 | qty: 0.003"`
- Для `partial_close`: `"✂️ Частичное закрытие BTCUSDT | qty: 0.001 | R: 1.23"`
- Для `trailing_sl`: `"🔄 Trailing SL BTCUSDT | 93800 → 94100"`
- Для `trade` (закрытая сделка): `"🏁 Закрыта BTCUSDT | PnL: +$23.5"`
- Для `stop_day`: `"⛔ Стоп-день: <причина>"`
- Если событий нет: не отображать секцию

---

### Этап 8 — `report.ts`: рендер "Ошибки API" в Telegram (developer, S)

**Зависимости:** Этап 6

**Что добавить:**

После секции "История за сутки" добавить секцию "Ошибки API":

- Показывать только если `apiErrors.length > 0`
- Группировать по типу: `submit_order: N`, `verify_sl: N`, `close_position: N`
- Последние 3 ошибки с текстом: `"✗ BTCUSDT: Order REJECTED: ..."`
- Итоговое предупреждение если `api_error_verify_sl > 0`: красный маркер

---

### Этап 9 — tester: покрытие новой логики (tester, M)

**Зависимости:** Этапы 1-8

**Что тестировать:**

Файл: `src/trading/crypto/__tests__/state.test.ts` (создать если не существует)

Тест-кейсы для `getTodayEvents()`:
- Возвращает пустой массив если файл не существует
- Возвращает только события за сегодня (не вчерашние)
- Фильтрует по типам если передан параметр `types`
- Возвращает события в хронологическом порядке

Файл: `src/trading/crypto/__tests__/monitor.test.ts` (создать/дополнить)

Тест-кейсы для логики SL-guard в `managePositions()`:
- Позиция с `sl === 0`, DRY_RUN=false: вызывается `closePosition`, событие
  `api_error_verify_sl` логируется, тип действия `emergency_close`
- Позиция с `sl === 0`, DRY_RUN=true: `closePosition` не вызывается, действие
  `emergency_close_dry_run`
- Позиция с корректным SL: поведение не изменилось (partial close / trailing работают)

**Важно для моков**: `managePositions` — не экспортируется напрямую. Тестировать
через `main()` с моками на `bybit-client` и `state`, или вынести в отдельную
экспортируемую функцию для тестируемости.

---

### Этап 10 — tester: финальная проверка качества (tester, S)

**Зависимости:** Этап 9

**Команды:**
```bash
npm run lint
npm run build
npm run test:run
```

Ожидаемый результат: всё зелёное, без новых TypeScript-ошибок.

---

## Риски

| Риск | Вероятность | Митигация |
|------|-------------|-----------|
| `closePosition` в `managePositions` вызывается в DRY_RUN по ошибке | Средняя | Явная проверка `!DRY_RUN` перед вызовом (описано в Этапе 5) |
| `getTodayEvents(500)` медленно читает большой `events.jsonl` | Низкая | Файл ротируется при >5MB; для отчёта это приемлемо |
| Bybit `closePosition` падает при emergency close — позиция остаётся без SL | Средняя | Логировать в `api_error_close_position` + warn; на следующем цикле повторить |
| strict TypeScript: `exactOptionalPropertyTypes` — поля `symbol?` в новых типах | Высокая | Использовать `symbol?: string | undefined` а не `symbol?: string` |
| `noUncheckedIndexedAccess` — обращение к элементам массива `events[0]` | Высокая | Использовать optional chaining `events[0]?.ts` |

---

## Порядок выполнения (граф зависимостей)

```
Этап 1 (state: getTodayEvents) ──────────────────────────────► Этапы 6, 7, 8
Этап 2 (state: API_ERROR_TYPES константа) ──► Этапы 3, 4, 5
Этап 3 (monitor: логирование ошибок submitOrder) ──► Этап 9
Этап 4 (monitor: заметка про архитектуру SL-верификации) ──► Этап 5
Этап 5 (monitor: SL-guard в managePositions) ──► Этап 9
Этап 6 (report: расширение ReportData) ──► Этапы 7, 8
Этап 7 (report: История событий) ──► Этапы 9, 10
Этап 8 (report: Ошибки API) ──► Этапы 9, 10
Этап 9 (tester: тесты) ──► Этап 10
```

**Рекомендуемый порядок для developer:**
Этап 2 → Этап 1 → Этап 3 → Этап 5 → Этап 6 → Этап 7 → Этап 8

**После developer — tester:** Этапы 9, 10

---

## Оценка сложности

| Этап | Агент | Оценка |
|------|-------|--------|
| 1 — getTodayEvents() | developer | S (<30 мин) |
| 2 — API_ERROR_TYPES | developer | S (<15 мин) |
| 3 — логирование submitOrder ошибок | developer | S (<20 мин) |
| 4 — архитектурная заметка (не код) | — | — |
| 5 — SL-guard в managePositions | developer | M (~1 ч) |
| 6 — расширить ReportData | developer | S (<30 мин) |
| 7 — рендер История событий | developer | S (<45 мин) |
| 8 — рендер Ошибки API | developer | S (<30 мин) |
| 9 — тесты | tester | M (~2 ч) |
| 10 — финальная проверка | tester | S (<15 мин) |

**Итого developer:** ~L (4-5 часов)
**Итого tester:** ~M (2-2.5 часа)
**Общая оценка:** L

---

## Definition of Done

- [ ] `managePositions()`: позиции с `sl === 0` закрываются аварийно (не пропускаются)
- [ ] `executeSignals()`: ошибки `submitOrder` записываются в `events.jsonl`
- [ ] `state.getTodayEvents(types?)` экспортирована и работает
- [ ] `report.ts`: секция "История за сутки" отображает order_opened, partial_close, trade
- [ ] `report.ts`: секция "Ошибки API" отображается при наличии ошибок
- [ ] В DRY_RUN режиме `closePosition` не вызывается
- [ ] `npm run lint` — без ошибок
- [ ] `npm run build` — без ошибок
- [ ] `npm run test:run` — все тесты зелёные
- [ ] Новые тесты покрывают SL-guard (DRY_RUN и execute режимы)
