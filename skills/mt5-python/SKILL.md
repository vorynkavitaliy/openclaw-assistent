---
name: mt5-python
description: Python MetaTrader5 integration for forex trading
user-invocable: false
requires:
  bins: [python3]
---

# Skill: Python MetaTrader5 Integration

## Описание

Интеграция с MetaTrader 5 через Python library для программного управления торговлей. Используется агентом forex-trader как основной метод исполнения ордеров.

## Зависимости

- Python 3.10+
- `pip install MetaTrader5` (Windows/Linux)
- Desktop MT5 Terminal (запущен)
- На macOS: Wine или VM с Windows

## API Reference

### Подключение

```python
import MetaTrader5 as mt5
import os

# Инициализация
if not mt5.initialize():
    print(f"MT5 init failed: {mt5.last_error()}")
    quit()

# Авторизация
login = 531182488
password = os.getenv("FTMO_PASSWORD")
server = "FTMO-MT5-3"

if not mt5.login(login, password=password, server=server):
    print(f"Login failed: {mt5.last_error()}")
    mt5.shutdown()
    quit()
```

### Получение данных

```python
# OHLC данные (бары)
rates = mt5.copy_rates_from_pos("EURUSD", mt5.TIMEFRAME_H1, 0, 100)
# rates — numpy array: time, open, high, low, close, tick_volume, spread, real_volume

# Текущий тик
tick = mt5.symbol_info_tick("EURUSD")
# tick.bid, tick.ask, tick.last, tick.time

# Информация о символе
info = mt5.symbol_info("EURUSD")
# info.point, info.digits, info.spread, info.trade_tick_size
```

### Торговые операции

```python
# Открытие BUY
request = {
    "action": mt5.TRADE_ACTION_DEAL,
    "symbol": "EURUSD",
    "volume": 0.1,
    "type": mt5.ORDER_TYPE_BUY,
    "price": mt5.symbol_info_tick("EURUSD").ask,
    "sl": 1.0800,
    "tp": 1.0950,
    "deviation": 20,
    "magic": 234000,
    "comment": "openclaw forex-trader",
    "type_time": mt5.ORDER_TIME_GTC,
    "type_filling": mt5.ORDER_FILLING_IOC,
}
result = mt5.order_send(request)

# Проверка результата
if result.retcode != mt5.TRADE_RETCODE_DONE:
    print(f"Order failed: {result.comment}")
else:
    print(f"Order placed: ticket={result.order}, price={result.price}")
```

### Модификация позиции

```python
# Изменить SL/TP
request = {
    "action": mt5.TRADE_ACTION_SLTP,
    "symbol": "EURUSD",
    "position": ticket_number,
    "sl": 1.0850,
    "tp": 1.0950,
}
result = mt5.order_send(request)
```

### Закрытие позиции

```python
# Закрыть конкретную позицию
position = mt5.positions_get(ticket=ticket_number)[0]
close_request = {
    "action": mt5.TRADE_ACTION_DEAL,
    "symbol": position.symbol,
    "volume": position.volume,
    "type": mt5.ORDER_TYPE_SELL if position.type == 0 else mt5.ORDER_TYPE_BUY,
    "position": position.ticket,
    "price": mt5.symbol_info_tick(position.symbol).bid if position.type == 0 else mt5.symbol_info_tick(position.symbol).ask,
    "deviation": 20,
    "magic": 234000,
    "comment": "openclaw close",
}
result = mt5.order_send(close_request)
```

### Мониторинг

```python
# Все открытые позиции
positions = mt5.positions_get()
for pos in positions:
    print(f"{pos.symbol}: {pos.type} vol={pos.volume} profit={pos.profit}")

# Информация о счёте
account = mt5.account_info()
print(f"Balance: {account.balance}, Equity: {account.equity}, Margin: {account.margin}")

# Завершение
mt5.shutdown()
```

## Таймфреймы

| Константа | Описание |
|-----------|----------|
| mt5.TIMEFRAME_M1 | 1 минута |
| mt5.TIMEFRAME_M5 | 5 минут |
| mt5.TIMEFRAME_M15 | 15 минут |
| mt5.TIMEFRAME_H1 | 1 час |
| mt5.TIMEFRAME_H4 | 4 часа |
| mt5.TIMEFRAME_D1 | 1 день |
| mt5.TIMEFRAME_W1 | 1 неделя |

## Безопасность

- Credentials через env vars: `FTMO_PASSWORD`, `MT5_LOGIN`
- Никогда не хардкодить пароли в скриптах
- Логировать только safe-format: `531…488`, `!ea2…Quq`
