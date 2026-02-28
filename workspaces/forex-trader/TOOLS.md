# TOOLS.md — Forex Trader Environment

## Архитектура (cTrader Open API)

```
cTrader Open API (Spotware)
    ↕
ctrader-ts SDK (TypeScript)
    ↕
TypeScript модули (src/trading/forex/)
├── client.ts    — cTrader API клиент: подключение, данные, торговля
├── monitor.ts   — мониторинг: heartbeat, позиции, risk-check, trade
├── trade.ts     — CLI для ордеров: open, close, modify, status
└── config.ts    — конфигурация из ~/.openclaw/openclaw.json
    ↕
OpenClaw Forex Trader Agent
    ↕
Orchestrator → Telegram
```

### cTrader Credentials

- **Файл**: `~/.openclaw/openclaw.json` → секция `forex`
- **Аутентификация**: `npx ctrader-ts auth` (один раз, OAuth2)
- **Брокер**: FTMO (проп-трейдинг фирма)

---

## TypeScript CLI — Мониторинг

### Heartbeat (основной)

```bash
# Полный heartbeat — аккаунт, позиции, дродаун, FTMO-алерты
npx tsx src/trading/forex/monitor.ts --heartbeat

# Только позиции
npx tsx src/trading/forex/monitor.ts --positions

# Только аккаунт
npx tsx src/trading/forex/monitor.ts --account

# Проверка рисков (FTMO max daily/total drawdown)
npx tsx src/trading/forex/monitor.ts --risk-check
```

### Торговля (анализ + исполнение)

```bash
# Анализ + торговля по всем парам (dry-run — без исполнения)
npx tsx src/trading/forex/monitor.ts --trade --dry-run

# Анализ + торговля по одной паре (dry-run)
npx tsx src/trading/forex/monitor.ts --trade --pair=EURUSD --dry-run

# Боевой режим — анализ + автоматическое исполнение
npx tsx src/trading/forex/monitor.ts --trade

# Боевой режим — одна пара
npx tsx src/trading/forex/monitor.ts --trade --pair=EURUSD
```

Monitor в режиме `--trade` автоматически:

1. Управляет открытыми позициями (частичное закрытие +1R, trailing SL +1.5R, BE)
2. Сканирует все пары на входные сигналы (4h тренд + M15 RSI)
3. Исполняет сигналы (если не dry-run)

---

## TypeScript CLI — Ордера (trade.ts)

### Открытие позиции

```bash
npx tsx src/trading/forex/trade.ts --action open \
  --pair EURUSD --side BUY --lots 0.1 \
  --sl-pips 50 --tp-pips 100
```

Обязательные параметры: `--pair`, `--side` (BUY/SELL), `--sl-pips` (риск-менеджмент).
Опциональные: `--lots` (по умолчанию 0.01), `--tp-pips`.

### Закрытие позиции

```bash
# Полное закрытие
npx tsx src/trading/forex/trade.ts --action close --position-id 12345678

# Частичное закрытие (50% при +1R)
npx tsx src/trading/forex/trade.ts --action close --position-id 12345678 --lots 0.05
```

### Модификация SL/TP

```bash
npx tsx src/trading/forex/trade.ts --action modify --position-id 12345678 \
  --sl-pips 30 --tp-pips 100
```

### Закрытие всех позиций (экстренно)

```bash
npx tsx src/trading/forex/trade.ts --action close-all
```

### Статус аккаунта

```bash
npx tsx src/trading/forex/trade.ts --action status
```

Все команды возвращают JSON.

---

## Market Digest (макро + новости)

```bash
# Полный дайджест (48 часов)
npx tsx src/market/digest.ts

# Дайджест за 24 часа
npx tsx src/market/digest.ts --hours=24 --max-news=10
```

Парсит: ForexFactory Calendar XML + CoinDesk/Cointelegraph RSS.

---

## Экономический календарь

- **Основной источник**: Market Analyst агент (через sessions_send + Task Board)
- ForexFactory: https://www.forexfactory.com/calendar
- Investing.com: https://www.investing.com/economic-calendar/

## Визуальные инструменты (Browser)

- **TradingView**: https://www.tradingview.com/chart/
- **MT5 WebTerminal**: https://mt5-3.ftmo.com/ (только для визуального анализа)

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
