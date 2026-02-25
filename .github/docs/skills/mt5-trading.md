# Skill: MT5 гибридная торговля

## Цель

Описать гибридный workflow управления MetaTrader 5 для агента Forex Trader:
Python MT5 API для исполнения, MQL5 индикатор для мониторинга, Browser Tool для визуального анализа.

## Когда использовать

- Открытие/закрытие позиций на MT5 (Python MetaTrader5 API)
- Получение рыночных данных (Python API или MQL5 экспорт)
- Визуальный анализ графиков (Browser Tool)
- Мониторинг позиций и P&L

## Когда НЕ использовать

- Крипто-торговля (другой агент, другие API)
- Фундаментальный анализ (делегировать market-analyst)

## Три метода работы с MT5

### Метод 1: Python MetaTrader5 — ИСПОЛНЕНИЕ (основной)

Прямой API доступ к Desktop MT5 Terminal через Python library.

```python
import MetaTrader5 as mt5

# Подключение
mt5.initialize()
mt5.login(login=531182488, password=os.getenv("FTMO_PASSWORD"), server="FTMO-MT5-3")

# Получение данных
rates = mt5.copy_rates_from_pos("EURUSD", mt5.TIMEFRAME_H1, 0, 100)
positions = mt5.positions_get()
account = mt5.account_info()

# Открытие ордера
request = {
    "action": mt5.TRADE_ACTION_DEAL,
    "symbol": "EURUSD",
    "volume": 0.1,
    "type": mt5.ORDER_TYPE_BUY,
    "price": mt5.symbol_info_tick("EURUSD").ask,
    "sl": 1.0800,
    "tp": 1.0950,
    "magic": 234000,
    "comment": "openclaw forex-trader",
}
result = mt5.order_send(request)

# Закрытие
mt5.Close("EURUSD", ticket=result.order)
mt5.shutdown()
```

**Требования**: Desktop MT5 Terminal запущен, Python 3.10+, Windows/Linux

### Метод 2: MQL5 индикатор — МОНИТОРИНГ

MQL5 скрипт работает внутри MT5, экспортирует данные в файл.

```
Файл: MT5_DATA/MQL5/Files/export_data.csv
Формат: timestamp,pair,bid,ask,rsi14,ema200,atr14
Обновление: каждые 5-10 секунд

Чтение агентом:
exec → cat ~/MT5_DATA/MQL5/Files/export_data.csv | tail -10
```

### Метод 3: Browser Tool — ВИЗУАЛЬНЫЙ АНАЛИЗ (вспомогательный)

```
browser → open URL (MT5 WebTerminal или TradingView)
browser → screenshot (скриншот графика)
image → analyze (паттерны, уровни, структура)
```

**Важно**: MT5 WebTerminal — canvas/WebGL приложение. Playwright НЕ может находить DOM-элементы. Используй Browser Tool ТОЛЬКО для скриншотов и визуального анализа, НЕ для торговых операций.

## Полный торговый цикл

```
1. sessions_send → market-analyst (фундаментальный анализ)
2. exec → python3 mt5_get_data.py (технические данные)
3. browser → screenshot (визуальный анализ)
4. Совместить фундаментал + техника + визуал → решение
5. exec → python3 mt5_trade.py (исполнение ордера)
6. exec → python3 mt5_monitor.py (мониторинг)
7. sessions_send → orchestrator (отчёт)
```

## Риск-менеджмент

### Обязательные правила

- **Максимальный риск на сделку**: 1-2% от депозита
- **Stop Loss**: ВСЕГДА устанавливать
- **R:R**: минимум 1:2
- **Не торговать на новостях** (30 мин до/после HIGH impact)
- **Максимум позиций**: не более 3 одновременно

### Расчёт лотажа

```
Лотаж = (Депозит * Риск%) / (SL в пунктах * Стоимость пункта)
```

## Безопасность

- **Креденшалы MT5** в `workspaces/forex-trader/TOOLS.md` — safe-формат
- Реальные логин/пароль в `~/.openclaw/openclaw.json` или env vars
- **Не коммитить** реальные пароли в git
- Python скрипты читают credentials из env vars

## Типовые проблемы

### Python MT5 не подключается
- Проверить что Desktop MT5 Terminal запущен
- Проверить credentials: `mt5.last_error()`
- На macOS: требуется Wine или VM (нативно не поддерживается)

### MQL5 файл не обновляется
- Проверить что индикатор добавлен на график в MT5
- Проверить путь: `MT5_DATA/MQL5/Files/`
- Проверить права на запись

### Browser Tool не видит элементы MT5
- Это нормально — MT5 WebTerminal это canvas
- Используй ТОЛЬКО для screenshot → image analysis
- Для торговых операций используй Python MT5 API
