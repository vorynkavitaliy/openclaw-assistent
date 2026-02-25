# TOOLS.md — Forex Trader Environment

## MetaTrader 5 Setup

### WebTerminal URL

- **FTMO**: https://mt5-3.ftmo.com/?_gl=1*1sag2od*_gcl_au*NDM1OTEzMjI4LjE3NzE4NzI5ODg.*_ga*NzU0MjE3NjM2LjE3NzE4NzI5ODg.*_ga_QNHG9RT9Q8*czE3NzE4NzI5ODgkbzEkZzEkdDE3NzE4NzMxODUkajkkbDAkaDA.*_fplc*JTJGN01ubE5laDBYZUszc3Jhc05rcFAlMkY3ZzVuJTJCVXZ3Zzc1SGlQMGx6c0RSSUJxNSUyQlR3dnpJQ1lyaGVRcElDbiUyQlhjYUxaSExsRXdxcVhhNGRPT3ZWelY5bExqNElZZUJocXZpc1g3S3VVZTVSR3F0WDJMdWg5OG5zWWY0ZVF4ZyUzRCUzRA..*trader_ga*NzU0MjE3NjM2LjE3NzE4NzI5ODg.*trader_ga_9MZ4CB7ZME*czE3NzE4NzI5ODgkbzEkZzEkdDE3NzE4NzMxODckajM3JGwwJGgw
- Резерв: https://trade.mql5.com/trade

### MT5 Credentials (FTMO)

- **Логин**: 531182488
- **Пароль**: `!ea2…Quq` _(реальный в ~/.openclaw/openclaw.json)_
- **Сервер**: FTMO MT5-3 (выбирается автоматически в WebTerminal)
- Брокер: FTMO (проп-трейдинг фирма)

### Desktop MT5 (macOS)

- Путь: /Applications/MetaTrader 5.app (если установлен)
- cliclick: brew install cliclick (для управления мышью)
- Скриншоты: /tmp/openclaw/mt5_screen.png

### Python MetaTrader5 (основной метод исполнения)

- **Library**: `pip install MetaTrader5`
- **Требования**: Desktop MT5 Terminal запущен, Python 3.10+
- **Платформа**: Windows/Linux (на macOS требуется Wine или VM)
- **Скрипты**: `scripts/mt5_get_data.py`, `scripts/mt5_trade.py`, `scripts/mt5_monitor.py`

### MQL5 индикатор (мониторинг)

- **Путь индикаторов**: `MT5_DATA/MQL5/Indicators/`
- **Файл экспорта данных**: `MT5_DATA/MQL5/Files/export_data.csv`
- **Файл экспорта позиций**: `MT5_DATA/MQL5/Files/export_positions.csv`
- **Формат CSV**: `timestamp,pair,bid,ask,rsi14,ema200,atr14`

## Экономический календарь

- Основной источник: **Market Analyst** агент (sessions_send)
- ForexFactory: https://www.forexfactory.com/calendar
- Investing.com: https://www.investing.com/economic-calendar/

## Торговые часы (UTC+3 Москва)

- Лондон: 10:00-18:00
- Нью-Йорк: 15:00-23:00
- Перекрытие: 15:00-18:00 (лучшее время для торговли)
- НЕ торговать: 00:00-07:00 (Азия, кроме JPY пар)
