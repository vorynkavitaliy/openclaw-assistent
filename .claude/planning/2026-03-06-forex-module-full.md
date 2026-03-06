---
id: PLAN-004
title: Полная реализация forex trading модуля
status: draft
created: 2026-03-06
priority: high
---

## Цель

Довести forex модуль до паритета с crypto модулем: полноценный торговый цикл с анализом
рынка, confluence scoring, state, decision journal, kill switch, Telegram отчёты и тесты.

Главный блокер — отсутствие исторических свечей. Всё остальное строится поверх решения
этого блокера.

---

## Решение блокера: источник свечей

### Анализ вариантов

**A) cTrader QUOTE FIX session**
- Нужна отдельная TCP/SSL сессия (другой порт, другой SenderSubID — `QUOTE` вместо `TRADE`)
- MarketDataRequest (35=V) → MarketDataSnapshotFullRefresh (35=W)
- Только live тики и top-of-book — НЕ исторические свечи
- MarketDataRequest с SubscriptionRequestType=0 (Snapshot) даёт только текущий bid/ask
- Вывод: FIX не даёт OHLC history, только real-time тики. Накапливать тики в свечи
  можно, но нужны недели работы бота до накопления H4 данных — не подходит для запуска

**B) Twelve Data REST API (рекомендуется)**
- Бесплатный план: 800 API calls/день, 8 calls/мин
- Исторические OHLC для forex: EURUSD, GBPUSD, USDJPY, XAUUSD и все нужные пары
- Endpoint: `GET /time_series?symbol=EUR/USD&interval=4h&outputsize=100&apikey=KEY`
- Поддерживает форматы: `1min`, `5min`, `15min`, `1h`, `4h`, `1day`
- Надёжный провайдер, простой REST, JSON ответ близкий к OHLC структуре проекта
- Ограничение: 8 calls/min → при 8 парах × 4 таймфрейма = 32 запроса → нужна очередь

**C) Alpha Vantage**
- Бесплатный план: 25 calls/день — слишком мало для 8 пар × 4 ТФ

**D) OANDA v20 REST API**
- Нужен счёт OANDA, не совместим с FTMO cTrader
- Избыточная сложность интеграции

**Выбор: Twelve Data** как основной источник.
Credentials: `TWELVE_DATA_API_KEY` в `.env`

### Маппинг символов для Twelve Data

| Наш символ | Twelve Data |
|-----------|-------------|
| EURUSD    | EUR/USD     |
| GBPUSD    | GBP/USD     |
| USDJPY    | USD/JPY     |
| AUDUSD    | AUD/USD     |
| USDCAD    | USD/CAD     |
| NZDUSD    | NZD/USD     |
| EURGBP    | EUR/GBP     |
| XAUUSD    | XAU/USD     |

### Маппинг таймфреймов

| Наш формат | Twelve Data |
|-----------|-------------|
| M15 / 15  | 15min       |
| H1 / 60   | 1h          |
| H4 / 240  | 4h          |
| D1 / D    | 1day        |

---

## Архитектура нового forex модуля

```
src/trading/forex/
├── config.ts              — СУЩЕСТВУЕТ, расширить (добавить ForexTradingConfig)
├── fix-connection.ts      — СУЩЕСТВУЕТ, не трогать
├── client.ts              — СУЩЕСТВУЕТ, не трогать (ордера/позиции работают)
├── market-data.ts         — НОВЫЙ: Twelve Data REST клиент (getKlines, getSpread)
├── state.ts               — НОВЫЙ: состояние, daily P&L, FTMO лимиты, kill switch
├── market-analyzer.ts     — НОВЫЙ: анализ пар, confluence scoring (адаптация крипто)
├── position-manager.ts    — НОВЫЙ: SL-Guard, trailing SL, partial close
├── signal-executor.ts     — НОВЫЙ: расчёт лотов (risk.ts), исполнение ордеров
├── decision-journal.ts    — НОВЫЙ: JSONL дневник (можно скопировать из крипто)
├── report.ts              — НОВЫЙ: Telegram отчёт
├── killswitch.ts          — НОВЫЙ: аварийное закрытие всех позиций
├── monitor.ts             — ПЕРЕПИСАТЬ: оркестрация цикла поверх новых модулей
├── trade.ts               — СУЩЕСТВУЕТ (trade.ts — посмотреть что там)
└── snapshot.ts            — СУЩЕСТВУЕТ (посмотреть что там)
```

