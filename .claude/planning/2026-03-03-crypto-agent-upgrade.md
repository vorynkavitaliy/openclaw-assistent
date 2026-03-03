---
type: plan
title: Улучшение крипто-агента — путь к 70% winrate при 2+ сделках/день
date: 2026-03-03
status: draft
priority: high
complexity: XL
---

# План: Улучшение крипто-агента для качественных торговых решений

## Цель

Добиться 70%+ winrate при минимум 2 сделках в день. Агент должен:

- Анализировать рынок на основе ДАННЫХ, а не случайных совпадений индикаторов
- Иметь систему confluence scoring для оценки качества каждого входа
- Получать расширенные данные (orderbook, volume, OI, liquidations)
- Определять рыночный режим и адаптировать стратегию
- Использовать multi-timeframe confirmation (D1→H4→H1→M15→M5)

## Анализ текущего состояния

Детальный анализ: `.claude/analysis/2026-03-03-crypto-agent-problems.md`

**Ключевые проблемы:**

- Нет confluence scoring — бинарная логика входов
- Нет анализа объёма — breakout на низком volume = ловушка
- Примитивный S/R (min/max 20 баров) — не реальные уровни
- 2 из 4 таймфреймов не используются (H1, M5)
- Нет детекции рыночного режима
- Нет orderbook/OI/liquidation analysis
- Market orders вместо limit

## Архитектура решения

```
┌─────────────────────────────────────────────────────┐
│              ENHANCED SNAPSHOT (snapshot-v2.ts)       │
│  Собирает ВСЕ данные в один JSON:                    │
│  • Multi-TF analysis (D1, H4, H1, M15, M5)         │
│  • Orderbook depth + imbalance                       │
│  • Volume profile + VWAP                             │
│  • OI delta (history 24h)                            │
│  • Funding rate history (24h)                        │
│  • Liquidation zones                                 │
│  • Correlation matrix                                │
│  • Market regime                                     │
│  • Fear & Greed + BTC dominance                      │
└────────────────────┬────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────┐
│           CONFLUENCE ENGINE (confluence.ts)           │
│  Каждый фактор → score от -10 до +10:               │
│                                                       │
│  1. Trend (HTF alignment)          weight: 25%       │
│  2. Momentum (RSI zones)           weight: 15%       │
│  3. Volume (confirmation)          weight: 15%       │
│  4. Structure (S/R levels)         weight: 15%       │
│  5. Orderflow (OB + funding)       weight: 15%       │
│  6. Regime (trending/ranging)      weight: 15%       │
│                                                       │
│  Total score: -100..+100                              │
│  LONG entry: score > +60                              │
│  SHORT entry: score < -60                             │
│  HOLD: -60..+60                                       │
└────────────────────┬────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────┐
│              AI AGENT DECISION LAYER                  │
│  AI-агент получает:                                  │
│  • Raw snapshot + confluence scores                   │
│  • Pre-computed signal quality                        │
│  • Рекомендуемые entry/SL/TP                         │
│  • Market regime context                              │
│                                                       │
│  AI РЕШАЕТ: подтвердить, отклонить, модифицировать   │
│  AI МОЖЕТ: увидеть паттерны, которые код пропустит   │
└─────────────────────────────────────────────────────┘
```

## Затронутые файлы

### Новые файлы

- `src/trading/shared/confluence.ts` — Confluence Scoring Engine
- `src/trading/shared/volume-analysis.ts` — Volume Profile, VWAP, Volume Delta
- `src/trading/shared/orderflow.ts` — Orderbook analysis, OI delta, liquidation zones
- `src/trading/shared/regime.ts` — Market Regime Detector (trending/ranging/volatile)
- `src/trading/shared/correlation.ts` — Correlation matrix между парами
- `src/trading/shared/levels.ts` — Улучшенный S/R (pivot points, volume clusters)
- `src/trading/crypto/snapshot-v2.ts` — Расширенный snapshot с всеми данными

### Модифицируемые файлы

