# Planner Memory

## Ключевые архитектурные паттерны

### Торговый цикл (crypto/monitor.ts)
Цикл: `checkStatus` → `refreshAccount` → `managePositions` → `analyzeMarket` → `executeSignals`
- `managePositions` работает с `state.get().positions` (кэш из последнего `refreshAccount`)
- `executeSignals` создаёт лимитные ордера; SL/TP передаются в submitOrder параметром
- Лимитный ордер: позиция открывается только при заполнении → SL верифицировать можно
  только в следующем цикле через `managePositions`, не сразу после submitOrder

### Логирование событий (state.ts)
- `logEvent(type, data)` — запись в `events.jsonl` (NDJSON)
- `getTodayTrades()` — только тип `'trade'`, лимит 200 строк
- `getRecentEvents(N)` — последние N строк файла
- Файл ротируется при >5MB (половина старых записей удаляется)

### Режимы работы
- `DRY_RUN = hasFlag('dry-run') || config.mode !== 'execute'`
- Все деструктивные торговые операции защищены проверкой `!DRY_RUN`

## Паттерны планирования

### SL-guard принцип
Для позиций без SL: аварийное закрытие в `managePositions()`, не в `executeSignals()`.
Причина: лимитный ордер может быть в стакане, позиции ещё нет → closePosition не нужен.
SL-guard актуален только когда `state.positions` уже содержит позицию с `sl === 0`.

### Логирование API ошибок
Ошибки submitOrder нужно писать в `events.jsonl` через `state.logEvent()`, не только
в results массив — иначе оркестратор теряет трассируемость между циклами.

### Тестируемость monitor.ts
`managePositions()` и `executeSignals()` — не экспортированы. Тестировать через моки
bybit-client + state, или экспортировать функции с пометкой `/* @internal */`.

## Конвенции strict TypeScript
- `exactOptionalPropertyTypes`: писать `field?: string | undefined`, не `field?: string`
- `noUncheckedIndexedAccess`: всегда `arr[0]?.prop`, не `arr[0].prop`
- ES Module импорты: расширение `.js` обязательно

## Файловая карта крипто-модуля
- `bybit-client.ts` — REST API; `closePosition(symbol)` уже реализована (строки 304-343)
- `monitor.ts` — импортирует из bybit-client, но `closePosition` не в списке импортов
- `state.ts` — `API_ERROR_TYPES` константы нет, нужно добавить
- `config.ts` — `mode: 'execute'`, `demoTrading: true`, данные в `data/`

## Архитектура LLM (llm-advisor.ts, 2026-03-08)
- Текущий вызов: `runClaudeCli(prompt, {stream: false, useSession: false})` — каждый раз чистый контекст
- Формат ответа: JSON массив `[{pair, decision, reason, confidence}]`
- Cooldown: 5 мин (LLM_COOLDOWN_MS), дедуп SKIP 15 мин (SKIP_DEDUP_HOURS=0.25)
- Бюджет: дневной лимит в `llm-cost-tracker.ts` (по умолчанию $1/день)
- PLAN-002: расширить до полного управления позициями — новые модули:
  - `claude-trader-context.ts` — компактный контекст для промпта
  - `claude-action-executor.ts` — парсинг и исполнение ClaudeAction[]
  - Новый JSON формат: `{summary, actions: [{type, pair, reason, confidence, ...}]}`
  - Новый тип action: CLOSE_POSITION, MODIFY_SL, MODIFY_TP (в дополнение к ENTER/SKIP/WAIT)
  - Position review триггер: confluence >= 30 противоположного направления открытой позиции