---

## Forex-специфичные константы и логика

### Символ-спецификации (`forex-specs.ts` или в `market-data.ts`)

```typescript
// pip sizes уже есть в client.ts — вынести отдельно или переиспользовать
function pipSize(symbol: string): number
function lotsToUnits(symbol: string, lots: number): number
function pipValueUsd(symbol: string, lots: number): number  // НОВАЯ: стоимость 1 пипа

// Для расчёта SL в лотах через risk.ts нам нужен pipValueUsd:
// lots = riskUsd / (slPips * pipValueUsd)
```

### FTMO-специфичный риск-менеджмент

Forex config должен расширять `BaseTradingConfig` новыми полями:

```typescript
interface ForexTradingConfig extends BaseTradingConfig {
  // FTMO лимиты
  maxDailyLossUsd: number;        // 500 при 10k счёте (5%)
  maxTotalDrawdownUsd: number;    // 1000 при 10k (10%)
  profitTargetUsd: number;        // 1000 при 10k (10%)

  // Forex-специфика
  maxRiskPerTradePct: number;     // 1% от баланса на сделку
  maxTradesPerDay: number;        // 5
  tradingHoursStart: number;      // 8 (UTC) — не торговать в Asian quiet session
  tradingHoursEnd: number;        // 20 (UTC)
  avoidNewsMinutes: number;       // 30 — избегать торговли за N мин до новостей
  maxSpreadPips: number;          // 3 — отклонить сигнал если спред > N пипов

  // Пути данных
  stateFile: string;
  eventsFile: string;
  killSwitchFile: string;

  // Источник данных
  twelveDataApiKey: string;       // из env

  // Торговые часы
  noTradeWeekend: boolean;        // true — выключить в выходные
}
```

### Расчёт лотов для forex

```
// risk.ts не подходит напрямую (считает qty в единицах, не лотах)
// Нужна forex-специфичная функция:

function calculateForexLots(
  balanceUsd: number,
  riskPct: number,           // 0.01 = 1%
  slPips: number,
  symbol: string,
): number {
  const riskUsd = balanceUsd * riskPct;
  const pipVal = pipValueUsd(symbol, 1.0);  // стоимость 1 пипа при 1 стандартном лоте
  const lots = riskUsd / (slPips * pipVal);
  return Math.max(0.01, Math.round(lots * 100) / 100);  // min 0.01, округление до 0.01
}
```

### Forex confluence (адаптация)

Modules 1-4 (trend, momentum, structure, regime) — переиспользовать из `shared/confluence.ts` напрямую, они не зависят от крипто.

Module 5 (orderflow) — не применим (нет OI, funding rate). Заменить на **сессионный модуль**:
- Торгуем ли в активную сессию? (London/NY overlap = лучший liquidity)
- Нет ли важных новостей в ближайший час?
- Спред в норме?

Module 6 (volume) — адаптировать: forex объёмы у Twelve Data есть (tick volume),
но они менее информативны. Использовать relative volume для оценки активности.

---

## Этапы реализации

### Этап 1: Источник свечей — `market-data.ts` (developer)
**Размер: M (2-3h)**
**Блокирует: всё остальное**

Файлы:
- `src/trading/forex/market-data.ts` — СОЗДАТЬ

Что реализовать:
1. `getKlines(symbol, timeframe, count)` → `Promise<OHLC[]>`
   - Маппинг символов: `EURUSD` → `EUR/USD`
   - Маппинг ТФ: `H4` → `4h`, `M15` → `15min`, `D1` → `1day`
   - HTTP fetch к `https://api.twelvedata.com/time_series`
   - Параметры: `symbol`, `interval`, `outputsize=count`, `apikey`
   - Маппинг ответа → `OHLC[]` (поля: `datetime`, `open`, `high`, `low`, `close`, `volume`)