- `src/trading/shared/indicators.ts` — исправить RSI (Wilder smoothing), добавить MACD, Stochastic, VWAP
- `src/trading/shared/types.ts` — новые типы: ConfluenceScore, MarketRegime, VolumeProfile, OrderflowData
- `src/trading/crypto/bybit-client.ts` — добавить: getOrderbook(), getOIHistory(), getFundingHistory(), getRecentTrades()
- `src/trading/crypto/config.ts` — confluence thresholds, regime parameters
- `src/trading/crypto/monitor.ts` — заменить analyzePair() на confluence engine
- `scripts/crypto_check.sh` — использовать snapshot-v2.ts
- `scripts/trading_control.sh` — добавить auto-trade cron, обновить start/stop
- `workspaces/crypto-trader/SOUL.md` — обновить инструкции с confluence context
- `workspaces/crypto-trader/HEARTBEAT.md` — обновить алгоритм решений
- `workspaces/orchestrator/SOUL.md` — обновить trigger words, команды активации
- `workspaces/orchestrator/AGENTS.md` — исправить команды start/stop, описать штатный режим

## Этапы реализации

### Этап 1: Расширенный сбор данных (developer) — L

**1.1 Новые API-функции в bybit-client.ts**

```typescript
// Orderbook depth (top 25 уровней)
export async function getOrderbook(symbol: string, limit: number = 25): Promise<OrderbookData>;

// Open Interest history (24h, 5min intervals)
export async function getOIHistory(symbol: string, hours: number = 24): Promise<OIDataPoint[]>;

// Funding rate history (последние 20 записей)
export async function getFundingHistory(
  symbol: string,
  limit: number = 20,
): Promise<FundingDataPoint[]>;

// Recent trades (последние 1000 сделок для volume delta)
export async function getRecentTrades(symbol: string, limit: number = 1000): Promise<TradeRecord[]>;
```

Bybit API endpoints:

- `/v5/market/orderbook` — orderbook depth до 200 уровней
- `/v5/market/open-interest` — OI с intervalTime: '5min'
- `/v5/market/funding/history` — funding rate history
- `/v5/market/recent-trade` — последние сделки

**1.2 Новые типы в types.ts**

```typescript
interface OrderbookData {
  bids: Array<{ price: number; qty: number }>;
  asks: Array<{ price: number; qty: number }>;
  bidWallPrice: number; // самая большая стена покупок
  askWallPrice: number; // самая большая стена продаж
  imbalance: number; // -1..+1 (отношение bid/ask volume)
  spread: number; // ask1 - bid1
  timestamp: string;
}

interface OIDataPoint {
  timestamp: string;
  openInterest: number;
  delta: number; // изменение vs предыдущий
}

interface FundingDataPoint {
  timestamp: string;
  rate: number;
}

type MarketRegime = 'STRONG_TREND' | 'WEAK_TREND' | 'RANGING' | 'VOLATILE' | 'CHOPPY';

interface ConfluenceScore {
  total: number; // -100..+100
  trend: number; // -10..+10
  momentum: number; // -10..+10
  volume: number; // -10..+10
  structure: number; // -10..+10
  orderflow: number; // -10..+10
  regime: number; // -10..+10
  signal: 'STRONG_LONG' | 'LONG' | 'NEUTRAL' | 'SHORT' | 'STRONG_SHORT';
  confidence: number; // 0..100%
  details: string[]; // человекочитаемые причины
}

interface VolumeProfile {
  vwap: number;
  volumeDelta: number; // buy_vol - sell_vol
  relativeVolume: number; // текущий volume / avg volume
  highVolumeNodes: number[]; // уровни с повышенным объёмом
}
```

**Оценка:** M (2-3 часа)

---

### Этап 2: Улучшенные индикаторы (developer) — M

**2.1 Исправить RSI (Wilder smoothing)**

Текущий RSI использует simple average. Стандарт Wilder использует smoothed:

```typescript
// Wilder smoothing: avgGain = (prevAvgGain * (period-1) + currentGain) / period
```

**2.2 Добавить MACD**

```typescript
export function calculateMACD(
  closes: number[],
  fast: number = 12,
  slow: number = 26,
  signal: number = 9,
): {
  macd: number;
  signal: number;
  histogram: number;
};
```

**2.3 Добавить Stochastic RSI**

```typescript
export function calculateStochRSI(
  closes: number[],
  period: number = 14,
  kPeriod: number = 3,
  dPeriod: number = 3,
): {
  k: number;
  d: number;
};
```

**2.4 Добавить VWAP**

```typescript
export function calculateVWAP(candles: OHLC[]): number;
```

**2.5 Улучшить Support/Resistance (levels.ts)**

