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

### Binance API

```bash
# Текущая цена
curl -s "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT" | jq '.'

# 24h статистика
curl -s "https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT" | jq '{symbol, lastPrice, priceChangePercent, volume, quoteVolume}'

# Книга ордеров
curl -s "https://api.binance.com/api/v3/depth?symbol=BTCUSDT&limit=5" | jq '.'

# Klines (свечи) — 1h, последние 24
curl -s "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=24" | jq '.[] | {open: .[1], high: .[2], low: .[3], close: .[4], volume: .[5]}'
```

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

## Торговля через Binance API

### Подпись запросов

Env переменные:

- `BINANCE_API_KEY` — API ключ
- `BINANCE_API_SECRET` — секрет

### Баланс аккаунта

```bash
TIMESTAMP=$(date +%s000)
QUERY="timestamp=${TIMESTAMP}"
SIGNATURE=$(echo -n "$QUERY" | openssl dgst -sha256 -hmac "$BINANCE_API_SECRET" | awk '{print $2}')
curl -s -H "X-MBX-APIKEY: ${BINANCE_API_KEY}" \
  "https://api.binance.com/api/v3/account?${QUERY}&signature=${SIGNATURE}" | jq '.balances[] | select(.free != "0.00000000")'
```

### Создание ордера (шаблон)

```bash
TIMESTAMP=$(date +%s000)
QUERY="symbol=BTCUSDT&side=BUY&type=LIMIT&timeInForce=GTC&quantity=0.001&price=95000&timestamp=${TIMESTAMP}"
SIGNATURE=$(echo -n "$QUERY" | openssl dgst -sha256 -hmac "$BINANCE_API_SECRET" | awk '{print $2}')
curl -s -X POST -H "X-MBX-APIKEY: ${BINANCE_API_KEY}" \
  "https://api.binance.com/api/v3/order?${QUERY}&signature=${SIGNATURE}" | jq '.'
```

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