2. `getSpread(symbol)` → `Promise<number>` — текущий спред в пипсах
   - Endpoint: `/quote` — поля `bid`, `ask`
   - Вычислить: `(ask - bid) / pipSize(symbol)`
3. Rate limiting: простой setTimeout-based лимитер (8 calls/min = 1 call/7.5sec)
   - Очередь запросов, не нужен сложный token bucket
4. Кэширование: Map с TTL по (symbol, timeframe) → кэш 4 мин для M15, 30 мин для H4
5. `TWELVE_DATA_API_KEY` из `process.env.TWELVE_DATA_API_KEY`

Тесты (tester):
- Mock HTTP responses
- Маппинг символов и таймфреймов
- Rate limiter: 9 запросов подряд — 9-й ждёт

---

### Этап 2: ForexConfig — расширить `config.ts` (developer)
**Размер: S (30min)**
**Зависит от: ничего**

Файлы:
- `src/trading/forex/config.ts` — ИЗМЕНИТЬ

Что сделать:
- Заменить `ForexConfig extends BaseTradingConfig` на полноценный конфиг
  с FTMO лимитами, торговыми часами, путями к файлам данных
- Добавить поля: `stateFile`, `eventsFile`, `killSwitchFile`, `twelveDataApiKey`
- Добавить: `tradingHoursStart: 7`, `tradingHoursEnd: 20` (UTC)
- Добавить: `noTradeWeekend: true`, `maxSpreadPips: 3`
- Добавить: `maxDailyLossUsd: 500`, `maxTotalDrawdownUsd: 1000`
- Добавить npm scripts в `package.json`: `trade:forex:monitor`, `trade:forex:kill`,
  `trade:forex:journal`, `trade:forex:report`

---

### Этап 3: State — `state.ts` (developer)
**Размер: M (2h)**
**Зависит от: Этап 2 (config)**

Файлы:
- `src/trading/forex/state.ts` — СОЗДАТЬ

Скопировать структуру из `src/trading/crypto/state.ts`, адаптировать:
- Убрать крипто-специфику (`lastLLMCycleAt`, `pendingSignals`)
- Добавить FTMO-специфику:
  - `ftmoPhase: 'challenge' | 'verification' | 'funded'`
  - `totalDrawdownUsd: number` — накопленный drawdown от начальной equity
  - `initialBalance: number` — баланс на начало дня/фазы
- Оставить: `daily.trades`, `daily.pnl`, `daily.stopDay`, `positions[]`
- `logEvent(type, data)` → запись в `eventsFile` (NDJSON, аналог крипто)
- `isKillSwitchActive()`, `activateKillSwitch(reason)`
- `checkFtmoLimits(equity)` → возвращает `{stop: boolean, reason: string}`

---

### Этап 4: Decision Journal — `decision-journal.ts` (developer)
**Размер: S (30min)**
**Зависит от: Этап 2 (config)**

Файлы:
- `src/trading/forex/decision-journal.ts` — СОЗДАТЬ

Скопировать `src/trading/crypto/decision-journal.ts` почти без изменений.
Единственное отличие — путь к файлу берётся из `forexConfig.stateFile` директории.
Тип `MarketContext` расширить: добавить `spread?: number`, убрать `fundingRate`.

---

### Этап 5: Market Analyzer — `market-analyzer.ts` (developer)
**Размер: L (4-5h)**
**Зависит от: Этапы 1, 2, 3**

Файлы:
- `src/trading/forex/market-analyzer.ts` — СОЗДАТЬ

Структура аналогична `src/trading/crypto/market-analyzer.ts` но:

1. Получение данных — через `market-data.ts`, не bybit-client
2. Confluence input — НЕТ: `orderbook`, `oiHistory`, `fundingHistory`, `volumeProfile`
   Эти данные недоступны для forex → заменить orderflow module на sessionScore