```typescript
export function calculatePivotLevels(candles: OHLC[]): {
  pivotPoint: number;
  r1: number;
  r2: number;
  r3: number;
  s1: number;
  s2: number;
  s3: number;
};

export function findVolumeClusterLevels(
  candles: OHLC[],
  bins: number = 50,
): {
  highVolumeLevels: number[]; // уровни с максимальным объёмом
  pocPrice: number; // Point of Control (max volume)
  valueAreaHigh: number; // 70% volume area high
  valueAreaLow: number; // 70% volume area low
};
```

**Оценка:** M (2-3 часа)

---

### Этап 3: Market Regime Detector (developer) — M

Файл: `src/trading/shared/regime.ts`

```typescript
export function detectMarketRegime(candles: OHLC[], indicators: Indicators): MarketRegime {
  // 1. ADX (Average Directional Index) > 25 = trending, < 20 = ranging
  // 2. ATR ratio: current ATR / ATR-50 average — volatility spike detection
  // 3. Bollinger Band width: narrow = ranging, expanding = breakout
  // 4. EMA fan: 20/50/200 aligned = strong trend, crossing = transition
  // Return:
  // STRONG_TREND: ADX > 40, EMAs aligned, ATR normal
  // WEAK_TREND: ADX 25-40, partial alignment
  // RANGING: ADX < 20, ATR low, BB narrow
  // VOLATILE: ATR spike (> 2x normal), BB expanding
  // CHOPPY: frequent EMA crosses, no clear direction
}
```

**Стратегия по режимам:**

| Режим        | Стратегия                         | Min Score | RSI Buy/Sell  |
| ------------ | --------------------------------- | --------- | ------------- |
| STRONG_TREND | Trend-following, pullback entries | 50        | 40-45 / 55-60 |
| WEAK_TREND   | Conservative trend + S/R          | 65        | 35-40 / 60-65 |
| RANGING      | S/R bounce, fade extremes         | 70        | < 30 / > 70   |
| VOLATILE     | Только limit orders, wider SL     | 75        | < 25 / > 75   |
| CHOPPY       | НЕ ТОРГОВАТЬ (или tiny positions) | 85        | -             |

**Оценка:** M (2-3 часа)

---

### Этап 4: Confluence Scoring Engine (developer) — L

Файл: `src/trading/shared/confluence.ts`

Ядро системы. Каждый модуль оценивает ситуацию по шкале -10..+10:

```typescript
export function calculateConfluenceScore(data: {
  trendTF: MarketAnalysis; // D1 or H4
  entryTF: MarketAnalysis; // M15
  precisionTF: MarketAnalysis; // M5
  zonesTF: MarketAnalysis; // H1
  orderbook: OrderbookData;
  oiHistory: OIDataPoint[];
  fundingHistory: FundingDataPoint[];
  volumeProfile: VolumeProfile;
  regime: MarketRegime;
  market: MarketInfo;
}): ConfluenceScore;
```

**Модуль 1: Trend Score (weight 25%)**

```
+10: D1 BULLISH + H4 BULLISH + H1 BULLISH (полное alignment)
+7:  H4 BULLISH + H1 BULLISH (без D1 confirmation)
+4:  H4 BULLISH только
 0:  Нет ясного тренда
-4:  H4 BEARISH только
-7:  H4 BEARISH + H1 BEARISH
-10: D1 BEARISH + H4 BEARISH + H1 BEARISH
```

**Модуль 2: Momentum Score (weight 15%)**

```
+10: RSI_M15 в зоне momentum (40-50 для лонга) + StochRSI K > D + MACD > Signal
+7:  RSI хороший + 1 из 2 подтверждений
+4:  RSI в допустимой зоне
 0:  RSI нейтральный (50)
-4:  RSI в зоне перекупленности для лонга (> 65)
-10: RSI overbought (>70) + StochRSI overbought + MACD bearish cross
```

**Модуль 3: Volume Score (weight 15%)**

```
+10: Volume > 2x average + positive delta (больше покупок)
+7:  Volume > 1.5x + положительная delta
+4:  Volume above average
 0:  Normal volume
-4:  Low volume (< 0.7x average) — слабый сигнал
-10: Volume divergence (цена растёт, volume падает)
```

**Модуль 4: Structure Score (weight 15%)**

