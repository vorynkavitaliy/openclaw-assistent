---
id: PLAN-002
title: Claude CLI как "мозг" крипто-трейдера — полноценное управление позициями
status: draft
created: 2026-03-08
priority: high
---

## Цель

Превратить Claude CLI из простого ENTER/SKIP/WAIT-советника в полноценного трейдера,
который видит весь контекст (позиции, P&L, рынок) и может самостоятельно принимать
решения по управлению открытыми позициями: закрывать при смене тренда, двигать SL,
фиксировать прибыль. Это переход от "советника при входе" к "живому трейдеру".

## Ключевые решения по архитектуре

### Проблема 1: Claude CLI стоит $0.28-0.50/вызов
Причина: claude -p загружает CLAUDE.md + весь проект в контекст (инструменты, файлы).

**Решение**: Не менять режим вызова. Вместо этого жёстко контролировать КОГДА вызывать.
Claude уже используется для ENTER-решений. Добавить второй тип вызова — "обзор позиций"
(position review), но вызывать его только при наличии триггеров, не каждые 5 мин.

### Проблема 2: Как передать контекст без загрузки проекта
Claude CLI уже загружает CLAUDE.md. Дополнительный контекст передаётся через промпт.
Промпт должен быть компактным: данные в тексте, не ссылки на файлы.

**Решение**: Новый модуль `claude-trader-context.ts` формирует snapshot одной функцией:
компактный текстовый блок (<2000 символов) с позициями, балансом, рынком.

### Проблема 3: Какие действия Claude может делать
Сейчас Claude возвращает только JSON с ENTER/SKIP/WAIT.
Нужно расширить JSON-протокол: добавить действия по позициям.

**Решение**: Новый JSON-формат ответа с массивом `actions`.
Новый модуль `claude-action-executor.ts` парсит и исполняет действия.

### Проблема 4: Безопасность
Claude может ошибиться или вернуть невалидный JSON.

**Решение**:
- Все действия валидируются против текущего state (позиция должна существовать)
- Лимит потерь: closePosition только если unrealisedPnl < -maxRiskPerTrade * 1.5
  ИЛИ явная смена тренда (score противоположного направления >= 40)
- Dry-run: в режиме dry-run все действия логируются но не исполняются
- Максимум 1 action per position per cycle (дедупликация)

---

## Новые файлы

### `src/trading/crypto/claude-trader-context.ts`
Формирует компактный контекст для Claude. Экспортирует одну функцию:
```typescript
export function buildTraderContext(signals: TradeSignalInternal[]): string
```
Возвращает текстовый блок с:
- Баланс и доступные средства
- Открытые позиции: symbol, side, entry, mark, unrealisedPnl, SL, TP, текущий R-кратный
- Рыночный анализ по КАЖДОЙ открытой паре (confluence score + regime)
- Рыночный анализ по сигнальным парам (кандидаты на вход)
- Дневная статистика (trades, wins, losses, stops, P&L)
- Время UTC и торговая сессия

### `src/trading/crypto/claude-action-executor.ts`
Парсит JSON-ответ Claude и исполняет действия. Экспортирует:
```typescript
export interface ClaudeAction {
  type: 'ENTER' | 'CLOSE_POSITION' | 'MODIFY_SL' | 'MODIFY_TP' | 'SKIP' | 'WAIT';
  pair: string;
  reason: string;
  confidence: number;
  // для ENTER:
  side?: 'Buy' | 'Sell';
  // для MODIFY_SL / MODIFY_TP:
  newSl?: number;
  newTp?: number;
}

export interface ClaudeResponse {
  summary: string;          // текстовое резюме решений Claude (для логов)
  actions: ClaudeAction[];
}

export async function executeClaudeActions(
  response: ClaudeResponse,
  signals: TradeSignalInternal[],
  cycleId: string,
  dryRun: boolean,
): Promise<void>
```

Внутренняя логика `executeClaudeActions`:
1. Для `CLOSE_POSITION`: проверить что позиция существует в state.positions, вызвать `closePosition(symbol)` из bybit-client
2. Для `MODIFY_SL`: проверить что newSl валиден (для LONG: newSl < markPrice, для SHORT: newSl > markPrice), вызвать `modifyPosition(symbol, newSl, undefined)`
3. Для `MODIFY_TP`: аналогично, вызвать `modifyPosition(symbol, undefined, newTp)`
4. Для `ENTER`: передать сигнал в `executeSignals()`
5. Для `SKIP` / `WAIT`: только лог + watchlist

---

## Изменения в существующих файлах

### `src/trading/crypto/llm-advisor.ts`
**Что изменить**: Расширить промпт и парсер.

