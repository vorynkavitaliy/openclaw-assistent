---
id: PLAN-006
title: Smart Money Concepts (SMC) — интеграция в confluence scoring
status: draft
created: 2026-03-11
priority: high
---

## Цель

Добавить детекцию Smart Money Concepts паттернов (Order Blocks, FVG, BOS, CHoCH, Liquidity Sweeps)
в торговый бот. Улучшить качество входов: фильтровать входы у значимых SMC уровней и
добавить самостоятельный модуль в confluence scoring.

Ожидаемый эффект: снижение ложных входов на ~15-20%, улучшение winrate за счёт входов
от институциональных уровней (OB) с подтверждением BOS/CHoCH.

---

## Затронутые модули

- `src/trading/shared/types.ts` — новые интерфейсы SMC (SmcAnalysis, OrderBlock, FairValueGap и др.)
- `src/trading/shared/smart-money.ts` — **новый файл**, детекция всех SMC паттернов
- `src/trading/shared/confluence.ts` — новый Модуль 8 SMC + изменение весов + SMC-фильтр входа
- `src/trading/shared/index.ts` — экспорт нового модуля
- `src/trading/crypto/market-analyzer.ts` — передача SMC данных в ConfluenceInput, SMC-фильтр
- `src/trading/shared/__tests__/smart-money.test.ts` — **новый файл**, тесты

---

## Архитектурные решения (принятые до реализации)

### Решение 1: Отдельный Модуль 8 vs интеграция в Structure

SMC идёт как **Модуль 8 (смешанный)**, не в Structure. Причины:
- SMC имеет собственную логику, не зависящую от S/R уровней
- Модуль 8 добавляет не только score, но и фильтр входа (Entry Gate)
- Structure уже перегружен (Ichimoku, VWAP, S/R)

### Решение 2: Пересчёт весов

Текущий суммарный вес = 100%. После добавления Модуля 8 (вес 10%) нужно пропорционально
снизить остальные. Итоговые веса:

```
До:   trend=22%, momentum=13%, volume=13%, structure=13%, orderflow=13%, regime=13%, candles=13%
После: trend=20%, momentum=12%, volume=12%, structure=12%, orderflow=12%, regime=12%, candles=10%, smc=10%
```

Trend сохраняет доминирование, SMC взвешен умеренно (информационная добавка, не доминанта).

### Решение 3: SMC как Entry Gate (не только scoring)

SMC данные используются двояко:
1. **Scoring**: score от -10 до +10 в confluence.smc
2. **Entry Gate в market-analyzer.ts**: блокировка входа если цена ВНУТРИ antagonist OB

Entry Gate — жёсткий фильтр (возвращает null), не штраф в scoring.
Условие блокировки: `цена внутри Bearish OB при Buy` или `цена внутри Bullish OB при Sell`.

### Решение 4: Lookback окна

| Паттерн | Lookback | Минимум свечей |
|---------|----------|----------------|
| Order Blocks | 50 свечей | 20 |
| FVG | 30 свечей | 10 |
| BOS/CHoCH | 50 свечей (swing detection) | 30 |
| Liquidity Sweeps | 20 свечей | 15 |

Все вычисления на M15 candles (entryCandles из ConfluenceInput).

---

## Детальные интерфейсы

### Новые типы в `types.ts`