```
+10: Цена у strong support (volume cluster) + pivot level + VWAP
+7:  Support + 1 confirmation (pivot OR volume)
+4:  Цена у S/R level
 0:  Цена в середине range
-4:  Цена далеко от уровней
-10: Цена у resistance при лонге / support при шорте
```

**Модуль 5: Orderflow Score (weight 15%)**

```
+10: OB imbalance bullish + OI growing + funding neutral/negative (contrarian)
+7:  2 из 3 подтверждений
+4:  1 подтверждение
 0:  Нейтральный orderflow
-4:  OB imbalance против направления
-10: Funding extreme + OI divergence + OB against
```

**Модуль 6: Regime Score (weight 15%)**

```
+10: STRONG_TREND в направлении сигнала
+7:  WEAK_TREND в направлении
+4:  RANGING (для S/R bounce strategy)
 0:  Transition between regimes
-5:  VOLATILE (повышенный риск)
-10: CHOPPY (торговать нельзя)
```

**Итоговый score:**

```typescript
total = trend * 0.25 + momentum * 0.15 + volume * 0.15
      + structure * 0.15 + orderflow * 0.15 + regime * 0.15

// Нормализация к -100..+100
normalized = total * 10

// Решение:
if (normalized > 60)  → STRONG_LONG  (confidence: 80-100%)
if (normalized > 40)  → LONG         (confidence: 60-80%)
if (normalized > -40) → NEUTRAL      (confidence: -)
if (normalized > -60) → SHORT        (confidence: 60-80%)
else                  → STRONG_SHORT (confidence: 80-100%)
```

**Оценка:** L (4-6 часов)

---

### Этап 5: Расширенный snapshot-v2.ts (developer) — M

Новый snapshot для AI-агента с ВСЕМИ данными + confluence scores:

```typescript
interface SnapshotV2 {
  // Всё из текущего Snapshot +
  pairAnalysis: Array<{
    pair: string;
    timeframes: {
      d1: MarketAnalysis | null;
      h4: MarketAnalysis;
      h1: MarketAnalysis;
      m15: MarketAnalysis;
      m5: MarketAnalysis;
    };
    orderbook: OrderbookData;
    oiHistory: OIDataPoint[]; // 24h, 5min intervals
    fundingHistory: FundingDataPoint[]; // 20 last
    volumeProfile: VolumeProfile;
    regime: MarketRegime;
    confluence: ConfluenceScore;
    // Pre-computed trade setup (if score > threshold)
    suggestedTrade: {
      side: 'Buy' | 'Sell';
      entry: number;
      sl: number;
      tp1: number; // conservative (1:1.5)
      tp2: number; // standard (1:2)
      tp3: number; // aggressive (1:3)
      qty: string;
      rr: number;
    } | null;
  }>;
  correlationMatrix: Record<string, Record<string, number>>;
  bestSetups: string[]; // top-3 пары по confluence score
}
```

**Оценка:** M (2-3 часа)

---

### Этап 6: Обновить monitor.ts (developer) — M

Заменить `analyzePair()` на confluence engine:

```typescript
async function analyzePair(pair: string): Promise<TradeSignalInternal | null> {
  // 1. Собрать multi-TF data
  const [d1, h4, h1, m15, m5] = await Promise.all([...]);

  // 2. Собрать orderflow data
  const [orderbook, oiHistory, fundingHistory, trades] = await Promise.all([...]);

  // 3. Рассчитать volume profile
  const volumeProfile = calculateVolumeProfile(m15 candles, trades);

  // 4. Определить regime
  const regime = detectMarketRegime(h4 candles, h4.indicators);

  // 5. Рассчитать confluence score
  const score = calculateConfluenceScore({ ... });

  // 6. Решение на основе score + regime threshold
  const threshold = REGIME_THRESHOLDS[regime]; // 50-85
  if (Math.abs(score.total) < threshold) return null;

  // 7. Рассчитать entry/SL/TP на основе levels
  // ... использовать pivot points + volume clusters для SL/TP

  return signal;
}
```

Также: изменить orderType на 'Limit' по умолчанию (price = bid1/ask1 с offset).

**Оценка:** M (2-3 часа)

---

### Этап 7: Обновить crypto_check.sh и workspace (developer) — M

**7.1 crypto_check.sh** → использовать snapshot-v2.ts:

