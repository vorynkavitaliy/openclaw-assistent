# TOOLS.md — Crypto Trader Environment

## Архитектура

```
Bybit REST API v5
    ↕
Node.js SDK (bybit-api) — с поддержкой Demo Trading
    ↕
bybit_trade.js — торговля, мониторинг, управление позициями
bybit_get_data.py — публичные данные (OHLC, индикаторы)
    ↕
OpenClaw Crypto Trader Agent
    ↕
Orchestrator → Telegram
```

## Bybit API v5

### Endpoints

- **Mainnet**: https://api.bybit.com
- **Testnet**: https://api-testnet.bybit.com
- **Demo Trading**: mainnet + флаг `demoTrading: true` в SDK
- **Docs**: https://bybit-exchange.github.io/docs/v5/intro

### Credentials

- **Файл**: `~/.openclaw/credentials.json` → секция `bybit`
- **Тип аккаунта**: Unified Trading Account (UTA)
- **Тип торговли**: USDT-M Linear Perpetual
- **Demo Trading**: ключи от демо-аккаунта Bybit (работают только через Node SDK с `demoTrading: true`)

### Конфигурация credentials.json

```json
{
  "bybit": {
    "api_key": "YOUR_API_KEY",
    "api_secret": "YOUR_API_SECRET",
    "testnet": false,
    "demoTrading": true,
    "default_leverage": 3,
    "max_leverage": 5
  }
}
```

> ⚠️ Demo Trading ключи НЕ работают с обычным REST API (Python urllib). Только через Node SDK `bybit-api` с параметром `demoTrading: true`.

---

## Node.js — Торговля и мониторинг (bybit_trade.js)

### Открытие позиции (Market)

```bash
node scripts/bybit_trade.js --action=order --symbol=BTCUSDT --side=Buy \
  --qty=0.01 --sl=95000 --tp=102000

node scripts/bybit_trade.js --action=order --symbol=ETHUSDT --side=Sell \
  --qty=0.1 --sl=3800 --tp=3400
```

### Открытие позиции (Limit)

```bash
node scripts/bybit_trade.js --action=order --symbol=SOLUSDT --side=Buy \
  --type=Limit --qty=1 --price=140 --sl=130 --tp=170
```

### Закрытие позиции

```bash
node scripts/bybit_trade.js --action=close --symbol=BTCUSDT
```

### Частичное закрытие (50% при +1R)

```bash
node scripts/bybit_trade.js --action=partial_close --symbol=BTCUSDT --qty=0.005
```

### Модификация SL/TP

```bash
node scripts/bybit_trade.js --action=modify --symbol=BTCUSDT --sl=96500 --tp=103000
```

### Закрытие всех позиций (экстренно)

```bash
node scripts/bybit_trade.js --action=close_all
```

### Установка плеча

```bash
node scripts/bybit_trade.js --action=leverage --symbol=BTCUSDT --leverage=5
```

### Открытые позиции

```bash
node scripts/bybit_trade.js --action=positions
node scripts/bybit_trade.js --action=positions --symbol=BTCUSDT
```

### Баланс аккаунта

```bash
node scripts/bybit_trade.js --action=balance
node scripts/bybit_trade.js --action=balance --coin=BTC
```

### Флаг --demo

Для явного включения Demo Trading режима (вместо credentials.json):

```bash
node scripts/bybit_trade.js --action=balance --demo
```

---

## Python — Рыночные данные (bybit_get_data.py)

Публичный API, не требует авторизации.

### Получение OHLC + индикаторы

```bash
# Определение тренда (4h/1h)
python3 scripts/bybit_get_data.py --pair BTCUSDT --tf 240 --bars 100
python3 scripts/bybit_get_data.py --pair BTCUSDT --tf 60 --bars 50

# Поиск точки входа (15m/5m — ОБЯЗАТЕЛЬНО!)
python3 scripts/bybit_get_data.py --pair BTCUSDT --tf 15 --bars 100
python3 scripts/bybit_get_data.py --pair BTCUSDT --tf 5 --bars 100

# Рыночные метрики (funding, OI, volume)
python3 scripts/bybit_get_data.py --pair BTCUSDT --market-info
```

Возвращает JSON: `current_price`, `indicators` (EMA200, EMA50, RSI14, ATR14), `levels` (support/resistance), `bias`, `funding_rate`, `open_interest`.

---

## Дополнительные API

### CoinGecko (бесплатный)

```bash
# Цены
curl -s "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true"

# Bitcoin Dominance
curl -s "https://api.coingecko.com/api/v3/global" | jq '.data.market_cap_percentage.btc'
```

### Fear & Greed Index

```bash
curl -s "https://api.alternative.me/fng/?limit=1" | jq '.data[0]'
```

---

## Визуальные инструменты (Browser)

- **TradingView**: https://www.tradingview.com/chart/
- **CoinMarketCap**: https://coinmarketcap.com/
- **DeFi Llama**: https://defillama.com/
- **Coinglass**: https://www.coinglass.com/ — funding, OI, liquidations

## Таймфреймы (ОБЯЗАТЕЛЬНОЕ ПРАВИЛО)

```
4h  → Определи направление (тренд, зоны поддержки/сопротивления)
1h  → Определи ключевые уровни и зоны спроса/предложения
15m → НАЙДИ ТОЧКУ ВХОДА (BOS, CHoCH, Order Block, FVG)
5m  → УТОЧНИ ВХОД (подтверждение паттерном, минимальный SL)
```

## Плечо

- Дефолт: 3x
- Максимум: 5x
- **НИКОГДА** больше 5x — ликвидация = потеря всего