3. **Адаптированный `ConfluenceInput` для forex:**
   ```typescript
   interface ForexConfluenceInput {
     trendTF: MarketAnalysis | null;   // D1
     zonesTF: MarketAnalysis | null;   // H1
     entryTF: MarketAnalysis;          // M15
     precisionTF: MarketAnalysis | null; // M5
     entryCandles: OHLC[];
     regime: MarketRegime;
     spreadPips: number;               // текущий спред
     sessionScore: number;             // -10..+10 (London/NY/Asia active?)
   }
   ```
4. Использовать `calculateConfluenceScore` из shared/confluence.ts для modules 1-4, 6
5. Модуль 5 (orderflow) заменить на `scoreSession(hour, spreadPips)`:
   - London+NY overlap (13-17 UTC): +8
   - London (8-13 UTC): +4
   - NY solo (17-20 UTC): +2
   - Asian (2-8 UTC): -2
   - Off hours (20-2 UTC): -5
   - Spread > maxSpreadPips: -10 (блокирующий)
6. Торговые часы-гарды: не анализировать вне `tradingHoursStart`..`tradingHoursEnd` UTC
7. Weekend guard: не торгуем в субботу-воскресенье
8. Cooldown per-pair: аналог crypto (180 мин по умолчанию)

Функция `analyzePair(symbol)` → `{analysis: MarketAnalysis, score: ConfluenceScore} | null`

---

### Этап 6: Position Manager — `position-manager.ts` (developer)
**Размер: M (2h)**
**Зависит от: Этапы 2, 3**

Файлы:
- `src/trading/forex/position-manager.ts` — СОЗДАТЬ

Взять логику из `monitor.ts` (функции `manageOpenPositions`, `checkPositionRisks`),
рефакторить в отдельный модуль:

1. `checkSLGuard(positions)` — позиции без SL → аварийное закрытие
   - Если `stopLoss === undefined || sl === 0` → вызвать `closePosition(posId)`
   - Логировать через `state.logEvent('sl_guard_triggered', ...)`
2. `manageTrailingStop(pos, currentPrice)` — передвинуть SL при достижении `trailingStartR`
   - Используется формула из существующего `monitor.ts` (pipDiff, slDistance)
3. `managePartialClose(pos, currentPrice)` — частичное закрытие при `partialCloseAtR`
4. `calculateCurrentR(pos, currentPrice)` — вспомогательная, расчёт R-кратного

Forex-специфика в position manager:
- Расчёт P&L в пипсах (для отображения)
- Правильная PnL формула: `pipDiff * pipValueUsd(symbol, lots)`
- Правильный расчёт riskAmount через pipValue, не через цены напрямую

---

### Этап 7: Signal Executor — `signal-executor.ts` (developer)
**Размер: M (2h)**
**Зависит от: Этапы 1, 2, 3, 5**

Файлы:
- `src/trading/forex/signal-executor.ts` — СОЗДАТЬ

1. `calculateForexLots(balance, riskPct, slPips, symbol)` → lots
   - `pipValueUsd(symbol, 1.0)` для расчёта
   - Минимум 0.01 лот, максимум из конфига
2. `executeSignal(signal, account, cycleId)` → `OrderResult | null`
   - Проверить: RR >= minRR, спред допустимый
   - Рассчитать лоты
   - Вызвать `submitOrder` из client.ts
   - Записать в decision-journal
   - DRY_RUN: логировать без исполнения
3. Типы: использовать `TradeSignal` из `shared/types.ts` (уже есть поля entryPrice, stopLoss, takeProfit, riskReward)

---

### Этап 8: Kill Switch — `killswitch.ts` (developer)
**Размер: S (1h)**
**Зависит от: Этап 2, 3**

Файлы:
- `src/trading/forex/killswitch.ts` — СОЗДАТЬ

Скопировать `src/trading/crypto/killswitch.ts`, адаптировать:
- Использовать `client.closeAll()` из forex/client.ts
- После закрытия всех позиций → создать файл kill switch через state
- Отправить Telegram уведомление

---

