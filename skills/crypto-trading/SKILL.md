---
name: crypto-trading
description: 'Cryptocurrency market analysis and trading tools. Fetch prices, on-chain data, manage positions via exchange APIs.'
metadata: { 'openclaw': { 'emoji': '🪙', 'requires': { 'bins': ['curl', 'jq'] } } }
user-invocable: true
---

# Crypto Trading Skill

Инструменты для анализа и торговли криптовалютами.

## Получение рыночных данных

### Текущие цены (CoinGecko, бесплатно)

```bash
# Основные монеты
curl -s "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true" | jq '.'

# Топ-10 по капитализации
curl -s "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=10&page=1" | jq '.[] | {symbol, current_price, price_change_percentage_24h, market_cap}'
```

### Bybit API v5

```bash
# Текущая цена
curl -s "https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT" | jq '.result.list[0] | {symbol, lastPrice, price24hPcnt, volume24h, turnover24h}'

# Книга ордеров
curl -s "https://api.bybit.com/v5/market/orderbook?category=linear&symbol=BTCUSDT&limit=5" | jq '.result'

# Klines (свечи) — 1h, последние 24
curl -s "https://api.bybit.com/v5/market/kline?category=linear&symbol=BTCUSDT&interval=60&limit=24" | jq '.result.list[] | {open: .[1], high: .[2], low: .[3], close: .[4], volume: .[5]}'
```

> Для торговых операций используй TypeScript модули (bybit-client.ts) — не curl.
> Docs: https://bybit-exchange.github.io/docs/v5/intro

### Fear & Greed Index

```bash
curl -s "https://api.alternative.me/fng/?limit=1" | jq '.data[0] | {value, value_classification}'
```

### Bitcoin Dominance

```bash
curl -s "https://api.coingecko.com/api/v3/global" | jq '.data.market_cap_percentage.btc'
```

## On-Chain анализ (через browser)

- **Glassnode**: https://studio.glassnode.com/
- **Dune Analytics**: https://dune.com/
- **DeFiLlama**: https://defillama.com/
- **Etherscan**: https://etherscan.io/
- **Whale Alert**: https://whale-alert.io/

## Торговля через TypeScript модули (Bybit)

Все торговые операции выполняются через TypeScript CLI:

```bash
# Мониторинг (анализ + торговля, dry-run)
npx tsx src/trading/crypto/monitor.ts --dry-run

# Боевой режим
npx tsx src/trading/crypto/monitor.ts

# Kill Switch (экстренная остановка)
npx tsx src/trading/crypto/killswitch.ts --close-all

# Отчёт
npx tsx src/trading/crypto/report.ts
```

### Credentials

- **Файл**: `~/.openclaw/openclaw.json` → секция `crypto`
- **SDK**: `bybit-api` (Node.js) с `demoTrading: true` для Demo Trading
- **Тип**: Unified Trading Account (UTA), USDT-M Linear Perpetual

> ⚠️ Demo Trading ключи работают ТОЛЬКО через Node SDK с `demoTrading: true`, не через REST API.

## Мониторинг портфеля

### Формат позиции

```
🪙 BTC/USDT
   Количество: 0.5 BTC
   Средняя цена: $95,000
   Текущая цена: $98,500
   P&L: +$1,750 (+3.7%)
   SL: $93,000 (-2.1%)
   TP: $105,000 (+10.5%)
```

## Алерты

Создавай алерты через cron:

```bash
# Проверять каждые 5 минут
# Если BTC > 100000, отправить алерт через sessions_send orchestrator
```

## Журнал сделок

```bash
bash {baseDir}/../taskboard/scripts/taskboard.sh create \
  --title "BTC LONG 0.1 @ $98,500" \
  --description "SL: $96,000, TP: $105,000. Breakout above $98K resistance. RSI: 65. F&G: 72 (Greed)" \
  --type "task" \
  --assignee "crypto-trader" \
  --priority "high" \
  --labels "crypto,trade,btc"
```