```typescript
export interface OrderBlock {
  type: 'BULLISH' | 'BEARISH';
  high: number;
  low: number;
  origin: number;      // цена открытия свечи-источника
  index: number;       // индекс в массиве свечей
  timeISO: string;
  mitigated: boolean;  // цена уже зашла в зону (OB "использован")
  strength: number;    // объём свечи-источника / средний объём (1.0 = average)
}

export interface FairValueGap {
  type: 'BULLISH' | 'BEARISH';
  top: number;         // верхняя граница гэпа
  bottom: number;      // нижняя граница гэпа
  midpoint: number;    // (top + bottom) / 2
  index: number;       // индекс средней свечи (i) в паттерне [i-2, i-1, i]
  timeISO: string;
  filled: boolean;     // цена закрыла гэп
  size: number;        // (top - bottom) / currentPrice * 100 (%)
}

export interface StructureBreak {
  type: 'BOS' | 'CHOCH';
  direction: 'BULLISH' | 'BEARISH';  // направление пробоя
  level: number;       // пробитый уровень (swing high/low)
  index: number;
  timeISO: string;
  confirmed: boolean;  // цена закрылась выше/ниже уровня (не просто вик)
}

export interface LiquiditySweep {
  type: 'HIGH_SWEEP' | 'LOW_SWEEP';
  level: number;       // swept уровень (prev high или prev low)
  sweepHigh: number;   // максимальный выброс
  sweepLow: number;    // минимальный выброс
  index: number;
  timeISO: string;
  recovered: boolean;  // цена вернулась обратно (ложный пробой)
}

export interface SmcAnalysis {
  orderBlocks: OrderBlock[];         // активные (не mitigated), сортировка: ближайшие первые
  fairValueGaps: FairValueGap[];     // активные (не filled), сортировка: ближайшие первые
  structureBreaks: StructureBreak[]; // последние 5 BOS/CHoCH
  liquiditySweeps: LiquiditySweep[]; // последние 3 sweep
  trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL'; // SMC-определение тренда (HH/HL vs LH/LL)
  lastBos: StructureBreak | null;    // последний BOS
  lastChoch: StructureBreak | null;  // последний CHoCH (сигнал разворота)
  nearestBullishOB: OrderBlock | null;  // ближайший bullish OB ниже текущей цены
  nearestBearishOB: OrderBlock | null;  // ближайший bearish OB выше текущей цены
  nearestBullishFVG: FairValueGap | null;
  nearestBearishFVG: FairValueGap | null;
}
```

### Обновление `ConfluenceScore` в `types.ts`

```typescript
export interface ConfluenceScore {
  total: number;
  trend: number;
  momentum: number;
  volume: number;
  structure: number;
  orderflow: number;
  regime: number;
  signal: ConfluenceSignal;
  confidence: number;
  details: string[];
  candlePatterns?: number;
  smc?: number;              // новое поле
  smcAnalysis?: SmcAnalysis; // для Entry Gate в market-analyzer
}
```

### Обновление `ConfluenceConfig` в `types.ts`

```typescript
export interface ConfluenceConfig {
  // ... существующие поля ...
  smcWeight: number;  // новое поле
}
```

### Обновление `ConfluenceInput` в `confluence.ts`

```typescript
export interface ConfluenceInput {
  // ... существующие поля ...
  smcAnalysis?: SmcAnalysis | null; // опциональное — backward compatible
}
```

---

## Алгоритмы детекции

### `detectOrderBlocks(candles, lookback=50): OrderBlock[]`

```
Алгоритм:
1. Найти все импульсные движения: серия из 3+ свечей одного направления,
   где суммарный ход > 1.5 × ATR(14)
2. Для каждого bullish импульса:
   - Последняя bearish свеча ПЕРЕД началом импульса = Bullish OB
   - OB.high = свеча.high, OB.low = свеча.low
3. Для каждого bearish импульса:
   - Последняя bullish свеча ПЕРЕД началом импульса = Bearish OB
4. Отметить mitigated=true если currentPrice уже прошёл сквозь зону OB
   (для Bullish OB: цена опускалась ниже OB.low;
    для Bearish OB: цена поднималась выше OB.high)
5. Возвращать только немитигированные OB, последние lookback свечей
6. strength = объём свечи-источника / avgVolume(20)
```

Упрощение для начального варианта: импульс = следующая свеча после источника
должна закрыться в противоположном направлении с телом > 0.8 × ATR.

### `detectFairValueGaps(candles, lookback=30): FairValueGap[]`

```
Для каждых трёх последовательных свечей [i-2, i-1, i]:
  Bullish FVG: candles[i-2].high < candles[i].low
    → gap.top = candles[i].low, gap.bottom = candles[i-2].high
  Bearish FVG: candles[i-2].low > candles[i].high
    → gap.top = candles[i-2].low, gap.bottom = candles[i].high
  size = (gap.top - gap.bottom) / currentPrice * 100
  Пропускать если size < 0.05% (микрогэпы — шум)
  filled = true если currentPrice прошёл через midpoint в обратную сторону
```

