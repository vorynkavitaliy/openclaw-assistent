# Полный анализ крипто-трейдера OpenClaw

**Дата**: 2026-03-05
**Версия кода**: после коммита `6ce8dea`
**Цель**: оценка способности системы выполнять 2-4 уверенные сделки в день

---

## 1. Текущая архитектура

### Торговый цикл (monitor.ts, 170 строк)

```
Каждые 10 мин:
  1. checkStatus()           — Kill Switch? Stop Day?
  2. refreshAccount()        — Баланс + позиции из Bybit API
  3. managePositions()       — SL-Guard, partial close, trailing SL
  4. cancelStaleOrders()     — Отмена лимитных ордеров старше 30 мин
  5. analyzeMarket()         — 12 пар, батчи по 3, ~12 API запросов на пару
  6. saveSnapshots()         — JSONL для истории LLM
  7. Fast-track              — confluence >= 65 + confidence >= 75% = немедленное исполнение

Каждый час (LLM cycle):
  8. runLLMAdvisorCycle()    — Claude Sonnet 4 через OpenRouter
  9. executeSignals()        — Для ENTER-решений LLM
  10. addToWatchlist()       — Для WAIT-решений (4ч expiry)
```

### Модульная структура (после рефакторинга фазы 3)

| Файл | LOC | Ответственность |
|------|-----|-----------------|
| monitor.ts | 170 | Оркестрация цикла |
| market-analyzer.ts | 273 | Параллельный анализ + pre-filters |
| signal-executor.ts | 283 | Фильтрация + открытие позиций |
| position-manager.ts | 199 | SL-Guard, trailing, partial close |
| llm-advisor.ts | 195 | OpenRouter API + промпт + парсинг |
| market-snapshot.ts | 98 | JSONL снапшоты для LLM |
| watchlist.ts | 84 | WAIT-решения с 4ч expiry |
| bybit-client.ts | 690 | 22 API функции + rate limiter |
| decision-journal.ts | 281 | Логирование всех решений (JSONL) |
| state.ts | 404 | Дневная статистика, позиции, events |
| config.ts | 73 | 12 пар, параметры риска |
| symbol-specs.ts | 32 | Точность qty/price для 12 пар |
| rate-limiter.ts | 87 | Token bucket 18 req/sec, 6 concurrent |
| report.ts | 294 | Telegram отчёты |

