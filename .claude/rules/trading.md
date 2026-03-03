---
paths:
  - "src/trading/**/*.ts"
---

# Правила торговых модулей

## Безопасность торговли
- НИКОГДА не хардкодить суммы ордеров — всегда расчёт через risk.ts
- Все торговые операции — через LIMIT ордера (не Market, кроме killswitch)
- Stop-Loss обязателен для каждой позиции
- Максимальный риск на сделку: 1-2% от депозита

## Типы данных
- Все из `src/trading/shared/types.ts`:
  - `OHLC` — свечные данные
  - `Position` — открытая позиция
  - `OrderParams` — параметры ордера
  - `MarketAnalysis` — полный анализ рынка
  - `TradingConfig` — конфигурация торговли
  - `Bias` — направление рынка (EmaTrend, RsiZone)

## Bybit (crypto/)
- API клиент: `bybit-client.ts` — обёртка над `bybit-api`
- Мониторинг: `monitor.ts` — реалтайм данные через REST polling
- Конфиг: `config.ts` — из `~/.openclaw/openclaw.json`
- State: `state.ts` — дневной P&L, лимиты, количество стопов

## cTrader (forex/)
- Протокол: FIX 4.4 через `fix-connection.ts`
- Клиент: `client.ts` — обёртка для ордеров и позиций
- Мониторинг: `monitor.ts` — heartbeat + статус

## Индикаторы (shared/)
- `calculateEma(prices, period)` — Exponential Moving Average
- `calculateRsi(prices, period)` — Relative Strength Index
- `calculateAtr(ohlc, period)` — Average True Range
- `buildMarketAnalysis(ohlc, meta)` — полный анализ

## Конвенции
- Все суммы и цены — `number` (не строки)
- Символы — строка: `'BTCUSDT'`, `'EURUSD'`
- Таймфреймы — строка: `'1m'`, `'5m'`, `'1h'`, `'4h'`, `'1d'`