### `detectStructureBreaks(candles, lookback=50): StructureBreak[]`

```
1. Найти swing highs и swing lows (3-барные пивоты, уже реализовано в
   calculateSupportResistance в indicators.ts — можно повторить логику)

2. Определить текущий тренд по последовательности swings:
   HH (higher high) + HL (higher low) = BULLISH
   LH (lower high) + LL (lower low) = BEARISH

3. BOS (Break of Structure):
   В BULLISH тренде: цена закрылась ВЫШЕ последнего swing high → Bullish BOS
   В BEARISH тренде: цена закрылась НИЖЕ последнего swing low → Bearish BOS
   BOS подтверждает продолжение тренда

4. CHoCH (Change of Character):
   В BULLISH тренде: цена закрылась НИЖЕ последнего swing low → Bearish CHoCH
   В BEARISH тренде: цена закрылась ВЫШЕ последнего swing high → Bullish CHoCH
   CHoCH = первый сигнал разворота тренда

5. confirmed = close-основе (не просто wick)
```

### `detectLiquiditySweeps(candles, lookback=20): LiquiditySweep[]`

```
1. Найти significant levels: swing highs и lows за lookback свечей
2. Для каждой свечи проверить:
   HIGH_SWEEP: candle.high > prev_high AND candle.close < prev_high
     → ложный пробой хая, цена вернулась ниже
   LOW_SWEEP: candle.low < prev_low AND candle.close > prev_low
     → ложный пробой лоя, цена вернулась выше
3. recovered = close вернулся за уровень (это и есть определение sweep)
4. Минимальный выброс: (candle.high - prev_high) / prev_high > 0.1%
   (отсекает микровыбросы внутри спреда)
```

### `analyzeSMC(candles, currentPrice): SmcAnalysis`

Оркестратор — вызывает все детекторы и компилирует SmcAnalysis.
Сортирует OB и FVG по близости к currentPrice.

---

## Модуль 8: SMC Scoring в `confluence.ts`

```typescript
function scoreSmcModule(
  smcAnalysis: SmcAnalysis,
  currentPrice: number,
  direction: 'long' | 'short' | 'neutral',
  details: string[],
): number
```

### Логика оценки (итого -10..+10)

**Order Blocks (±4 max):**
- Цена у ближайшего Bullish OB (distancePct < 0.5%) + направление long: +4
- Цена у ближайшего Bullish OB (0.5-1.5%): +2
- Цена у ближайшего Bearish OB (< 0.5%) + направление short: -4 (добавляем к short)
- Bullish OB над ценой (resistance) + short: -2 (ловушка для шортов)

**FVG (±3 max):**
- Цена в незакрытом Bullish FVG + long: +3 (институциональная зона)
- Цена в незакрытом Bearish FVG + short: -3
- Цена приближается к FVG (distancePct < 1%): ±1

**BOS/CHoCH (±4 max):**
- Последний BOS Bullish (последние 5 свечей) + long: +3
- Последний BOS Bearish + short: -3
- CHoCH Bullish (разворот, последние 10 свечей) + long: +4 (сильный сигнал)
- CHoCH Bearish + short: -4
- CHoCH противоположного направления: -2 (предупреждение о развороте)

**Liquidity Sweeps (±2 max):**
- LOW_SWEEP (recovered) + long: +2 (институциональный сбор ликвидности вниз = покупка)
- HIGH_SWEEP (recovered) + short: -2
- Sweep в последних 5 свечах: score усиливается

**SMC Trend alignment (±1):**
- smcAnalysis.trend == 'BULLISH' + direction long: +1
- smcAnalysis.trend == 'BEARISH' + direction short: -1

---

## Entry Gate в `market-analyzer.ts`

Добавить после confluence scoring:

