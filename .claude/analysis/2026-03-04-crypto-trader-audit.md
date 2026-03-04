---
type: analysis
topic: Аудит крипто-трейдера — возможности для улучшения
date: 2026-03-04
status: completed
tags: [crypto, audit, profit, risk, reliability, architecture]
---

# Аудит крипто-трейдера: возможности улучшения

**Дата:** 2026-03-04
**Файлы проанализированы:**
- `src/trading/crypto/monitor.ts`
- `src/trading/crypto/bybit-client.ts`
- `src/trading/crypto/config.ts`
- `src/trading/shared/confluence.ts`
- `src/trading/shared/indicators.ts`
- `src/trading/shared/regime.ts`
- `src/trading/shared/volume-analysis.ts`
- `src/trading/crypto/state.ts`

---

## ПРИОРИТЕТ 1 — КРИТИЧЕСКИЕ ПРОБЛЕМЫ (высокий ROI, средний effort)

### [PROFIT][RISK] #1 — Спред-фильтр объявлен, но НЕ применяется

**Файл:** `monitor.ts`, `config.ts`
**Проблема:** В `config.ts` есть `maxSpreadPercent: 0.1`, в `bybit-client.ts` считается `spread` в OrderbookData. Но в `analyzePairV2` и `executeSignals` спред никогда не проверяется перед открытием позиции.
**Риск:** Вход в сделку при аномально широком спреде (например, при низкой ликвидности DOGEUSDT ночью) = немедленный убыток на спреде.
**Решение:** Добавить в `analyzePairV2` проверку:
```typescript
const spreadPct = (orderbook.spread / market.lastPrice) * 100;
if (spreadPct > config.maxSpreadPercent) return null;
```
**Effort:** 15 мин | **ROI:** Прямое снижение потерь на исполнении.

---

### [PROFIT][RISK] #2 — Funding rate объявлен, но НЕ блокирует вход

**Файл:** `monitor.ts`, `config.ts`
**Проблема:** `config.ts` имеет `maxFundingRate: 0.0005` и `minFundingRate: -0.0005`. `MarketInfo` содержит `fundingRate`. Но в `analyzePairV2` и `executeSignals` нет блокировки входа при экстремальном funding.
**Риск:** Открытие лонга при funding rate +0.1% (=~3x норма) — каждые 8 часов платим 0.1% от размера позиции, что съедает прибыль и повышает риск.
**Решение:** В `analyzePairV2` после получения `market`:
```typescript
if (market.fundingRate > config.maxFundingRate && side === 'Buy') return null;
if (market.fundingRate < config.minFundingRate && side === 'Sell') return null;
```
**Effort:** 20 мин | **ROI:** Избегаем входов против финансирования, где crowd уже перегружен.

---

### [RISK] #3 — getQtyPrecision — хардкод без реальных данных биржи

**Файл:** `monitor.ts` строки 492-497
**Проблема:**
```typescript
function getQtyPrecision(symbol: string): number {
  if (symbol.startsWith('BTC')) return 3;
  if (symbol.startsWith('ETH')) return 2;
  if (symbol.startsWith('SOL')) return 1;
  return 1; // XRPUSDT, DOGEUSDT, AVAXUSDT, ADAUSDT, DOTUSDT — все 1?
}
```
DOGEUSDT на Bybit имеет шаг 1.0 (целые числа), AVAXUSDT = 0.1, ADAUSDT = 1.0, LINKUSDT = 0.1, ARBUSDT = 1.0. Хардкод `1` для всех альткоинов некорректен.
**Риск:** Отклонение ордера биржей (`Order rejected: qty precision error`), или открытие позиции с неверным размером.
**Решение:** Получить `lotSizeFilter` из Bybit Instruments Info API и кэшировать:
```typescript
// bybit-client.ts
export async function getInstrumentInfo(symbol: string): Promise<{qtyStep: number, minQty: number}>
```
**Effort:** 1-2 часа | **ROI:** Устранение ошибок исполнения на альткоинах.

---

### [PROFIT] #4 — roundPrice — хардкод без тиков биржи

