# Backend Developer — MEMORY.md

Долгосрочная память backend разработчика. Обновляется по мере накопления опыта.

## Стек и инструменты

- **Runtime**: Node.js ≥22, TypeScript 5.x, ES Modules (`.js` в импортах!)
- **Build**: `cd /root/Projects/openclaw-assistent && npm run build` → tsc компиляция
- **Lint**: ESLint strict mode
- **Formatters**: Prettier

## Конвенции кода

```typescript
// ✅ Правильно — импорт с .js
import { createLogger } from '../../utils/logger.js';
import type { TradingConfig } from '../shared/types.js';

// ❌ Неправильно
import { createLogger } from '../../utils/logger';
```

### Logger (обязательно)

```typescript
const log = createLogger('module-name');
log.info('Сообщение');
log.warn('Предупреждение');
log.error('Ошибка', error);
// console.log ЗАПРЕЩЁН
```

### Retry для API calls

```typescript
import { retryAsync } from '../../utils/retry.js';

const result = await retryAsync(() => apiCall(), { retries: 3, backoffMs: 1000 });
```

### Credentials (НИКОГДА не хардкодить)

```typescript
// ✅ Правильно
import { getBybitCredentials } from '../../utils/config.js';
const { apiKey, apiSecret } = getBybitCredentials();

// ❌ Никогда!
const apiKey = 'hardcoded_key';
```

## Ключевые типы (src/trading/shared/types.ts)

- `Position` — открытая позиция
- `OHLC` — свеча (time, open, high, low, close, volume)
- `OrderParams` — параметры ордера
- `MarketAnalysis` — результат анализа
- `TradingConfig` — конфиг торговли
- `TradeSignal` — торговый сигнал

## Архитектура crypto модуля

```
bybit-client.ts  — API calls (getPositions, placeOrder, etc.)
monitor.ts       — основной цикл (анализ → сигнал → исполнение)
state.ts         — управление состоянием (dailyPnl, stopsCount)
config.ts        — конфиг (пары, риски, параметры)
killswitch.ts    — аварийная остановка
```

## Часто используемые паттерны

### Async итерация по парам (батчами)

```typescript
const BATCH_SIZE = 3;
for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
  const batch = pairs.slice(i, i + BATCH_SIZE);
  const results = await Promise.all(batch.map(analyzePair));
}
```

### Проверка на null с noUncheckedIndexedAccess

```typescript
const firstItem = arr[0]; // тип: T | undefined
if (!firstItem) return null;
// теперь firstItem: T
```

## Pre-commit

```bash
cd /root/Projects/openclaw-assistent && npm run lint && npm run build
```

Формат: `feat(crypto):`, `fix(forex):`, `refactor(shared):`

## Уроки и инсайты

- Bybit API: использовать `retryAsync` для всех вызовов (rate limits!)
- cTrader FIX 4.4: сообщения через FIX протокол, строгий порядок тегов
- Не добавлять зависимости без необходимости — минимизм
- При изменении `TradingConfig` — обновить и `types.ts` и `config.ts`
- `noImplicitReturns` требует явного `return` во всех ветках функции