```bash
echo "=== MARKET SNAPSHOT V2 ==="
cd "$PROJECT_DIR" && npx tsx src/trading/crypto/snapshot-v2.ts 2>&1
```

**7.2 workspaces/crypto-trader/SOUL.md** → обновить секцию "How You Work":

- Описать confluence scoring и что значат scores
- Объяснить market regime и как адаптировать решения
- Добавить таблицу интерпретации: score > 60 = входить, 40-60 = limit order, < 40 = hold

**7.3 workspaces/crypto-trader/HEARTBEAT.md** → обновить алгоритм:

- Call 1: crypto_check.sh (уже включает snapshot-v2 с confluence)
- Call 2: AI анализирует confluence scores → принимает решение
- Новые инструкции: "фокусируйся на парах из bestSetups"

**7.4 trading_control.sh v2** — обновить скрипт для нового режима:

Текущий `trading_control.sh` создаёт один cron (heartbeat каждые 2ч). Новый режим "штатная торговля" включает ДВА процесса:

```
┌─────────────────────────────────────────────────────────┐
│  "Штатный режим" = trading_control.sh start crypto-trader│
│                                                          │
│  1. Cron: LLM heartbeat каждые 2ч                       │
│     → crypto_check.sh (snapshot-v2 + confluence)         │
│     → LLM-агент анализирует + торгует                    │
│     → Telegram отчёт                                     │
│                                                          │
│  2. Cron: auto-trade каждые 10мин                        │
│     → auto-trade.ts (TypeScript, без LLM, $0)            │
│     → score > 75 → выставить limit order                 │
│     → manage позиции: trailing SL, partial close         │
│     → Логировать в confluence_log.jsonl                   │
│                                                          │
│  Стоимость: ~$0.48-1.50/день (только LLM heartbeat)     │
│  Auto-trade: $0 (чистый TypeScript)                      │
└─────────────────────────────────────────────────────────┘
```

Изменения в `trading_control.sh`:

```bash
# do_start() — создаёт ДВА cron'а:
create_cron "crypto-trader"          # heartbeat каждые 2ч (LLM)
create_autotrade_cron "crypto-trader" # auto-trade каждые 10мин (TypeScript)

# do_stop() — удаляет ОБА:
remove_cron "crypto-trader"
remove_autotrade_cron "crypto-trader"
```

Новая функция `create_autotrade_cron()`:

```bash
create_autotrade_cron() {
  local agent="$1"
  # Запуск auto-trade.ts каждые 10 минут через системный cron
  # (не через openclaw cron — это чистый TypeScript, без LLM)
  local cron_entry="*/10 * * * * cd ${PROJECT_DIR} && node dist/trading/crypto/auto-trade.js >> ${LOG_DIR}/autotrade_\$(date -u +\%Y-\%m-\%d).log 2>&1"
  # Добавить в crontab
}
```

**7.5 workspaces/orchestrator/SOUL.md и AGENTS.md** → обновить команды:

Текущая проблема: в AGENTS.md команды `start`/`stop` указаны без агента.

Обновить SOUL.md — секция Type 1 Control Commands:

```markdown
| User says                              | You run                                                        |
| -------------------------------------- | -------------------------------------------------------------- |
| "активируй крипто" / "запусти крипто" | `bash scripts/trading_control.sh start crypto-trader`          |
| "стоп крипто" / "останови крипто"     | `bash scripts/trading_control.sh stop crypto-trader`           |
| "активируй форекс"                    | `bash scripts/trading_control.sh start forex-trader`           |
| "стоп форекс"                         | `bash scripts/trading_control.sh stop forex-trader`            |
| "активируй всё" / "запусти оба"      | `start crypto-trader && start forex-trader`                    |
| "статус" / "что с торговлей"          | `bash scripts/trading_control.sh status`                       |
```

Добавить в SOUL.md маппинг слов → действие:

```markdown
## TRIGGER WORDS → ACTION MAP

| Ключевые слова                                      | Действие     |
| --------------------------------------------------- | ------------ |
| активируй, запусти, начни, старт, go, start, торгуй | → START      |
| стоп, останови, выключи, halt, stop, пауза          | → STOP       |
| статус, как дела, что с торговлей, отчёт, report    | → STATUS     |
| баланс, позиции, P&L                                | → Type 2 (urgent к агенту) |
| закрой, открой, купи, продай                        | → Type 2 (urgent к агенту) |
```

