---
name: ctrader-typescript
description: cTrader Open API integration for forex trading via TypeScript
user-invocable: false
requires:
  bins: [npx]
---

# Skill: cTrader Open API Integration (TypeScript)

## Описание

Интеграция с cTrader через Open API (Spotware) для программного управления торговлей на Forex. Используется агентом forex-trader как основной метод исполнения ордеров. Полностью на TypeScript через SDK `ctrader-ts`.

## Зависимости

- Node.js 20+
- `ctrader-ts` SDK (установлен в package.json)
- Аутентификация: `npx ctrader-ts auth` (один раз, OAuth2)

## Модули

```
src/trading/forex/
├── client.ts   — cTrader API клиент: подключение, данные, торговля
├── monitor.ts  — мониторинг: heartbeat, позиции, risk-check, trade
├── trade.ts    — CLI для ордеров: open, close, modify, status
└── config.ts   — конфигурация из ~/.openclaw/openclaw.json
```

## CLI Reference

### Мониторинг (monitor.ts)

```bash
# Heartbeat — аккаунт, позиции, дродаун, FTMO-алерты
npx tsx src/trading/forex/monitor.ts --heartbeat

# Только позиции
npx tsx src/trading/forex/monitor.ts --positions

# Только аккаунт
npx tsx src/trading/forex/monitor.ts --account

# Проверка рисков (FTMO drawdown)
npx tsx src/trading/forex/monitor.ts --risk-check

# Анализ + торговля (dry-run)
npx tsx src/trading/forex/monitor.ts --trade --dry-run

# Анализ + торговля (боевой режим)
npx tsx src/trading/forex/monitor.ts --trade

# Одна пара
npx tsx src/trading/forex/monitor.ts --trade --pair=EURUSD --dry-run
```

### Торговля (trade.ts)

```bash
# Открыть позицию
npx tsx src/trading/forex/trade.ts --action open \
  --pair EURUSD --side BUY --lots 0.1 \
  --sl-pips 50 --tp-pips 100

# Закрыть позицию
npx tsx src/trading/forex/trade.ts --action close --position-id 12345678

# Частичное закрытие
npx tsx src/trading/forex/trade.ts --action close --position-id 12345678 --lots 0.05

# Модификация SL/TP
npx tsx src/trading/forex/trade.ts --action modify --position-id 12345678 \
  --sl-pips 30 --tp-pips 100

# Закрыть всё
npx tsx src/trading/forex/trade.ts --action close-all

# Статус аккаунта
npx tsx src/trading/forex/trade.ts --action status
```

Все команды возвращают JSON.

## API клиент (client.ts)

Библиотека для использования другими модулями:

| Функция                                | Описание                         |
| -------------------------------------- | -------------------------------- |
| `connect()`                            | Подключение к cTrader API        |
| `disconnect()`                         | Отключение                       |
| `getAccountInfo()`                     | Баланс, equity, маржа            |
| `getPositions()`                       | Открытые позиции                 |
| `openPosition(params)`                 | Открыть ордер (Market/Limit)     |
| `closePosition(positionId, volume?)`   | Закрыть (полностью или частично) |
| `modifyPosition(positionId, sl?, tp?)` | Изменить SL/TP                   |
| `closeAllPositions()`                  | Закрыть все позиции              |
| `getTrendbars(symbol, period, count)`  | OHLC данные                      |

## Конфигурация

Credentials в `~/.openclaw/openclaw.json`:

```json5
{
  forex: {
    mode: 'simulate', // "simulate" | "execute"
    pairs: ['EURUSD', 'GBPUSD', 'USDJPY'],
    riskPerTrade: 0.02,
    maxDailyDrawdown: 0.05,
    maxTotalDrawdown: 0.1,
  },
}
```

## Безопасность

- OAuth2 токены через `npx ctrader-ts auth`
- Credentials в `~/.openclaw/openclaw.json` — НЕ коммитить
- Логировать только safe-format: `531…488`