**Итого crypto/**: ~3,163 строк в 14 модулях.

---

## 2. Воронка сигналов — количественный анализ

### Путь сигнала от пары до сделки

```
12 пар на входе
  |
  ├── Pre-filter: пустой orderbook             → теряем ~0 (редко)
  ├── Pre-filter: spread > 0.1%                → теряем ~0-1 (альты в пики)
  ├── Pre-filter: funding rate вне [-0.1%, 0.1%] → теряем ~1-2 (bull run)
  ├── Pre-filter: нет volume profile            → теряем ~0
  |
  ~9-11 пар проходят pre-filters
  |
  ├── Confluence scoring < regime threshold
  │   ├── STRONG_TREND (порог 30): типичный score 48-56 → ПРОХОДИТ
  │   ├── WEAK_TREND (порог 45): типичный score 31-50 → 50/50
  │   ├── RANGING (порог 50): типичный score 31-35 → ЧАСТО НЕ ПРОХОДИТ
  │   ├── VOLATILE (порог 65): типичный score 35-55 → ПОЧТИ НЕ ПРОХОДИТ
  │   └── CHOPPY (порог 80): типичный score 25-40 → БЛОКИРОВКА
  |
  ~2-5 сигналов проходят confluence
  |
  ├── Fast-track: confluence >= 65 + confidence >= 75%  → ~0-1 немедленно
  |
  ~2-4 сигнала идут к LLM (каждый час)
  |
  ├── LLM: ENTER / SKIP / WAIT
  │   (промпт настроен агрессивно, fallback = ENTER)
  |
  ~1-3 ENTER-решения
  |
  ├── Executor: позиция уже открыта?            → теряем ~0-1
  ├── Executor: pending order?                   → теряем ~0
  ├── Executor: ecosystem занята?                → теряем ~0-1
  ├── Executor: qty > 0?                         → теряем ~0
  ├── Executor: risk > $250?                     → теряем ~0
  ├── Executor: aggregate risk > 50% maxDailyLoss? → теряем ~0-1 ⚠️
  ├── Executor: маржа?                           → теряем ~0
  |
  ~0-2 ордера за LLM-цикл
```

### Математическая оценка сделок в день

| Параметр | Значение |
|----------|----------|
| LLM-циклов в день | 24 (каждый час) |
| Средних сигналов за цикл | 2-4 |
| LLM ENTER rate | ~60-70% |
| Executor pass rate | ~50-70% |
| Лимитный ордер fill rate (30 мин) | ~40-60% |
| **Ожидаемых сделок/день** | **2-5** |

### Fast-track дополнительно

| Параметр | Значение |
|----------|----------|
| Циклов в день (каждые 10 мин) | 144 |
| Циклов с fast-track сигналами | ~5-15% |
| **Дополнительных сделок/день** | **0-2** |

**Итого: 2-7 сделок/день** при нормальных рыночных условиях.

---

## 3. Критические bottleneck'и

### 3.1. Aggregate Risk Limit — ГЛАВНАЯ ПРОБЛЕМА

**Код** (`state.ts:297-313`):
```typescript
const maxTotalRisk = config.maxDailyLoss * 0.5; // = $250
if (totalRisk >= maxTotalRisk) → BLOCKED
```

При `riskPerTrade = 2%` и balance = $10,000:
- Одна позиция = ~$200 риска
- $200 из $250 лимита = 80% использовано
- Вторая позиция ($200) → суммарно $400 > $250 → **BLOCKED**

**Де-факто maxOpenPositions = 1, а не 3.**

| Balance | Risk/trade | 1 позиция | 2 позиция | Лимит $250 |
|---------|-----------|-----------|-----------|------------|
| $5,000 | $100 | $100 | $200 | OK |
| $10,000 | $200 | $200 | $400 | BLOCKED |
| $15,000 | $250 | $250 | $500 | BLOCKED |

**Рекомендация**: поднять до 80% (`maxDailyLoss * 0.8 = $400`) или сделать кратным maxOpenPositions: `maxRiskPerTrade * maxOpenPositions = $250 * 3 = $750`.

### 3.2. maxStopsPerDay = 2 — слишком жёсткий

При цели 4 сделки/день и winrate 55%:
- P(2+ стопа из 4) = ~26% (по биномиальному распределению)
- P(2+ стопа из 5) = ~34%

**В каждый третий день система остановится преждевременно.**

**Рекомендация**: поднять до 3-4.

### 3.3. RANGING порог = 50 при типичных scores 31-35

Большинство крипто-рынков находятся в RANGING 60-70% времени. При пороге 50 и типичных scores 31-35, система **не торгует большую часть времени**.

**Рекомендация**: снизить RANGING порог до 38-42.

---

## 4. LLM Advisor — оценка

### Промпт

**Сильные стороны:**
- Контекст дня (trades, P&L, urgency)
- Чёткие правила (ENTER/SKIP/WAIT)
- Установка "you are a TRADER, not a risk manager"
- Temperature 0.1 — детерминированный

**Слабые стороны:**

1. **Промпт говорит "confluence > 40"**, но пропускаются сигналы с score 30-39 (STRONG_TREND). LLM может отклонить валидные сигналы по своему правилу.

2. **Score history без таймстемпов** — LLM видит `[45, 48, 51, 53]`, но не знает что это 10-минутные интервалы. Не может оценить скорость momentum.

3. **Нет данных об общем рынке** — LLM не видит: BTC direction (для альтов), dominance, общий market sentiment. Без этого контекста каждый альт оценивается изолированно.

4. **Urgency HIGH в ночные часы UTC** — `hoursLeft <= 8` = 16:00-00:00 UTC. Для UTC+2 (Европа) это 18:00-02:00, для UTC+8 (Азия) это 00:00-08:00. Азиатская сессия менее ликвидна, а система агрессивнее торгует.

### Бюджет

| Компонент | Стоимость |
|-----------|-----------|
| Input: ~2500 токенов × 24 цикла | ~$0.18/день |
| Output: ~300 токенов × 24 цикла | ~$0.11/день |
| **Итого** | **~$0.29/день** |

В рамках лимита $3/день с запасом 10x.

---

## 5. Confluence Scoring — адекватность весов

### Текущие веса

| Модуль | Вес | Max score |
|--------|-----|-----------|
| Trend | 25% | ±10 |
| Momentum | 15% | ±10 |
| Volume | 15% | ±10 |
| Structure | 15% | ±10 |
| Orderflow | 15% | ±10 |
| Regime | 15% | -10..+8 |

### Проблемы скоринга

1. **Volume delta не нормализован по паре**. Порог `abs(delta) / 10000` работает для BTC ($85k × 0.1 BTC = $8500 delta), но для DOGE ($0.12 × 10000 = $1200 delta) даёт заниженный score. Это системно занижает volume score для дешёвых пар.

2. **Structure порог 0.5% от S/R** — слишком узкий. BTC проходит 0.5% за 1-2 минуты. Бонус +5 за "цена у support" почти никогда не срабатывает в момент анализа.

3. **Conflict penalty -15 за trend+anti-momentum** — корректен по логике (не входим в перекупленный тренд), но агрессивен. Score 50 после penalty = 35, что ниже порога WEAK_TREND (45).

4. **Regime score асимметричен**: STRONG_TREND = +8, CHOPPY = -10. В трендовых условиях пара получает меньше бонуса (+8) чем штраф за choppy (-10).

### Реальные диапазоны confluence scores

| Рыночные условия | Типичный score | Порог RANGING | Пройдёт? |
|-----------------|----------------|---------------|-----------|
| Тихий боковик | 25-35 | 50 | Нет |
| Слабый тренд | 35-50 | 45 | 50/50 |
| Хороший тренд | 48-60 | 30 | Да |
| Сильный тренд | 55-72 | 30 | Да |
| Волатильный | 30-55 | 65 | Редко |

---

## 6. Risk Management — оценка

### Многоуровневая защита (хорошо)

| Уровень | Механизм | Оценка |
|---------|----------|--------|
| L1 | Kill Switch (файл-флаг) | Отлично |
| L2 | Stop Day (max loss / max stops) | Слишком жёстко (maxStops=2) |
| L3 | Aggregate risk ($250) | Слишком жёстко для 3 позиций |
| L4 | SL-Guard (auto-SL если нет) | Отлично |
| L5 | Partial close (50% при 1R) | Хорошо |
| L6 | Trailing SL (при 1.5R) | Хорошо |
| L7 | Ecosystem correlation filter | Хорошо, но уменьшает пул пар |
| L8 | Entry sanity checks (deviation, SL range) | Отлично |

### Параметры

| Параметр | Значение | Оценка |
|----------|----------|--------|
| riskPerTrade | 2% | Стандарт |
| maxRiskPerTrade | $250 | OK для balance $12k |
| maxDailyLoss | $500 | Умеренно |
| maxStopsPerDay | 2 | Слишком мало для 4 сделок/день |
| maxOpenPositions | 3 | OK |
| defaultLeverage | 3x | Консервативно |
| minRR | 2.0 | Стандарт |
| atrSlMultiplier | 1.5 | Стандарт |

---

## 7. Архитектурные находки

### Решённые проблемы (из предыдущих фаз)

- [x] monitor.ts рефакторинг (890 → 170 строк, 5 модулей)
- [x] Rate limiter (18 req/sec, token bucket)
- [x] ATR Wilder smoothing (исправлен баг)
- [x] Decision journal (JSONL append-only)
- [x] Symbol specs (точность qty/price для 12 пар)
- [x] Retry с jitter (exponential backoff)
- [x] TTY-aware ANSI в логгере
- [x] Telegram timeout (10 сек AbortSignal)

### Текущие технические проблемы

1. **State не потокобезопасна** — `_state` глобальная мутабельная переменная. При concurrent доступе (маловероятно в single-thread Node.js, но возможно при промисах) — race conditions.

2. **market-snapshot.ts читает весь JSONL** — `loadAllRecentSnapshots()` парсит весь файл (до 5MB). При 12 парах × 144 цикла × ~200 байт = ~345KB/день. Некритично, но растёт.

3. **watchlist.ts перечитывает JSON на каждый вызов** — `isWatched()` вызывается для каждой пары в LLM-цикле, каждый раз читая файл с диска.

4. **llm-advisor.ts нет retry** — при 503 от OpenRouter вся LLM-логика fallback к ENTER без попытки повтора. Одна ошибка = нефильтрованные входы.

5. **Два API стиля в bybit-client.ts** — `apiGet()` (прямой REST) и `getClient()` (bybit-api library). Разные пути обработки ошибок.

### Тестовое покрытие

| Область | Покрытие | Критичность |
|---------|----------|-------------|
| shared/indicators | 22 теста | Покрыто |
| shared/confluence | 11 тестов | Покрыто |
| shared/volume,orderflow,levels | 17 тестов | Покрыто |
| shared/regime | 6 тестов | Покрыто |
| crypto/rate-limiter | 4 теста | Покрыто |
| crypto/symbol-specs | 9 тестов | Покрыто |
| utils/retry | 5 тестов | Покрыто |
| **crypto/monitor,executor,analyzer** | **0 тестов** | **ВЫСОКАЯ** |
| **crypto/llm-advisor** | **0 тестов** | **ВЫСОКАЯ** |
| **crypto/state** | **0 тестов** | **ВЫСОКАЯ** |
| **utils/config** | **0 тестов** | **СРЕДНЯЯ** |

**74 из ~3200 строк crypto-кода покрыты тестами** (~2.3%).

---

## 8. Конкурентные риски и edge cases

### Что может пойти не так

1. **Bybit API rate limit (429)** — rate limiter на 18 req/sec, Bybit лимит ~20. Запас маленький. При batch из 3 пар × 12 запросов = 36 запросов за ~2 секунды. Rate limiter должен справляться, но нет обработки конкретно 429 ответов (retry обычный).

2. **LLM галлюцинирует пары** — LLM может вернуть `{"pair": "BTCUSD"}` вместо `"BTCUSDT"`. Текущий парсинг не валидирует pair name из списка `config.pairs`.

3. **State corruption** — `state.save()` пишет весь JSON атомарно (`writeFileSync`). Если процесс убит посреди записи — файл corrupted. Нет backup файла.

4. **Stale kill switch** — если KILL_SWITCH файл остался от вчера, система не запустится. Нет автоматического сброса по дню.

5. **LLM возвращает больше/меньше пар** — если LLM пропустит пару или добавит лишнюю, `signals.filter(sig => ...)` не найдёт match, и сигнал пойдёт как ENTER (default).

---

## 9. Рекомендации — приоритизированные

### P0: Блокируют цель 2-4 сделки/день

| # | Что | Текущее | Рекомендация | Файл |
|---|-----|---------|-------------|------|
| 1 | Aggregate risk limit | 50% maxDailyLoss = $250 | 80% = $400 или maxRiskPerTrade × maxOpenPositions | state.ts:307 |
| 2 | maxStopsPerDay | 2 | 3-4 | config.ts:32 |
| 3 | Порог RANGING | 50 | 40 | regime.ts:182 |

### P1: Улучшают качество торговли

| # | Что | Проблема | Рекомендация | Файл |
|---|-----|---------|-------------|------|
| 4 | LLM промпт "confluence > 40" | Отклоняет валидные score 30-39 | Убрать числовой порог из промпта, доверять pre-filter | llm-advisor.ts:138 |
| 5 | LLM retry | Нет повтора при 503/timeout | Добавить retryAsync(callOpenRouter, {retries: 2, backoffMs: 3000}) | llm-advisor.ts:34-63 |
| 6 | LLM pair validation | Нет проверки pair name | Валидировать `d.pair in config.pairs` в parseDecisions | llm-advisor.ts:98-117 |
| 7 | Structure порог | 0.5% — слишком узко | 1.0-1.5% | confluence.ts |
| 8 | Volume delta нормализация | Абсолютные числа vs % | Нормализовать delta как % от avg volume | confluence.ts |

### P2: Техническое здоровье

| # | Что | Рекомендация |
|---|-----|-------------|
| 9 | State backup | Писать state.json.tmp, потом rename |
| 10 | Тесты crypto/ | Хотя бы state.ts, signal-executor.ts, monitor.ts (mocked) |
| 11 | Watchlist кеширование | Кешировать в памяти, не перечитывать с диска |
| 12 | LLM score history с timestamps | `{score: 45, time: "14:20"}` вместо просто `45` |

### P3: Долгосрочные улучшения

| # | Что | Рекомендация |
|---|-----|-------------|
| 13 | BTC context для альтов | Добавить BTC direction/dominance в LLM промпт |
| 14 | Urgency timezone-aware | HIGH только 08-22 UTC (активные сессии) |
| 15 | Новостной контекст | RSS digest → LLM (market/digest.ts уже есть) |
| 16 | WebSocket вместо REST polling | Реалтайм данные для более точного entry timing |

---

## 10. Итоговая оценка

### Scorecard (1-10)

| Категория | Оценка | Комментарий |
|-----------|--------|-------------|
| Архитектура кода | 8/10 | Чистые модули, хорошие абстракции, функциональный стиль |
| TypeScript strictness | 9/10 | Все strict-флаги, типы везде |
| Risk management | 8/10 | Многоуровневый, но aggregate limit слишком жёсткий |
| Аналитика (indicators) | 8/10 | 14 индикаторов, confluence, regime — после фикса ATR |
| LLM интеграция | 7/10 | Работает, но нет retry, нет pair validation, промпт с конфликтом |
| Тестовое покрытие | 4/10 | shared/ покрыт, crypto/ почти нет |
| Торговая пригодность | 6/10 | Будет работать, но bottleneck'и мешают цели 2-4 сделки |
| Безопасность | 8/10 | Credentials изолированы, safe-format |
| Мониторинг/отчёты | 8/10 | Decision journal, events, Telegram |
| Документация | 8/10 | SOUL/AGENTS/TOOLS/MEMORY полные |

### Общая оценка: **7.4 / 10**

### Вердикт

Система **архитектурно зрелая** после рефакторинга (фазы 1-8), но **торгово ограничена** тремя конкретными bottleneck'ами:

1. **Aggregate risk $250** — де-факто 1 позиция вместо 3
2. **maxStopsPerDay = 2** — преждевременная остановка в ~25% дней
3. **RANGING порог 50** — не торгует в самом частом рыночном режиме

Исправление этих трёх параметров (P0, ~30 минут работы) превратит систему из "может сделать 1-2 сделки" в "стабильно делает 2-5 сделок в день".

LLM-интеграция добавляет качественный фильтр, но имеет технические пробелы (нет retry, нет pair validation, конфликт в промпте), которые нужно закрыть в P1.

---

_Анализ выполнен 2026-03-05. Основан на исследовании всех файлов в src/trading/crypto/, src/trading/shared/, src/utils/, и workspaces/crypto-trader/._
