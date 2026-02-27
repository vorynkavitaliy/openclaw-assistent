---
name: forex-trading
description: 'Forex market analysis and trading tools. Fetch quotes, analyze charts, manage positions via broker APIs.'
metadata: { 'openclaw': { 'emoji': '📈', 'requires': { 'bins': ['curl', 'jq'] } } }
user-invocable: true
---

# Forex Trading Skill

Инструменты для анализа и торговли на рынке Forex.

## Получение котировок

### Текущий курс валютной пары

```bash
# Через ExchangeRate API (бесплатно)
curl -s "https://api.exchangerate-api.com/v4/latest/USD" | jq '.rates.EUR, .rates.GBP, .rates.JPY'

# Через Open Exchange Rates (бесплатно с лимитом)
curl -s "https://open.er-api.com/v6/latest/USD" | jq '.rates'
```

### Исторические данные

```bash
# Yahoo Finance unofficial (через browser)
# Открой TradingView для графического анализа
```

## Анализ рынка

### Технический анализ

Используй `browser` для открытия TradingView:

- URL: `https://www.tradingview.com/chart/?symbol=FX:EURUSD`
- Анализируй графики, индикаторы, уровни

### Экономический календарь

```bash
# Проверь ближайшие события
# Через browser: https://www.forexfactory.com/calendar
# Через browser: https://www.investing.com/economic-calendar/
```

## Работа с брокером

### cTrader Open API (через TypeScript)

Основной метод торговли — через cTrader Open API. Все ордера исполняются программно:

```bash
# Открытие позиции
npx tsx src/trading/forex/trade.ts --action open \
  --pair EURUSD --side BUY --lots 0.1 \
  --sl-pips 50 --tp-pips 100

# Закрытие позиции
npx tsx src/trading/forex/trade.ts --action close --position-id 12345678

# Статус аккаунта
npx tsx src/trading/forex/trade.ts --action status

# Мониторинг (heartbeat)
npx tsx src/trading/forex/monitor.ts --heartbeat

# Анализ + торговля (dry-run)
npx tsx src/trading/forex/monitor.ts --trade --dry-run
```

Подробнее: см. `skills/ctrader-typescript/SKILL.md`

## Риск-менеджмент

### Расчёт размера позиции

```
Лот = (Депозит × Риск%) / (SL в пунктах × Стоимость пункта)

Пример:
- Депозит: $10,000
- Риск: 2% = $200
- SL: 50 pips
- EURUSD: стоимость 1 pip = $10/lot
- Лот = 200 / (50 × 10) = 0.4 лота
```

## Журнал сделок

Каждую сделку фиксируй на Task Board:

```bash
bash {baseDir}/../taskboard/scripts/taskboard.sh create \
  --title "EURUSD BUY 0.1 @ 1.0850" \
  --description "SL: 1.0800, TP: 1.0950, R:R 1:2, MACD bullish divergence" \
  --type "task" \
  --assignee "forex-trader" \
  --priority "high" \
  --labels "forex,trade,eurusd"
```
