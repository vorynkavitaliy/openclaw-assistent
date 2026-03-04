# Orchestrator — MEMORY.md

Долгосрочная память оркестратора. Обновляется по мере накопления опыта.

## Агенты: паттерны поведения

### Что работает хорошо
- Crypto-trader: полностью автономен, не нужен апрув. Запускай через `sessions_send` с конкретным заданием.
- Market-analyst: отвечает быстро, но нужен чёткий запрос (пара + контекст + что нужно).
- QA-tester: лучше давать конкретный файл или модуль для проверки, а не "проверь всё".

### Типовые ошибки
- Если агент не отвечает — проверь статус heartbeat, не нужен ли restart.
- Не создавай задачи без немедленного `sessions_send` — агент не узнает о задаче.

## Торговые параметры (текущие)

- **Crypto**: Bybit USDT-M, demoTrading=true, maxLeverage=5x, defaultLeverage=3x
- **Forex**: cTrader / FTMO demo, пары EUR/USD GBP/USD USD/JPY AUD/USD USD/CHF
- **Риск**: maxDailyLoss=$500, maxStopsPerDay=2, riskPerTrade=2%

## Криптопары (12 пар)

BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT, DOGEUSDT, AVAXUSDT, LINKUSDT, ADAUSDT, DOTUSDT, MATICUSDT, ARBUSDT, OPUSDT

Экосистемные группы (не более 1 позиции на группу):
- ETH ecosystem: ETHUSDT, ARBUSDT, OPUSDT
- L1 altcoins: MATICUSDT, ADAUSDT, DOTUSDT
- Alt L1/DeFi: AVAXUSDT, SOLUSDT, LINKUSDT

## Форекс сессии

- London: 09:00–17:00 Kyiv
- New York: 16:00–00:00 Kyiv
- Пятница: закрыть все до 19:00 Kyiv
- Выходные (Сб-Вс): форекс не торгуем

## Важные события (красные на календаре)

Не торговать 30 мин до/после: NFP, CPI, FOMC, ECB rate decision, BoE, BoJ

## Статус системы

- demoTrading: **true** (обе платформы работают в демо-режиме)
- Kill switch: `data/KILL_SWITCH` файл (создать = остановить crypto-trader)
- Торговля запущена/остановлена через: `scripts/trading_control.sh`

## Уроки и инсайты

- SL-Guard (мониторинг стоп-лоссов) реализован в crypto-trader — проверяет каждые 10 мин
- Trailing stop активируется при 1.5R прибыли, дистанция 0.5R
- Частичное закрытие при 1R: 50% позиции, затем TP расширяется до 3R
- Spread и funding rate фильтры активны — пропускают плохие условия входа