### Этап 9: Monitor — переписать `monitor.ts` (developer)
**Размер: M (2-3h)**
**Зависит от: Этапы 3-8**

Файлы:
- `src/trading/forex/monitor.ts` — ПЕРЕПИСАТЬ полностью

Новая архитектура цикла (по образцу crypto/monitor.ts):

```
main() →
  checkKillSwitch()
  checkFtmoLimits()
  checkTradingHours()
  refreshAccount()          ← getBalance() + getPositions()
  updateState()             ← сохранить в state
  managePositions()         ← position-manager.ts
  analyzeMarket()           ← market-analyzer.ts (все пары параллельно)
  executeSignals()          ← signal-executor.ts
  sendReport()              ← если время отчёта
  disconnect()
```

Режимы запуска (флаги):
- `--heartbeat` — только статус счёта и позиций
- `--positions` — список позиций
- `--trade` — полный цикл
- По умолчанию — heartbeat

---

### Этап 10: Report — `report.ts` (developer)
**Размер: S (1h)**
**Зависит от: Этапы 3, 9**

Файлы:
- `src/trading/forex/report.ts` — СОЗДАТЬ

Telegram отчёт раз в N часов:
- Баланс, equity, dailyPnl
- Открытые позиции с P&L в пипсах и USD
- FTMO статус: % дневного лимита использован, % drawdown лимита
- Количество сделок за день

---

### Этап 11: Тесты (tester)
**Размер: L (4-5h)**
**Зависит от: Этапы 1-10**

Файлы создать в `src/trading/forex/__tests__/`:
- `market-data.test.ts` — mock HTTP, маппинг символов/ТФ, кэш, rate limit
- `state.test.ts` — FTMO лимиты, kill switch, daily reset
- `market-analyzer.test.ts` — session scoring, weekend guard, анализ пар
- `position-manager.test.ts` — SL-guard, trailing, partial close (с mock client)
- `signal-executor.test.ts` — расчёт лотов, RR фильтр
- `decision-journal.test.ts` — запись/чтение (можно скопировать из крипто тестов)

Цель: минимум 40 тестов, покрытие критических путей.

---

## Затронутые файлы

| Файл | Действие | Этап |
|------|----------|------|
| `src/trading/forex/config.ts` | ИЗМЕНИТЬ | 2 |
| `src/trading/forex/market-data.ts` | СОЗДАТЬ | 1 |
| `src/trading/forex/state.ts` | СОЗДАТЬ | 3 |
| `src/trading/forex/decision-journal.ts` | СОЗДАТЬ | 4 |
| `src/trading/forex/market-analyzer.ts` | СОЗДАТЬ | 5 |
| `src/trading/forex/position-manager.ts` | СОЗДАТЬ | 6 |
| `src/trading/forex/signal-executor.ts` | СОЗДАТЬ | 7 |
| `src/trading/forex/killswitch.ts` | СОЗДАТЬ | 8 |
| `src/trading/forex/monitor.ts` | ПЕРЕПИСАТЬ | 9 |
| `src/trading/forex/report.ts` | СОЗДАТЬ | 10 |
| `package.json` | ИЗМЕНИТЬ (npm scripts) | 2 |
| `.env.example` | ИЗМЕНИТЬ (TWELVE_DATA_API_KEY) | 1 |
| `src/trading/forex/__tests__/*.test.ts` | СОЗДАТЬ (6 файлов) | 11 |

Файлы НЕ трогать:
- `fix-connection.ts` — работает, сложный
- `client.ts` — работает (ордера, позиции, модификация SL/TP)
- `src/trading/shared/*.ts` — переиспользуем без изменений

---

## График и зависимости

```
[1: market-data.ts] ←── блокирует всё
        ↓
[2: config.ts] ←── параллельно с 1
        ↓
[3: state.ts] + [4: decision-journal.ts]  ←── параллельно
        ↓
[5: market-analyzer.ts] + [6: position-manager.ts] + [7: signal-executor.ts]
                                                   ↙         ↓          ↘
                                            [8: killswitch.ts]
                                                             ↓
                                                     [9: monitor.ts]
                                                             ↓
                                                     [10: report.ts]
                                                             ↓
                                                    [11: tests]
```