Новый системный промпт (`TRADING_RULES`) добавляет секцию управления позициями:
```
УПРАВЛЕНИЕ ПОЗИЦИЯМИ:
- Можешь закрыть позицию (CLOSE_POSITION) если тренд явно сменился:
  confluence противоположного направления >= 40 по той же паре
- Можешь двигать SL ближе (MODIFY_SL) если цена прошла 1.5R в нашу пользу
- Можешь фиксировать TP досрочно (MODIFY_TP) если видишь сопротивление/поддержку
- НЕ закрывай позиции по "ощущениям" — только при конкретных данных
```

Новый формат ответа:
```json
{
  "summary": "Закрываю BTCUSDT — тренд сменился. Вхожу в ETHUSDT — сильный импульс.",
  "actions": [
    {"type": "CLOSE_POSITION", "pair": "BTCUSDT", "reason": "Confluence -45, смена на медвежий", "confidence": 80},
    {"type": "ENTER", "pair": "ETHUSDT", "reason": "Confluence +52, TREND_UP", "confidence": 75},
    {"type": "SKIP", "pair": "SOLUSDT", "reason": "CHOPPY режим", "confidence": 60}
  ]
}
```

Функция `parseDecisions()` → `parseClaudeResponse()` возвращает `ClaudeResponse`.

**Когда вызывать llm-advisor теперь**:
1. Есть кандидаты на ВХОД (как сейчас) — основной триггер
2. Есть открытые позиции + рынок по ним дал сигнал В ПРОТИВОПОЛОЖНУЮ сторону — position review
3. Комбинация: всегда передавать и позиции, и кандидатов

Это означает: даже если нет новых сигналов на вход, но есть открытые позиции с ухудшившимся confluence — вызываем Claude.

### `src/trading/crypto/monitor.ts`
**Что изменить**: Добавить trigger для position review.

```typescript
// Новая функция: проверяет нужен ли position review
function needsPositionReview(signals: TradeSignalInternal[]): boolean {
  const positions = state.get().positions;
  if (positions.length === 0) return false;

  // Если confluence сигнала противоположен открытой позиции — триггер
  for (const pos of positions) {
    const signal = signals.find(s => s.pair === pos.symbol);
    if (!signal) continue;
    const isLong = pos.side === 'long';
    const oppositeSignal = isLong
      ? signal.confluence.total <= -30  // держим LONG, рынок даёт SHORT -30
      : signal.confluence.total >= 30;  // держим SHORT, рынок даёт LONG +30
    if (oppositeSignal) return true;
  }
  return false;
}
```

Изменение логики вызова Claude в `main()`:
```typescript
// Было: вызываем только при наличии новых сигналов + cooldown + свободные слоты
// Стало: вызываем при наличии кандидатов ИЛИ при position review

const hasNewCandidates = candidates.length > 0 && hasFreePositionSlots();
const hasPositionReview = needsPositionReview(signals);
const shouldCallClaude = (hasNewCandidates || hasPositionReview) && cooldownOk;
```

Когда вызываем только position review (нет новых кандидатов):
- Передаём пустой массив сигналов или только пары позиций
- Промпт содержит только секцию управления позициями

### `src/trading/crypto/bybit-client.ts`
**Проверить**: функция `closePosition(symbol)` уже реализована (строки 304-343 по памяти).
Если не экспортирована — добавить в экспорт.

---

## Схема вызовов после рефакторинга

```
monitor.ts (cron */5)
  ↓
analyzeMarket() — бесплатно, всегда
  ↓
needsPositionReview() — проверка, бесплатно
  ↓
hasNewCandidates? || hasPositionReview? → cooldownOk?
  ↓ YES
runLLMAdvisorCycle(cycleId, candidates, currentPositions)
  ↓
  buildTraderContext(signals, positions) → compact prompt
  ↓
  claude -p <prompt> → ClaudeResponse (JSON)
  ↓
  parseClaudeResponse() → ClaudeResponse
  ↓
  executeClaudeActions(response, signals, cycleId, dryRun)
      ↓ ENTER → executeSignals()
      ↓ CLOSE_POSITION → bybit-client.closePosition()
      ↓ MODIFY_SL/TP → bybit-client.modifyPosition()
      ↓ SKIP → logDecision()
      ↓ WAIT → watchlist.addToWatchlist()
```

---

## Затронутые модули

| Файл | Изменение |
|------|-----------|
| `src/trading/crypto/claude-trader-context.ts` | НОВЫЙ — формирует контекст |
| `src/trading/crypto/claude-action-executor.ts` | НОВЫЙ — парсит и исполняет действия |
| `src/trading/crypto/llm-advisor.ts` | Расширить промпт + формат JSON + сигнатуру |
| `src/trading/crypto/monitor.ts` | Добавить `needsPositionReview()` + новая логика триггера |
| `src/trading/crypto/bybit-client.ts` | Проверить/добавить экспорт `closePosition` |

