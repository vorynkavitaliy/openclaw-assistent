```skill
---
name: forex-trading
description: 'Forex market analysis and trading tools. Fetch quotes, analyze charts, manage positions via broker APIs.'
metadata: { 'openclaw': { 'emoji': '📈', 'requires': { 'bins': ['curl', 'jq'] } } }
user-invocable: true
---

# Forex Trading Skill

Tools for forex market analysis and trading.

## Fetching Quotes

### Current Exchange Rate

```bash
# Via ExchangeRate API (free)
curl -s "https://api.exchangerate-api.com/v4/latest/USD" | jq '.rates.EUR, .rates.GBP, .rates.JPY'

# Via Open Exchange Rates (free with limit)
curl -s "https://open.er-api.com/v6/latest/USD" | jq '.rates'
```

### Historical Data

```bash
# Yahoo Finance unofficial (via browser)
# Open TradingView for chart analysis
```

## Market Analysis

### Technical Analysis

Use `browser` to open TradingView:

- URL: `https://www.tradingview.com/chart/?symbol=FX:EURUSD`
- Analyze charts, indicators, levels

### Economic Calendar

```bash
# Check upcoming events
# Via browser: https://www.forexfactory.com/calendar
# Via browser: https://www.investing.com/economic-calendar/
```

## Broker Integration

### cTrader Open API (via TypeScript)

Primary trading method — via cTrader Open API. All orders are executed programmatically:

```bash
# Open position
cd /root/Projects/openclaw-assistent && npx tsx src/trading/forex/trade.ts --action open \
  --pair EURUSD --side BUY --lots 0.1 \
  --sl-pips 50 --tp-pips 100

# Close position
cd /root/Projects/openclaw-assistent && npx tsx src/trading/forex/trade.ts --action close --position-id 12345678

# Account status
cd /root/Projects/openclaw-assistent && npx tsx src/trading/forex/trade.ts --action status

# Monitoring (heartbeat)
cd /root/Projects/openclaw-assistent && npx tsx src/trading/forex/monitor.ts --heartbeat

# Analysis + trading (dry-run)
cd /root/Projects/openclaw-assistent && npx tsx src/trading/forex/monitor.ts --trade --dry-run
```

See also: `skills/ctrader-typescript/SKILL.md`

## Risk Management

### Position Size Calculation

```
Lot = (Deposit × Risk%) / (SL in pips × Pip Value)

Example:
- Deposit: $10,000
- Risk: 2% = $200
- SL: 50 pips
- EURUSD: pip value = $10/lot
- Lot = 200 / (50 × 10) = 0.4 lots
```

## Trade Journal

Log every trade on the Task Board:

```bash
bash {baseDir}/../taskboard/scripts/taskboard.sh create \
  --title "EURUSD BUY 0.1 @ 1.0850" \
  --description "SL: 1.0800, TP: 1.0950, R:R 1:2, MACD bullish divergence" \
  --type "task" \
  --assignee "forex-trader" \
  --priority "high" \
  --labels "forex,trade,eurusd"
```
