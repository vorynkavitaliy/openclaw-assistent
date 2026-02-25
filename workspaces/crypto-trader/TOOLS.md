# TOOLS.md — Crypto Trader Environment

## Архитектура

```
Bybit REST API v5
    ↕
Python-скрипты (bybit_get_data.py, bybit_trade.py, bybit_monitor.py)
    ↕
OpenClaw Crypto Trader Agent
    ↕
Orchestrator → Telegram
```

## Bybit API v5

### Endpoints

- **Mainnet**: https://api.bybit.com
- **Testnet**: https://api-testnet.bybit.com
- **Docs**: https://bybit-exchange.github.io/docs/v5/intro

### Credentials

- **API Key**: `[настроить в ~/.openclaw/openclaw.json → bybit.api_key]`
- **API Secret**: `[настроить в ~/.openclaw/openclaw.json → bybit.api_secret]`
- **Тип аккаунта**: Unified Trading Account (UTA)
- **Тип торговли**: USDT-M Linear Perpetual

### Конфигурация в openclaw.json

```json5
{
  bybit: {
    api_key: 'YOUR_API_KEY',
    api_secret: 'YOUR_API_SECRET',
    testnet: false, // true для тестовой сети
    default_leverage: 3,
    max_leverage: 5,
  },
}
```

---

## Python скрипты

### Получение данных (OHLC + индикаторы)

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

### Торговля (открытие/закрытие/модификация)

```bash
# Открытие LONG
python3 scripts/bybit_trade.py --action open --pair BTCUSDT --direction Buy \
  --qty 0.01 --sl 95000 --tp 102000

# Открытие SHORT
python3 scripts/bybit_trade.py --action open --pair ETHUSDT --direction Sell \
  --qty 0.1 --sl 3800 --tp 3400

# Закрытие позиции
python3 scripts/bybit_trade.py --action close --pair BTCUSDT

# Модификация SL/TP
python3 scripts/bybit_trade.py --action modify --pair BTCUSDT --sl 96500 --tp 103000

# Частичное закрытие
python3 scripts/bybit_trade.py --action partial_close --pair BTCUSDT --qty 0.005

# Закрытие всех позиций (экстренно)
python3 scripts/bybit_trade.py --action close_all

# Режим симуляции (без Bybit)
python3 scripts/bybit_trade.py --action open --pair BTCUSDT --direction Buy \
  --qty 0.01 --sl 95000 --tp 102000 --simulate
```

### Мониторинг (позиции, счёт, риски)

```bash
# Открытые позиции
python3 scripts/bybit_monitor.py --positions

# Состояние счёта
python3 scripts/bybit_monitor.py --account

# Полный Heartbeat (всё + алерты + funding)
python3 scripts/bybit_monitor.py --heartbeat

# Только проверка рисков
python3 scripts/bybit_monitor.py --risk-check
```

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

- **TradingView**: https://www.tradingview.com/chart/ — графики, индикаторы
- **CoinMarketCap**: https://coinmarketcap.com/ — рыночная сводка
- **DeFi Llama**: https://defillama.com/ — TVL
- **Coinglass**: https://www.coinglass.com/ — funding, OI, liquidations

## Экономический календарь

- **Основной источник**: Market Analyst агент (`sessions_send`)
- CoinGlass: https://www.coinglass.com/FundingRate
- Investing.com: https://www.investing.com/economic-calendar/

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