---

## Этапы реализации

### Этап 1 — Инфраструктура (developer)
Создать `claude-trader-context.ts`:
- Импортирует из `state.ts`, `market-analyzer.ts`
- Формирует текстовый контекст с позициями и рынком
- Unit-тест: проверить форматирование при разных состояниях

Проверить экспорт `closePosition` в `bybit-client.ts`.

### Этап 2 — Action executor (developer)
Создать `claude-action-executor.ts`:
- Типы `ClaudeAction` и `ClaudeResponse`
- Валидация каждого действия перед исполнением
- Dry-run поддержка
- Интеграция с `closePosition`, `modifyPosition`, `executeSignals`

### Этап 3 — Расширение llm-advisor (developer)
Изменить `llm-advisor.ts`:
- Новый системный промпт с секцией управления позициями
- Новый JSON-формат ответа
- Переименовать `parseDecisions` → `parseClaudeResponse`
- Изменить сигнатуру `runLLMAdvisorCycle` — добавить positions в параметры
- Использовать `buildTraderContext` из нового модуля
- Результат — `ClaudeResponse` вместо `LLMDecision[]`

### Этап 4 — Интеграция в monitor (developer)
Изменить `monitor.ts`:
- Добавить `needsPositionReview()`
- Изменить логику триггера Claude
- Вызывать `executeClaudeActions` вместо прямого `executeSignals` + watchlist

### Этап 5 — Тесты (tester)
- Unit-тест `claude-trader-context.ts`: форматирование контекста
- Unit-тест `claude-action-executor.ts`: валидация + dry-run
- Unit-тест `parseClaudeResponse`: невалидный JSON → fallback, частичный JSON
- Integration-тест `monitor.ts`: `needsPositionReview` логика
- `npm run lint && npm run build && npm run test:run`

---

## Детали промпта (ключевой момент)

Промпт должен быть самодостаточным — Claude не должен читать файлы проекта.

Структура промпта (порядок важен):

```
[SYSTEM RULES — TRADING_RULES константа]

---

КОНТЕКСТ ТРЕЙДЕРА:
[buildTraderContext() output]

---

ОТКРЫТЫЕ ПОЗИЦИИ — ТРЕБУЮТ РЕШЕНИЯ:
[только пары с position review триггером, если есть]
symbol | side | entry | mark | PnL | SL | TP | R | confluence СЕЙЧАС

---

КАНДИДАТЫ НА ВХОД:
[candidates из analyzeMarket]
[formatSignal() для каждого]

---

ЗАДАЧА:
Прими решение по КАЖДОЙ открытой позиции (если есть) И по каждому кандидату.
Ответь ТОЛЬКО JSON объектом без маркдауна.
```

---

## Оценка стоимости

| Сценарий | Вызовов/день | Стоимость/день |
|----------|-------------|----------------|
| Только входы (как сейчас) | 3-8 | $0.84-2.24 |
| + Position review (новое) | +2-4/день | +$0.56-1.12 |
| Итого | 5-12/день | $1.40-3.36 |

Дневной бюджет в `llm-cost-tracker.ts` установлен на $1. Нужно поднять до $4.

---

## Риски

| Риск | Вероятность | Митигация |
|------|------------|-----------|
| Claude закроет прибыльную позицию без причины | Средняя | Валидация: CLOSE только при score >= 40 противоположного направления |
| Невалидный JSON от Claude | Высокая | `parseClaudeResponse` с fallback — любая ошибка парсинга = не делать ничего по позициям |
| Двойной вызов (новые сигналы + position review одновременно) | Высокая | Всегда один вызов, объединяем контекст |
| Cooldown блокирует срочный position review | Средняя | Position review с `score <= -45` (экстремум) пропускает cooldown |
| Стоимость выходит за бюджет | Средняя | Поднять дневной лимит, но добавить предупреждение в Telegram |

---

## Definition of Done

- [ ] `claude-trader-context.ts` создан и покрыт тестами
- [ ] `claude-action-executor.ts` создан, валидация работает, dry-run проверен
- [ ] `llm-advisor.ts` возвращает `ClaudeResponse` с `actions[]`
- [ ] `monitor.ts` вызывает Claude при position review триггере
- [ ] Дневной лимит LLM поднят до $4 в `llm-cost-tracker.ts`
- [ ] `npm run lint && npm run build` — без ошибок
- [ ] `npm run test:run` — все зелёные
- [ ] Ручной тест: dry-run цикл с открытой позицией + противоположным сигналом → Claude получает position review контекст