**Файл:** `monitor.ts` строки 506-510
**Проблема:**
```typescript
function roundPrice(val: number, symbol: string): number {
  if (symbol.startsWith('BTC')) return parseFloat(val.toFixed(1));  // BTC тик = 0.1 — OK
  if (symbol.startsWith('ETH')) return parseFloat(val.toFixed(2));  // ETH тик = 0.01 — OK
  return parseFloat(val.toFixed(4));  // SOL тик = 0.001, XRP = 0.0001 — не универсально
}
```
Для SOLUSDT тик = 0.001, но toFixed(4) даёт лишнюю точность. Для DOGEUSDT тик = 0.00001.
**Риск:** Limit ордер с ценой не кратной тику = отклонение Bybit.
**Решение:** Использовать `priceFilter.tickSize` из Instruments Info (кешируется вместе с #3).
**Effort:** В связке с #3 | **ROI:** Предотвращение rejected orders по цене.

---

### [RISK] #5 — partial_close не обновляет TP после частичного закрытия

**Файл:** `monitor.ts` строки 191-225
**Проблема:** При частичном закрытии (50% позиции на 1R) SL переносится в безубыток (`entry`). Но TP остаётся без изменений — он был рассчитан на полный размер.
После частичного закрытия оставшаяся половина позиции:
- SL = entry (breakeven)
- TP = entry + ATR*1.5*minRR (был рассчитан на точку входа)

Проблема не в TP как таковом, а в том, что TP не пересчитывается под новый risk profile: если тренд сильный, можно было бы вынести TP дальше для оставшейся части (trail to 3R вместо 2R).
**Решение:** После partial close запустить пересчёт TP с коэффициентом `minRR * 1.5` для оставшейся части:
```typescript
const newTp = pos.side === 'long'
  ? entry + slDistance * config.minRR * 1.5
  : entry - slDistance * config.minRR * 1.5;
await modifyPosition(pos.symbol, String(entry), String(newTp));
```
**Effort:** 30 мин | **ROI:** Увеличение среднего R на выигрышных сделках.

---

## ПРИОРИТЕТ 2 — ВАЖНЫЕ УЛУЧШЕНИЯ (хороший ROI, средний effort)

### [PROFIT] #6 — Trailing SL использует фиксированное расстояние, не ATR

**Файл:** `monitor.ts` строки 228-265
**Проблема:**
```typescript
const trailingDistance = slDistance * config.trailingDistanceR; // = 0.5 * initial SL distance
```
Initial SL distance = 1.5 * ATR на момент открытия. Но при движении цены волатильность меняется. В тренде ATR обычно расширяется — trailing должен адаптироваться.
**Решение:** Запрашивать текущий ATR из кеша (уже есть в MarketAnalysis) и использовать его для trailing:
```typescript
// Получаем актуальный ATR для символа
const currentAtr = await getCurrentAtr(pos.symbol);
const trailingDistance = currentAtr * config.trailingDistanceR;
```
**Effort:** 1 час | **ROI:** Более точный trailing, меньше преждевременных стопов.

---

### [RELIABILITY] #7 — Stale Limit ордера не отменяются

**Файл:** `monitor.ts`, `bybit-client.ts`
**Проблема:** `getOpenOrders` только проверяет "есть ли ордер для символа". Нет логики отмены ордеров, которые висят слишком долго (например, Limit Buy BTC при 95000, а цена ушла на 97000 — ордер никогда не исполнится).
**Данные доступны:** `bybit-client.ts` возвращает список ордеров — можно получить `createdTime`, `price`, текущую цену.
**Риск:** Замороженная маржа под стейл ордера = нельзя открыть новые позиции.
**Решение:** В `managePositions()` или отдельная функция:
```typescript
async function cancelStaleOrders(maxAgeMinutes = 30, maxPriceDeviationPct = 1.0) {
  // Получить open orders с деталями (не только символы)
  // Если ордер старше 30 мин и цена ушла > 1% от limit price — отменить
}
```
**Effort:** 2 часа | **ROI:** Освобождение маржи, актуальные сигналы.

---

### [PROFIT] #8 — S/R уровни = просто min/max за 20 баров

**Файл:** `indicators.ts` строки 302-314
**Проблема:**
```typescript
export function calculateSupportResistance(...) {
  return {
    support: Math.min(...recentLows),      // просто минимум за 20 баров
    resistance: Math.max(...recentHighs),   // просто максимум за 20 баров
  };
}
```
Это не S/R — это просто диапазон. Настоящие уровни поддержки/сопротивления — это кластеры, где цена многократно разворачивалась. При таком подходе `scoreStructure` в confluence некорректно оценивает "цена у support".
**Решение:** Заменить на pivot-based S/R или кластерный алгоритм:
```typescript
// Найти локальные минимумы/максимумы (fractals)
// Сгруппировать близкие уровни в кластеры
// Вернуть сильнейший ближайший уровень
```
**Effort:** 3-4 часа | **ROI:** Значительное улучшение качества структурного скоринга (модуль 15% веса).

---

### [RELIABILITY] #9 — Параллельный анализ 12 пар = 84 API запроса за раз

**Файл:** `monitor.ts` строки 276-285, `analyzePairV2` строки 299-325
**Проблема:** Для каждой из 12 пар выполняется 12 параллельных запросов = 144 запроса одновременно. `Promise.all` не имеет ограничения на concurrency.
**Bybit rate limits:** 10-20 req/sec на IP для REST public endpoints. 144 запроса мгновенно = возможный rate limit 429.
**Текущее состояние:** `retryAsync` с retries=2 защищает частично, но не предотвращает burst.
**Решение:** Добавить p-limit или chunked Promise.all:
```typescript
// Анализировать пары группами по 3-4
const chunks = chunk(pairs, 4);
for (const chunk of chunks) {
  await Promise.all(chunk.map(analyzePair));
  await delay(500); // 500ms между группами
}
```
**Effort:** 1 час | **ROI:** Стабильность работы, без rate limit ошибок.

---

### [PROFIT] #10 — Нет учёта корреляции между парами

**Файл:** `executeSignals`, `config.ts`
**Проблема:** Можно одновременно открыть ETHUSDT Long, AVAXUSDT Long, ARBUSDT Long, OPUSDT Long — все 4 пары исторически коррелируют с ETH (r > 0.85). Это не 4 независимые сделки, а 1 большая ставка на ETH-экосистему.
**Риск:** При падении ETH все 4 позиции ударятся по SL одновременно — 4x дневной риск.
**Решение:** Фильтр коррелированных сигналов: не открывать >1 позиции в одной "группе" (ETH-экосистема: ETH/AVAX/ARB/OP/LINK/DOT, BTC-dominated: BTC/SOL/XRP/DOGE/ADA/MATIC).
**Effort:** 2-3 часа | **ROI:** Реальное улучшение риск-менеджмента.

---

## ПРИОРИТЕТ 3 — КАЧЕСТВЕННЫЕ УЛУЧШЕНИЯ (умеренный ROI, умеренный effort)

### [PROFIT] #11 — Entry всегда bid1/ask1, нет учёта стакана

**Файл:** `monitor.ts` строки 366-367
**Проблема:**
```typescript
const entry = side === 'Buy'
  ? (orderbook.bids[0]?.price ?? price)  // всегда bid1
  : (orderbook.asks[0]?.price ?? price); // всегда ask1
```
Bid1 — это текущая лучшая цена покупателей. Limit Buy по bid1 имеет риск не исполниться если цена идёт вверх. Лучше: bid1 + небольшой offset, или анализировать плотность стакана.
**Решение:** Для Buy: `entry = Math.min(ask1 * 0.9995, bid1 * 1.001)` — чуть выше рынка для быстрого исполнения, но всё ещё лучше market price.
**Effort:** 30 мин | **ROI:** Умеренное улучшение fill rate.

---

### [ARCHITECTURE] #12 — Конфиг хардкодит ATR-коэффициент 1.5 в двух местах

**Файл:** `monitor.ts` строки 106, 370
**Проблема:**
```typescript
// Строка 106 (SL-Guard дефолтный SL):
const slDist = atrEstimate ? atrEstimate * 1.5 : entry * 0.02;

// Строка 370 (основной расчёт SL):
const slDistance = atr * 1.5;
```
Магическое число `1.5` присутствует дважды, не в конфиге. Нет возможности настроить без изменения кода.
**Решение:** Добавить в `TradingConfig`:
```typescript
slAtrMultiplier: number;  // default: 1.5
```
**Effort:** 20 мин | **ROI:** Возможность A/B тестировать 1.2 vs 1.5 vs 2.0 без изменения кода.

---

### [ARCHITECTURE] #13 — config.ts не читает ~/.openclaw/openclaw.json

**Файл:** `config.ts`
**Проблема:** Конфиг торговца жёстко захардкожен в коде. Изменение любого параметра (riskPerTrade, pairs, maxDailyLoss) требует коммита и деплоя. Учитывая что `utils/config.ts` уже умеет читать `~/.openclaw/openclaw.json` — торговый конфиг тоже должен приходить оттуда.
**Решение:** Добавить секцию `crypto_trader` в `~/.openclaw/openclaw.json` и читать оттуда через `utils/config.ts`:
```typescript
const config: TradingConfig = {
  ...hardcodedDefaults,
  ...getOpenClawConfig().crypto_trader,  // override из конфига
};
```
**Effort:** 2 часа | **ROI:** Оперативная настройка без деплоя, разные профили (aggressive/conservative).

---

### [RELIABILITY] #14 — recordTrade никогда не вызывается автоматически

**Файл:** `state.ts` строки 172-198
**Проблема:** `state.recordTrade()` существует, DailyStats считает wins/losses/stops. Но в `monitor.ts` при исполнении ордера вызывается только `state.logEvent('order_opened')`. Нет механизма определения закрытия позиции (win/loss).
**Симптом:** В state.json `daily.trades`, `daily.wins`, `daily.losses` всегда = 0 (или не обновляются корректно).
**Решение:** Сравнивать список позиций между циклами — если позиция исчезла, рассчитать PnL и вызвать `recordTrade`. Или использовать Bybit closed PnL API (`/v5/position/closed-pnl`).
**Effort:** 2-3 часа | **ROI:** Корректная дневная статистика, правильный подсчёт stops для `maxStopsPerDay`.

---

### [RELIABILITY] #15 — Нет дедупликации сигналов между циклами

**Файл:** `monitor.ts`
**Проблема:** Каждые 10 минут (`monitorIntervalMin: 10`) система запускается заново. Если сигнал сгенерирован, но Limit ордер не исполнился (цена не достигла) — в следующем цикле будет SKIP ("pending order already exists"). Но если ордер был отменён вручную, следующий цикл сгенерирует новый сигнал — возможно с другими параметрами.
**Нет проблемы:** Это поведение корректно. НО: нет логирования "почему конкретный сигнал пропущен из-за существующего ордера" с деталями предыдущего ордера.
**Решение:** Логировать orderId существующего ордера при SKIP.
**Effort:** 15 мин | **ROI:** Лучшая наблюдаемость.

---

### [PROFIT] #16 — Confluence weights захардкожены, нет A/B тестирования

**Файл:** `confluence.ts` строки 23-32
**Проблема:**
```typescript
export const DEFAULT_CONFLUENCE_CONFIG: ConfluenceConfig = {
  trendWeight: 0.25,
  momentumWeight: 0.15,
  volumeWeight: 0.15,
  structureWeight: 0.15,
  orderflowWeight: 0.15,
  regimeWeight: 0.15,
  ...
};
```
Нет исторических данных о том, какой модуль лучше предсказывает прибыльные сделки. `ConfluenceConfig` уже в интерфейсе, можно передавать через `ConfluenceInput.config` — но этим никто не пользуется.
**Решение:** Добавить логирование `{trend, momentum, volume, structure, orderflow, regime}` для каждой сделки с финальным PnL → backtesting/оптимизация весов по историческим данным.
**Effort:** 3-4 часа | **ROI:** Потенциально значительное улучшение accuracy сигналов.

---

### [RISK] #17 — calcPositionSize не учитывает leverage в расчёте риска

**Файл:** `state.ts` строки 318-328
**Проблема:**
```typescript
export function calcPositionSize(entryPrice: number, stopLoss: number): number {
  const riskAmount = Math.min(balance * config.riskPerTrade, config.maxRiskPerTrade);
  const slDistance = Math.abs(entryPrice - stopLoss);
  return riskAmount / slDistance;
}
```
`riskAmount = balance * 0.02` = $X. При leverage 3x фактически задействованная маржа = qty * entryPrice / 3. Risk = slDist * qty. Всё корректно — leverage не должен влиять на risk расчёт (риск = расстояние до SL * размер). НО: не проверяется что `qty * entryPrice / leverage <= availableBalance`. Позиция может быть слишком большой для доступной маржи.
**Решение:** Добавить проверку маржи:
```typescript
const requiredMargin = qty * entryPrice / config.defaultLeverage;
if (requiredMargin > balance.available * 0.9) {
  qty = (balance.available * 0.9 * config.defaultLeverage) / entryPrice;
}
```
**Effort:** 30 мин | **ROI:** Предотвращение ошибки "insufficient balance" при открытии ордера.

---

## ПРИОРИТЕТ 4 — МЕЛКИЕ УЛУЧШЕНИЯ (низкий effort, умеренный ROI)

### [RELIABILITY] #18 — Нет timeout на весь цикл analyzeMarket

**Файл:** `monitor.ts`
**Проблема:** При зависании одного из 12+ API запросов (timeout = 10s, retries = 2 → 20s) вся функция `analyzeMarket` может занять 30+ секунд. При цикле 10 минут это некритично, но при увеличении пар — проблема.
**Решение:** `Promise.race` с общим таймаутом 25s на весь analyzeMarket.
**Effort:** 20 мин.

---

### [ARCHITECTURE] #19 — console.log в main вместо logger

**Файл:** `monitor.ts` строки 523, 561
**Проблема:**
```typescript
console.log(JSON.stringify(report, null, 2));  // строки 523, 561
```
Используется `console.log` вместо `log.info`. Нарушает конвенцию проекта ("Логгер: createLogger — no console.log").
**Решение:** Заменить на `log.info('Monitor report', report)` или оставить `console.log` только для structured output (тогда документировать исключение).
**Effort:** 5 мин.

---

### [RELIABILITY] #20 — getOpenOrders возвращает только символы, без деталей

**Файл:** `bybit-client.ts` строки 255-268
**Проблема:**
```typescript
export async function getOpenOrders(symbol?: string): Promise<string[]> {
  // Возвращает только массив символов ['BTCUSDT', 'ETHUSDT']
}
```
Нельзя получить: orderId, price, qty, createdTime — нужно для #7 (отмена stale ордеров) и #15 (логирование).
**Решение:** Изменить return type на `Array<{symbol, orderId, price, qty, createdTime}>`.
**Effort:** 30 мин (вместе с #7).

---

## Сводная таблица приоритетов

| # | Категория | Описание | Effort | ROI |
|---|-----------|----------|--------|-----|
| 1 | [PROFIT][RISK] | Применить спред-фильтр | 15 мин | Высокий |
| 2 | [PROFIT][RISK] | Применить funding rate фильтр | 20 мин | Высокий |
| 3 | [RISK] | Заменить хардкод qty precision на Bybit API | 2 ч | Высокий |
| 4 | [RISK] | Заменить хардкод roundPrice на tickSize | В связке с #3 | Высокий |
| 5 | [PROFIT] | Пересчитывать TP после partial close | 30 мин | Высокий |
| 6 | [PROFIT] | Адаптивный trailing (текущий ATR) | 1 ч | Средний |
| 7 | [RELIABILITY] | Отменять stale Limit ордера | 2 ч | Средний |
| 8 | [PROFIT] | Улучшить S/R уровни (pivot/кластеры) | 4 ч | Высокий |
| 9 | [RELIABILITY] | Rate limiting для параллельных запросов | 1 ч | Средний |
| 10 | [PROFIT] | Корреляционный фильтр пар | 3 ч | Высокий |
| 11 | [PROFIT] | Улучшить Entry price (не всегда bid1) | 30 мин | Низкий |
| 12 | [ARCHITECTURE] | Вынести ATR multiplier в конфиг | 20 мин | Низкий |
| 13 | [ARCHITECTURE] | Конфиг из ~/.openclaw/openclaw.json | 2 ч | Средний |
| 14 | [RELIABILITY] | recordTrade при закрытии позиции | 3 ч | Средний |
| 15 | [RELIABILITY] | Логировать orderId при SKIP | 15 мин | Низкий |
| 16 | [PROFIT] | A/B тестирование весов confluence | 4 ч | Высокий |
| 17 | [RISK] | Проверка доступной маржи в calcPositionSize | 30 мин | Средний |
| 18 | [RELIABILITY] | Timeout на весь цикл analyzeMarket | 20 мин | Низкий |
| 19 | [ARCHITECTURE] | console.log → log.info | 5 мин | Низкий |
| 20 | [RELIABILITY] | getOpenOrders с деталями ордеров | 30 мин | Средний |

---

## Рекомендуемый план реализации

### Спринт 1 — "Быстрые победы" (~3 часа суммарно)
- #1 Спред-фильтр (15 мин)
- #2 Funding rate фильтр (20 мин)
- #5 TP пересчёт после partial close (30 мин)
- #12 ATR multiplier в конфиг (20 мин)
- #17 Проверка маржи (30 мин)
- #19 console.log → logger (5 мин)
- #15 SKIP логирование (15 мин)

### Спринт 2 — "Надёжность" (~5 часов)
- #3 + #4 Instrument Info API (qty precision + tick size)
- #7 + #20 Stale orders отмена + getOpenOrders с деталями
- #9 Rate limiting
- #14 recordTrade при закрытии

### Спринт 3 — "Качество сигналов" (~8 часов)
- #8 Улучшенные S/R уровни
- #10 Корреляционный фильтр
- #6 Адаптивный trailing ATR
- #13 Конфиг из openclaw.json

### Спринт 4 — "Оптимизация" (~5 часов)
- #16 A/B тестирование весов + исторический backtest
- #11 Улучшение entry price
- #18 Таймаут analyzeMarket
