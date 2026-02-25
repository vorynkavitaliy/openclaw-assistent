# TOOLS.md — Forex Trader Environment

## MetaTrader 5 Setup (VPS Ubuntu 24.04)

### Архитектура

```
MT5 (Wine + Xvfb :99)
    ↓
OpenClaw_Bridge.mq5 (Expert Advisor)
    ↓  экспорт каждые 5с
~/.openclaw/mt5_data/
├── export_positions.csv    ← открытые позиции
├── export_account.csv      ← баланс, equity, маржа
├── export_EURUSD_M15.csv   ← OHLC данные (если включено)
├── orders/                 ← входящие ордера от Python
│   └── {order_id}.json     ← команда: open/close/modify
└── results/                ← ответы от EA
    └── {order_id}.json     ← результат исполнения
```

### MT5 Desktop (Wine на VPS)

- **Wine prefix**: `~/.mt5`
- **Terminal**: `~/.mt5/drive_c/Program Files/MetaTrader 5/terminal64.exe`
- **Display**: `:99` (Xvfb headless, 1920x1080)
- **Systemd**: `xvfb.service` + `mt5.service`
- **Запуск**: `WINEPREFIX=~/.mt5 DISPLAY=:99 wine terminal64.exe /portable`

### WebTerminal URL (браузер, визуальный анализ)

- **FTMO**: https://mt5-3.ftmo.com/
- **Резерв**: https://trade.mql5.com/trade

### MT5 Credentials (FTMO)

- **Логин**: `531…488` _(реальный в ~/.openclaw/openclaw.json)_
- **Пароль**: `!ea2…Quq` _(реальный в ~/.openclaw/openclaw.json)_
- **Сервер**: FTMO MT5-3
- **Брокер**: FTMO (проп-трейдинг фирма)

---

## Python скрипты (файловый мост ↔ EA)

### Получение данных (OHLC + индикаторы)

```bash
# Определение тренда (H4/H1)
python3 scripts/mt5_get_data.py --pair EURUSD --tf H4 --bars 100
python3 scripts/mt5_get_data.py --pair EURUSD --tf H1 --bars 50

# Поиск точки входа (M15/M5 — ОБЯЗАТЕЛЬНО!)
python3 scripts/mt5_get_data.py --pair EURUSD --tf M15 --bars 100
python3 scripts/mt5_get_data.py --pair EURUSD --tf M5 --bars 100
```

Возвращает JSON: `current_price`, `indicators` (EMA200, EMA50, RSI14, ATR14), `levels` (support/resistance), `bias`.

### Торговля (открытие/закрытие/модификация)

```bash
# Открытие ордера
python3 scripts/mt5_trade.py --action open --pair EURUSD --direction BUY \
  --lot 0.1 --sl 1.0800 --tp 1.0950

# Закрытие по тикету
python3 scripts/mt5_trade.py --action close --ticket 123456789

# Модификация SL/TP
python3 scripts/mt5_trade.py --action modify --ticket 123456789 --sl 1.0820

# Закрытие всех позиций (экстренно)
python3 scripts/mt5_trade.py --action close_all

# Режим симуляции (без MT5)
python3 scripts/mt5_trade.py --action open --pair EURUSD --direction BUY \
  --lot 0.1 --sl 1.0800 --tp 1.0950 --simulate
```

### Мониторинг (позиции, счёт, риски)

```bash
# Открытые позиции
python3 scripts/mt5_monitor.py --positions

# Состояние счёта (баланс, equity, маржа)
python3 scripts/mt5_monitor.py --account

# Полный Heartbeat (всё + алерты + дродаун)
python3 scripts/mt5_monitor.py --heartbeat

# Только проверка рисков (позиции без SL, превышение %%)
python3 scripts/mt5_monitor.py --risk-check
```

---

## Expert Advisor — OpenClaw_Bridge.mq5

Исходник: `scripts/OpenClaw_Bridge.mq5`

**Установка:**

1. Скопировать в `MQL5/Experts/OpenClaw_Bridge.mq5`
2. Скомпилировать в MetaEditor (F7)
3. Прикрепить к графику (любая пара)
4. Включить автоторговлю

**Что делает:**

- Каждые 5с экспортирует позиции и счёт в CSV файлы
- Читает папку `orders/` — входящие ордера
- Исполняет торговые команды и пишет результат в `results/`

---

## Экономический календарь

- **Основной источник**: Market Analyst агент (`sessions_send`)
- ForexFactory: https://www.forexfactory.com/calendar
- Investing.com: https://www.investing.com/economic-calendar/

## Торговые часы (UTC+3 Москва)

- Лондон: 10:00-18:00
- Нью-Йорк: 15:00-23:00
- Перекрытие: 15:00-18:00 (лучшее время для торговли)
- НЕ торговать: 00:00-07:00 (Азия, кроме JPY пар)

## Таймфреймы (ОБЯЗАТЕЛЬНОЕ ПРАВИЛО)

```
H4  → Определи направление (тренд, зоны поддержки/сопротивления)
H1  → Определи ключевые уровни и зоны спроса/предложения
M15 → НАЙДИ ТОЧКУ ВХОДА (BOS, CHoCH, Order Block, FVG)
M5  → УТОЧНИ ВХОД (подтверждение паттерном, минимальный SL)
```