```typescript
// SMC Entry Gate: не входим ВНУТРИ antagonist Order Block
if (smcAnalysis) {
  if (side === 'Buy' && smcAnalysis.nearestBearishOB) {
    const ob = smcAnalysis.nearestBearishOB;
    if (price >= ob.low && price <= ob.high) {
      logDecision(cycleId, 'skip', pair, 'SMC_INSIDE_BEARISH_OB', [
        `Long внутри Bearish OB [${ob.low}–${ob.high}] — институциональная зона продажи`,
      ]);
      return null;
    }
  }
  if (side === 'Sell' && smcAnalysis.nearestBullishOB) {
    const ob = smcAnalysis.nearestBullishOB;
    if (price >= ob.low && price <= ob.high) {
      logDecision(cycleId, 'skip', pair, 'SMC_INSIDE_BULLISH_OB', [
        `Short внутри Bullish OB [${ob.low}–${ob.high}] — институциональная зона покупки`,
      ]);
      return null;
    }
  }
}
```

---

## Этапы реализации

### Этап 1: Типы и ядро детекции (developer)
**Файлы:** `types.ts`, `smart-money.ts`
**Сложность:** M (2-3ч)

1. Добавить интерфейсы в `types.ts`: `OrderBlock`, `FairValueGap`, `StructureBreak`,
   `LiquiditySweep`, `SmcAnalysis`
2. Обновить `ConfluenceScore` (добавить `smc?`, `smcAnalysis?`) и `ConfluenceConfig`
   (добавить `smcWeight`)
3. Создать `src/trading/shared/smart-money.ts`:
   - `detectOrderBlocks(candles, lookback?)`
   - `detectFairValueGaps(candles, lookback?)`
   - `detectStructureBreaks(candles, lookback?)`
   - `detectLiquiditySweeps(candles, lookback?)`
   - `analyzeSMC(candles, currentPrice): SmcAnalysis`

### Этап 2: Confluence Module 8 (developer)
**Файлы:** `confluence.ts`
**Сложность:** S (1ч)

1. Обновить `DEFAULT_CONFLUENCE_CONFIG` — добавить `smcWeight: 0.10`, снизить остальные
2. Добавить `smcAnalysis?: SmcAnalysis | null` в `ConfluenceInput`
3. Реализовать `scoreSmcModule()` функцию
4. Подключить в `calculateConfluenceScore()`:
   - Вызов `scoreSmcModule` если `input.smcAnalysis`
   - Добавить в weighted sum
   - Добавить в возвращаемый объект
5. Обновить `index.ts` — добавить экспорт `smart-money.ts`

### Этап 3: Интеграция в market-analyzer (developer)
**Файлы:** `market-analyzer.ts`
**Сложность:** S (45 мин)

1. Импортировать `analyzeSMC` из `smart-money.js`
2. В `analyzePairV2`: вычислить `smcAnalysis = m15Candles.length >= 30 ? analyzeSMC(m15Candles, price) : null`
3. Передать `smcAnalysis` в `ConfluenceInput`
4. Добавить SMC Entry Gate после confluence scoring (см. алгоритм выше)
5. Добавить SMC данные в `marketData` для Claude (OB уровни, последний BOS/CHoCH)

### Этап 4: Тесты (tester)
**Файлы:** `src/trading/shared/__tests__/smart-money.test.ts`
**Сложность:** M (2ч)

Тест-кейсы для `smart-money.test.ts`:

**detectOrderBlocks:**
- `[bearish, bullish, bullish, bullish]` — должен найти Bullish OB на bearish свече
- `[bullish, bearish, bearish, bearish]` — должен найти Bearish OB на bullish свече
- Mitigated OB: свеча прошла через зону → `mitigated=true`
- Пустой массив / мало свечей → возвращает []

**detectFairValueGaps:**
- `[close=100, gap, close=110]` — `candles[0].high=101 < candles[2].low=109` → Bullish FVG
- `[close=110, gap, close=100]` — `candles[0].low=109 > candles[2].high=101` → Bearish FVG
- FVG size < 0.05% — игнорируется
- Filled FVG — `filled=true`

**detectStructureBreaks:**
- Последовательность HH + пробой swing high → Bullish BOS
- Bullish тренд + пробой swing low → Bearish CHoCH
- Подтверждение закрытием свечи (не вик)