Обновить AGENTS.md — секция Trading Control:

```markdown
## Trading Control

Штатный режим = ДВА процесса:
1. LLM heartbeat каждые 2ч (агент анализирует + торгует) = ~$0.48/день
2. Auto-trade каждые 10мин (TypeScript, без LLM) = $0/день

bash scripts/trading_control.sh start crypto-trader  # Запуск ОБОИХ процессов
bash scripts/trading_control.sh stop crypto-trader   # Остановка ОБОИХ
bash scripts/trading_control.sh status               # Показать что активно
```

**Оценка:** M (2-3 часа)

---

### Этап 8: Тестирование (tester) — L

**8.1 Unit tests для confluence engine:**

```typescript
// confluence.test.ts
describe('Confluence Scoring', () => {
  it('should return STRONG_LONG when all factors aligned', () => {});
  it('should return NEUTRAL in choppy market', () => {});
  it('should penalize volume divergence', () => {});
  it('should respect regime thresholds', () => {});
  it('should handle missing data gracefully', () => {});
});
```

**8.2 Unit tests для новых индикаторов:**

```typescript
// indicators.test.ts (расширить)
describe('RSI Wilder', () => {
  it('should match TradingView RSI values', () => {});
});
describe('MACD', () => {});
describe('StochRSI', () => {});
describe('VWAP', () => {});
```

**8.3 Unit tests для market regime:**

```typescript
describe('Market Regime', () => {
  it('should detect strong trend', () => {});
  it('should detect ranging market', () => {});
  it('should detect volatile conditions', () => {});
});
```

**8.4 Integration tests:**

```typescript
describe('Snapshot V2', () => {
  it('should collect all data without errors', () => {});
  it('should handle API timeouts gracefully', () => {});
});
```

**8.5 QA pipeline:**

```bash
npm run lint && npm run build && npm run test:run
```

**Оценка:** L (4-6 часов)

---

## Токен-экономика: $3/день на крипто-трейдера

### Бюджет

**$3/день через OpenRouter** — выделен ИМЕННО на крипто-трейдера. Это комфортный бюджет, позволяющий использовать более мощные модели и более частые вызовы.

### Расчёт стоимости по моделям

При heartbeat каждые 2 часа = 12 вызовов/день. Каждый вызов LLM:
- Input: snapshot JSON (~3000-5000 токенов) + system prompt (~2000 токенов) = ~6000 input
- Output: анализ + команды (~1500 токенов)

| Модель | $/вызов | $/день (12 calls) | Запас бюджета | Возможности |
|--------|---------|-------------------|---------------|-------------|
| GPT-4o-mini | ~$0.005 | ~$0.06 | $2.94 (98%) | Базовый анализ, быстрый |
| GPT-4o | ~$0.04 | ~$0.48 | $2.52 (84%) | Хороший анализ |
| GPT-5.2 | ~$0.10 | ~$1.20 | $1.80 (60%) | Лучший анализ |
| Claude Sonnet | ~$0.03 | ~$0.36 | $2.64 (88%) | Отличный анализ |

**Рекомендация:** Использовать **GPT-4o** как основную модель ($0.48/день = 16% бюджета). Это даёт качественный анализ и огромный запас на дополнительные вызовы.

### Архитектура: гибридная (код + LLM)

С бюджетом $3/день можно позволить **каждый heartbeat через LLM** с хорошей моделью. Но принцип "КОД готовит, LLM решает" остаётся — это повышает КАЧЕСТВО решений, а не только экономит токены:

```
┌─────────────────────────────────────────────────────┐
│  TypeScript (БЕСПЛАТНО — подготовка данных)          │
│                                                      │
│  1. snapshot-v2.ts собирает ВСЕ данные               │
│  2. confluence.ts рассчитывает scores                │
│  3. regime.ts определяет рыночный режим             │
│  4. Формирует ГОТОВЫЙ trade plan с confidence        │
│                                                      │
│  OUTPUT: pre-computed scores + suggested trades      │
│  "BTCUSDT: score=82 LONG, ETHUSDT: score=45 NEUTRAL"│
└────────────────────┬────────────────────────────────┘
                     │
                     ▼ (КАЖДЫЙ heartbeat — бюджет позволяет)
┌─────────────────────────────────────────────────────┐
│  LLM Agent (GPT-4o — $0.04/вызов)                   │
│                                                      │
│  Получает: pre-computed scores + top setups          │
│  + контекст: новости, корреляции, macro              │
│                                                      │
│  Роль: ПРИНИМАЕТ финальное решение                   │
│  - Подтвердить/отклонить/модифицировать setup        │
│  - Учесть факторы которые код не видит (новости)     │
│  - Выбрать лучший из нескольких setup'ов             │
│  - Отправить Telegram отчёт                          │
└─────────────────────────────────────────────────────┘
```