Параллельно можно делать: 1+2, 3+4, 5+6+7+8

---

## Оценка сложности

| Этап | Размер | Риск |
|------|--------|------|
| 1. market-data.ts (Twelve Data) | M | Средний — зависит от API структуры |
| 2. config.ts | S | Низкий |
| 3. state.ts | M | Низкий — шаблон из крипто |
| 4. decision-journal.ts | S | Минимальный — копия из крипто |
| 5. market-analyzer.ts | L | Средний — сессионный модуль вместо orderflow |
| 6. position-manager.ts | M | Низкий — логика уже есть в monitor.ts |
| 7. signal-executor.ts | M | Средний — расчёт лотов forex-специфичен |
| 8. killswitch.ts | S | Низкий |
| 9. monitor.ts | M | Низкий — оркестрация готовых компонентов |
| 10. report.ts | S | Низкий |
| 11. Тесты | L | Средний — нужно хорошо замокать Twelve Data |

**Итого: ~2-3 рабочих дня (XL)**

---

## Риски

1. **Twelve Data rate limit 8 calls/min** → митигация: кэш с TTL + очередь запросов.
   При 8 парах × 4 ТФ = 32 запроса → занимает ~4 минуты при последовательной отправке.
   Решение: кэшировать агрессивно (H4 кэш 20 мин, D1 кэш 60 мин).

2. **Twelve Data недоступен / API key не настроен** → митигация: graceful fallback —
   логировать ошибку, пропустить анализ пары, продолжить цикл. НЕ падать весь монитор.

3. **FTMO лимиты** → митигация: `checkFtmoLimits()` вызывается первым в цикле.
   При превышении daily loss — немедленная активация kill switch.

4. **Pip value расчёт для экзотик** → митигация: для MVP достаточно EURUSD, GBPUSD,
   USDJPY (fixed pip values). Добавить TODO для cross-currency пар (GBPJPY и т.д.).

5. **QUOTE session для real-time тиков** → не реализуем в этом плане.
   Текущий спред берётся через `/quote` endpoint Twelve Data перед каждым входом.

6. **Рыночные данные в forex менее доступны** → volume profile и orderflow скоры
   будут нулевыми/нейтральными. Итоговый max confluence score снижается, нужно
   уменьшить пороги: `entryThreshold: 40` вместо 60 для forex.

---

## Forex vs Crypto: ключевые отличия в коде

| Аспект | Crypto | Forex |
|--------|--------|-------|
| Размер позиции | qty в монетах | lots (0.01-100) |
| Стоимость пипа | нет понятия | `pipValueUsd = lots × lotSize × pipSize` |
| SL/TP | в цене или % | в пипсах ИЛИ в цене |
| Торговые часы | 24/7 | Mon-Fri, 00:00-22:00 UTC |
| Выходные | нет | суббота-воскресенье — no trade |
| Комиссии | fee rate | спред (bid-ask) |
| Leverage | деривативы | маржинальная торговля |
| Data source | Bybit REST (встроено) | Twelve Data REST (внешний) |
| Orderflow data | OI, funding, orderbook | недоступно |
| Сессионность | нет | London, NY, Asia |

---

## Definition of Done

- [ ] `market-data.getKlines()` возвращает OHLC[] для всех 8 пар и 4 ТФ
- [ ] `npm run trade:forex:monitor -- --heartbeat` работает без ошибок
- [ ] `npm run trade:forex:monitor -- --trade` в dry-run анализирует пары и логирует сигналы
- [ ] Kill switch останавливает торговлю и закрывает позиции
- [ ] FTMO daily loss limit активирует stop day
- [ ] Decision journal пишется в `data/forex-decisions.jsonl`
- [ ] Telegram отчёт отправляется по расписанию
- [ ] 40+ тестов, все зелёные
- [ ] `npm run lint && npm run build` — успешно
- [ ] Нет hardcoded credentials — API key только из `.env`