**detectLiquiditySweeps:**
- Свеча пробила высокий swing но закрылась ниже → HIGH_SWEEP, `recovered=true`
- Микровыброс < 0.1% → не считается sweep

**analyzeSMC:**
- nearestBullishOB — ближайший снизу
- nearestBearishOB — ближайший сверху
- trend detection правильный

**scoreSmcModule (через calculateConfluenceScore):**
- Цена у Bullish OB + long direction → smc score > 0
- Bullish CHoCH + long → smc score >= 3
- Антагонистический OB → entry gate блокирует

### Этап 5: Проверка качества (tester)
1. `npm run lint` — ESLint без ошибок
2. `npm run build` — tsc компиляция без ошибок
3. `npm run test:run` — все существующие тесты зелёные + новые тесты

---

## Структура нового файла `smart-money.ts`

```typescript
// src/trading/shared/smart-money.ts
import type { OHLC, OrderBlock, FairValueGap, StructureBreak, LiquiditySweep, SmcAnalysis } from './types.js';
import { calculateAtr } from './indicators.js';

const DEFAULT_OB_LOOKBACK = 50;
const DEFAULT_FVG_LOOKBACK = 30;
const DEFAULT_STRUCTURE_LOOKBACK = 50;
const DEFAULT_SWEEP_LOOKBACK = 20;
const MIN_FVG_SIZE_PCT = 0.05;
const MIN_SWEEP_PCT = 0.001; // 0.1%

export function detectOrderBlocks(candles: OHLC[], lookback: number = DEFAULT_OB_LOOKBACK): OrderBlock[]
export function detectFairValueGaps(candles: OHLC[], lookback: number = DEFAULT_FVG_LOOKBACK): FairValueGap[]
export function detectStructureBreaks(candles: OHLC[], lookback: number = DEFAULT_STRUCTURE_LOOKBACK): StructureBreak[]
export function detectLiquiditySweeps(candles: OHLC[], lookback: number = DEFAULT_SWEEP_LOOKBACK): LiquiditySweep[]
export function analyzeSMC(candles: OHLC[], currentPrice: number): SmcAnalysis
```

---

## Риски и митигация

| Риск | Вероятность | Митигация |
|------|-------------|-----------|
| Ложные OB в боковике | Medium | Проверять strength > 0.8 (объём выше среднего) |
| Переусложнение → замедление цикла | Low | Все вычисления O(n), n ≤ 200 свечей; замер в тесте |
| Новые типы ломают existing tests | Medium | Поля `smc?` и `smcAnalysis?` — опциональные |
| Entry Gate слишком агрессивный | Medium | Только если цена ВНУТРИ OB (не рядом); мониторить статистику пропуска |
| FVG в crypto — постоянно закрываются | Low | Фильтр filled=true + минимальный size 0.05% |
| Pересчёт весов снижает силу тренда | Low | Снижение минимальное (22% → 20%); backtest после внедрения |

---

## Definition of Done

- [ ] `smart-money.ts` реализован с 5 экспортированными функциями
- [ ] `types.ts` содержит все 5 новых интерфейсов
- [ ] `ConfluenceScore.smc` добавлен как optional поле
- [ ] `confluence.ts` Модуль 8 с весом 10% работает
- [ ] Веса пересчитаны: сумма = 100% (20+12+12+12+12+12+10+10=100%)
- [ ] Entry Gate в `market-analyzer.ts` блокирует входы внутри antagonist OB
- [ ] SMC данные добавлены в `marketData` для Claude (OB уровни)
- [ ] `smart-money.test.ts` содержит минимум 20 тест-кейсов
- [ ] `npm run lint && npm run build` — успешно
- [ ] `npm run test:run` — все тесты зелёные

---

## Порядок коммитов

```
feat(shared): Smart Money Concepts типы и детекция (smart-money.ts)
feat(shared): SMC Модуль 8 в confluence scoring (вес 10%, пересчёт весов)
feat(crypto): SMC интеграция в market-analyzer (Entry Gate + marketData)
test(shared): тесты для SMC детекции (smart-money.test.ts)
```