### Режимы работы

| Режим | LLM вызовов/день | Модель | $/день | Когда |
|-------|-------------------|--------|--------|-------|
| **STANDARD** | 12 (каждые 2ч) | GPT-4o | $0.48 | Обычный режим |
| **ACTIVE** | 24 (каждый час) | GPT-4o | $0.96 | Высокая волатильность |
| **PREMIUM** | 12 | GPT-5.2 | $1.20 | Важные торговые дни |
| **BUDGET** | 12 | GPT-4o-mini | $0.06 | Экономия / боковик |

**Стандартный режим $0.48/день** — основной. Запас $2.52 на:
- Дополнительные вызовы при сильных сигналах (+$0.50)
- Утренний/вечерний развёрнутый отчёт (+$0.10)
- Экстренные ситуации (killswitch, drawdown) (+$0.20)
- **Итого реалистично: $0.80-1.50/день** — запас 50-73%.

### Auto-trade fallback (при недоступности LLM)

Если OpenRouter недоступен или бюджет исчерпан — код торгует автономно:
- score > 75 → автоматический limit order (без LLM)
- score 40-75 → записать в pending, дождаться LLM
- score < 40 → skip

### Хранение данных: файловая БД вместо Redis

Redis — overkill для этой задачи. Используем **JSON файлы + JSONL лог**:

```
data/
├── state.json           — текущее состояние (уже есть)
├── events.jsonl         — лог событий (уже есть)
├── cache/
│   ├── orderbook_{symbol}.json    — кэш orderbook (TTL 30s)
│   ├── oi_history_{symbol}.json   — OI history (TTL 5min)
│   └── funding_{symbol}.json      — funding history (TTL 1h)
├── history/
│   ├── trades.jsonl               — история всех сделок (append-only)
│   ├── signals.jsonl              — история всех сигналов (win/loss)
│   └── daily_stats.jsonl          — ежедневная статистика
└── analysis/
    └── confluence_log.jsonl       — лог confluence scores для backtest
```

**Кэширование:**
- Orderbook: кэш 30 секунд (частые запросы, быстро устаревает)
- OI history: кэш 5 минут (данные за 24h, обновляются каждые 5min)
- Funding: кэш 1 час (обновляется каждые 8h)
- Klines: кэш 1 минуту для M5, 5 минут для M15, 15 минут для H1+

Файловый кэш: `fs.readFileSync` + проверка mtime < TTL. Не нужен Redis.

### Новый Этап 0: Auto-Trade Engine (ВМЕСТО чистого LLM)

Файл: `src/trading/crypto/auto-trade.ts`

```typescript
/**
 * Auto-Trade Engine — принимает решения БЕЗ LLM.
 *
 * 1. Собрать snapshot-v2 (все данные)
 * 2. Рассчитать confluence scores
 * 3. score > 75 → AUTO execute (limit order)
 * 4. score 40-75 → записать в pending_signals для LLM review
 * 5. score < 40 → skip
 * 6. Управление позициями: partial close, trailing SL
 * 7. Записать лог в data/analysis/confluence_log.jsonl
 */
export async function runAutoTrade(): Promise<AutoTradeResult>
```

Запуск через cron каждые 10 минут (как сейчас monitor.ts):
```bash
*/10 * * * * npx tsx src/trading/crypto/auto-trade.ts
```

