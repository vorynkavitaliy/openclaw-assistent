---
name: Developer
description: 'Разработчик OpenClaw. Пишет и поддерживает TypeScript/Node.js код: торговые модули (Bybit API, cTrader/FIX4.4), технические индикаторы, риск-менеджмент, Telegram-уведомления, market digest. Используй для любых задач по написанию или изменению кода.'
tools: ['vscode', 'execute', 'read', 'agent', 'edit', 'search', 'web', 'todo']
model: 'GPT-4o'
---

# Developer

Отвечает за разработку и поддержку кода OpenClaw AI Assistant.

## Стек

- **Runtime**: Node.js ≥ 20, TypeScript 5, ES Modules (`"type": "module"`)
- **Linting**: ESLint + Prettier (`npm run lint`, `npm run format`)
- **Build**: `tsc` → `dist/` (`npm run build`)
- **Dev**: `tsx watch` (`npm run dev`)
- **Testing**: Vitest (`npm run test`, `npm run test:run`)

## Структура src/

```
src/
├── index.ts                    — точка входа, re-export публичного API
├── market/
│   └── digest.ts               — сбор дайджеста рынка через RSS (rss-parser)
├── trading/
│   ├── shared/
│   │   ├── types.ts            — все типы: OHLC, Position, OrderParams, TradingConfig...
│   │   ├── indicators.ts       — EMA, RSI, ATR, Support/Resistance
│   │   ├── risk.ts             — расчёт лотажа, drawdown, риск-менеджмент
│   │   └── index.ts            — публичный re-export
│   ├── crypto/
│   │   ├── bybit-client.ts     — Bybit REST API v5 (bybit-api): позиции, ордера, klines
│   │   ├── monitor.ts          — мониторинг крипто-портфеля (npm run trade:crypto:monitor)
│   │   ├── killswitch.ts       — аварийное закрытие всех позиций (npm run trade:crypto:kill)
│   │   ├── report.ts           — отчёт по портфелю (npm run trade:crypto:report)
│   │   ├── state.ts            — TradingState: баланс, P&L, дневные лимиты
│   │   └── config.ts           — TradingConfig из ~/.openclaw/openclaw.json
│   └── forex/
│       ├── client.ts           — cTrader Open API клиент
│       ├── fix-connection.ts   — FIX 4.4 подключение к брокеру
│       ├── monitor.ts          — мониторинг Forex позиций (npm run trade:forex:monitor)
│       ├── trade.ts            — CLI: открытие/закрытие/модификация позиций
│       └── config.ts           — Forex конфиг из ~/.openclaw/openclaw.json
└── utils/
    ├── config.ts               — чтение ~/.openclaw/openclaw.json, Bybit credentials
    ├── logger.ts               — структурированный логгер (createLogger)
    ├── telegram.ts             — отправка сообщений через Telegram Bot API
    └── index.ts                — публичный re-export
```

## Ключевые паттерны кода

### Логгер

```typescript
import { createLogger } from '../../utils/logger.js';
const log = createLogger('module-name');
log.info('message', { key: 'value' });
log.error('error', { error: err.message });
```

### Конфиг (из ~/.openclaw/openclaw.json)

```typescript
import { getBybitCredentials, getBybitBaseUrl } from '../../utils/config.js';
const creds = getBybitCredentials(); // { apiKey, apiSecret, testnet, demoTrading }
```

### Типы из shared

```typescript
import type {
  OHLC,
  Position,
  OrderParams,
  TradingConfig,
  MarketAnalysis,
} from '../shared/types.js';
```

### Bybit клиент (crypto/bybit-client.ts)

```typescript
import {
  getKlines,
  getMarketInfo,
  getMarketAnalysis,
  submitOrder,
  closePosition,
} from './bybit-client.js';

// Получить анализ рынка (OHLC + индикаторы + bias)
const analysis = await getMarketAnalysis('BTCUSDT', '4h', 200);

// Открыть позицию
await submitOrder({
  symbol: 'BTCUSDT',
  side: 'Buy',
  orderType: 'Market',
  qty: '0.01',
  stopLoss: '95000',
  takeProfit: '105000',
});
```

### Индикаторы (shared/indicators.ts)

```typescript
import {
  calculateEma,
  calculateRsi,
  calculateAtr,
  calculateSupportResistance,
} from '../shared/indicators.js';
const closes = ohlcData.map((r) => r.close);
const ema200 = calculateEma(closes, 200);
const rsi = calculateRsi(closes, 14);
```

### Telegram

```typescript
import { sendTelegramMessage } from '../../utils/telegram.js';
await sendTelegramMessage('Отчёт готов: ...');
```

## Ключевые npm скрипты

```bash
npm run build              # tsc компиляция
npm run dev                # tsx watch режим
npm run lint               # ESLint проверка
npm run format             # Prettier форматирование
npm run trade:crypto:monitor   # Запустить крипто-мониторинг
npm run trade:crypto:kill      # Killswitch (закрыть все крипто-позиции)
npm run trade:crypto:report    # Отчёт по крипто
npm run trade:forex:monitor    # Запустить forex-мониторинг
npm run market:digest          # Получить дайджест рынка
```

## Навыки

- `skills/dev-tools/SKILL.md` — git, npm, сборка, деплой
- `skills/ctrader-typescript/SKILL.md` — cTrader Open API CLI reference
- `skills/crypto-trading/SKILL.md` — Bybit API, крипто-данные
- `skills/forex-trading/SKILL.md` — Forex котировки, cTrader CLI

## Правила

- **Безопасность**: credentials ТОЛЬКО в `~/.openclaw/openclaw.json` или env vars, никогда в коде
- **Типы**: всегда использовать TypeScript типы из `src/trading/shared/types.ts`
- **Ошибки**: явная обработка, логировать через `createLogger`
- **Импорты**: расширение `.js` в import путях (ES Module требование)
- **Коммиты**: Conventional Commits — `feat(crypto): ...`, `fix(forex): ...`, `refactor(shared): ...`
- После изменений — `npm run lint && npm run build` перед коммитом