LLM вызывается ТОЛЬКО для:
- Утренний обзор (08:00 UTC) — "что случилось за ночь, план на день"
- Вечерний обзор (20:00 UTC) — "результаты дня, что ожидать"
- Спорные ситуации (score 40-75, >2 конфликтующих setup'а)

### Обратная связь: обучение на своих сделках

Файл: `src/trading/shared/feedback.ts`

```typescript
/**
 * Анализирует историю сделок и корректирует веса confluence.
 * Запускается раз в день в 00:00 UTC.
 *
 * 1. Читает data/history/signals.jsonl за последние 30 дней
 * 2. Группирует: какие факторы были у win vs loss
 * 3. Корректирует веса в config (trend: 25% → 28% если тренд предсказывал лучше)
 * 4. Записывает скорректированные веса в data/weights.json
 */
export function analyzeTradeHistory(): WeightAdjustment
```

Это бесплатно (чистый TypeScript) и даёт «обучение» без ML.

## Риски

| Риск                                               | Вероятность | Влияние  | Митигация                                                                  |
| -------------------------------------------------- | ----------- | -------- | -------------------------------------------------------------------------- |
| API rate limits от Bybit (доп. запросы)            | medium      | high     | Batch requests, кэшировать на 30s, WebSocket для orderbook                 |
| Confluence engine даёт мало сигналов (< 2/день)    | medium      | high     | Понизить threshold для STRONG_TREND режима (50 вместо 60), расширить pairs |
| Ложная уверенность (high score но wrong direction) | low         | high     | Backtest на исторических данных перед live, paper trading 1 неделю         |
| Увеличение latency snapshot (больше API calls)     | medium      | medium   | Parallel API calls (Promise.all), timeout 5s на каждый                     |
| HyroTrade prop account rules violation             | low         | critical | Встроить жёсткие лимиты в confluence engine (reject if violates)           |
| OpenRouter бюджет $3/день превышен                 | very low    | low      | Стандартный режим $0.48/день = 16% бюджета. Fallback на GPT-4o-mini. Auto-trade при недоступности LLM |

## Обеспечение минимум 2 сделок в день

Стратегия для гарантии частоты:

1. **12 пар** × **каждые 2 часа** = 144 оценки в день. Даже при 2% hit rate = 2-3 сделки
2. **Adaptive thresholds**: если к 14:00 UTC нет ни одной сделки, снизить threshold на 10% (с 60 до 54)
3. **Limit orders на лучших уровнях**: если нет market signals, ставить limit orders на confluence > 40 парах у ключевых уровней
4. **Multi-pair scanning**: не только BTC/ETH, а все 12 пар. Альткоины часто имеют более чёткие сигналы

## Приоритет реализации

0. **Этап 0** (auto-trade + кэш) — фундамент токен-экономики
1. **Этап 1** (API) + **Этап 2** (индикаторы) — фундамент данных, параллельно
2. **Этап 3** (regime) — зависит от Этапа 2
3. **Этап 4** (confluence) — зависит от Этапов 1-3, ЯДРО СИСТЕМЫ
4. **Этап 5** (snapshot-v2) — зависит от Этапа 4
5. **Этап 6** (monitor → auto-trade integration) — зависит от Этапов 0+4
6. **Этап 7** (workspace) — зависит от Этапов 5-6
7. **Этап 8** (тесты) — параллельно с каждым этапом
8. **Этап 9** (feedback loop) — после накопления 20+ сделок

## Definition of Done

- [ ] Confluence engine рассчитывает score для каждой пары
- [ ] snapshot-v2 включает все новые данные + confluence scores
- [ ] monitor.ts использует confluence engine вместо бинарной логики
- [ ] Market regime detector работает и адаптирует thresholds
- [ ] RSI исправлен (Wilder smoothing)
- [ ] Orderbook, OI history, funding history собираются
- [ ] Все тесты проходят: `npm run test:run`
- [ ] `npm run lint && npm run build` — без ошибок
- [ ] crypto_check.sh обновлён для snapshot-v2
- [ ] SOUL.md и HEARTBEAT.md обновлены с confluence контекстом
- [ ] Auto-trade engine работает без LLM при score > 75
- [ ] Файловый кэш для API данных (orderbook/OI/funding)
- [ ] Feedback loop анализирует win/loss паттерны
- [ ] OpenRouter расход < $1.50/день для крипто-агента (бюджет $3/день)
- [ ] Оркестратор: "активируй крипто" → запускает штатный режим (heartbeat + auto-trade)
- [ ] Оркестратор: "стоп крипто" → останавливает оба процесса
- [ ] trading_control.sh создаёт 2 cron'а: LLM heartbeat (2ч) + auto-trade (10мин)
- [ ] Paper trading 3 дня: winrate > 65%, минимум 2 сделки/день
