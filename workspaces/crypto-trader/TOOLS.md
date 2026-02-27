# TOOLS.md — Crypto Trader Environment

## Архитектура

```
Bybit REST API v5
    ↕
Node.js SDK (bybit-api) — с поддержкой Demo Trading
    ↕
TypeScript модули (src/trading/crypto/)
├── bybit-client.ts — API обёртка: торговля, данные, мониторинг
├── monitor.ts      — автономный мониторинг + анализ + исполнение
├── killswitch.ts   — экстренная остановка + закрытие всех позиций
├── report.ts       — часовые отчёты Telegram + JSON
├── state.ts        — персистентное состояние: баланс, лимиты, события
└── config.ts       — конфигурация из ~/.openclaw/openclaw.json
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

- **Файл**: `~/.openclaw/openclaw.json` → секция `crypto`
- **Тип аккаунта**: Unified Trading Account (UTA)
- **Тип торговли**: USDT-M Linear Perpetual
- **Demo Trading**: ключи от демо-аккаунта Bybit (работают только через Node SDK с `demoTrading: true`)

> ⚠️ Demo Trading ключи НЕ работают с обычным REST API. Только через Node SDK `bybit-api` с параметром `demoTrading: true`.

---

## TypeScript CLI — Мониторинг и торговля

### Мониторинг (основной инструмент)

```bash
# Полный мониторинг всех пар (dry-run — без исполнения)
npx tsx src/trading/crypto/monitor.ts --dry-run

# Мониторинг одной пары (dry-run)
npx tsx src/trading/crypto/monitor.ts --pair=BTCUSDT --dry-run

# Боевой режим — анализ + автоматическое исполнение
npx tsx src/trading/crypto/monitor.ts

# Боевой режим — одна пара
npx tsx src/trading/crypto/monitor.ts --pair=BTCUSDT
```

Monitor автоматически:

1. Проверяет kill-switch и стоп-день
2. Обновляет баланс и позиции
3. Управляет открытыми позициями (частичное закрытие +1R, trailing SL +1.5R, BE)
4. Делает мультитаймфреймный анализ (4h + 15m)
5. Исполняет сигналы (если не dry-run)

### Kill Switch (экстренная остановка)

```bash
# Статус (kill-switch, stop-day, mode, balance, positions)
npx tsx src/trading/crypto/killswitch.ts

# Включить kill-switch (остановить торговлю)
npx tsx src/trading/crypto/killswitch.ts --on --reason="ручная остановка"

# Закрыть ВСЕ позиции + включить kill-switch
npx tsx src/trading/crypto/killswitch.ts --close-all

# Выключить kill-switch (возобновить торговлю)
npx tsx src/trading/crypto/killswitch.ts --off
```

### Отчёт (Telegram + JSON)

```bash
# Часовой отчёт (отправляется в Telegram через Gateway)
npx tsx src/trading/crypto/report.ts

# Отчёт в JSON формате (stdout)
npx tsx src/trading/crypto/report.ts --format=json
```

Содержит: баланс, позиции, дневная статистика, рыночные данные BTC/ETH/SOL.

---

## API функции (bybit-client.ts)

Доступны как библиотека для других модулей:

| Функция                                       | Описание                                |
| --------------------------------------------- | --------------------------------------- |
| `getKlines(symbol, interval, limit)`          | OHLC свечи                              |
| `getMarketInfo(symbol)`                       | Тикер, funding rate, OI, funding сигнал |
| `getMarketAnalysis(symbol, tf, bars)`         | OHLC + EMA/RSI/ATR + trend bias         |
| `getBalance(coin?)`                           | Баланс (UNIFIED account)                |
| `getPositions(symbol?)`                       | Открытые позиции                        |
| `submitOrder({symbol, side, type, qty, ...})` | Создать ордер с SL/TP                   |
| `closePosition(symbol)`                       | Закрыть позицию                         |
| `partialClosePosition(symbol, qty)`           | Частичное закрытие                      |
| `modifyPosition(symbol, sl?, tp?)`            | Изменить SL/TP                          |
| `closeAllPositions()`                         | Закрыть все USDT позиции                |
| `setLeverage(symbol, leverage)`               | Установить плечо (макс 5x)              |

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

### Market Digest (макро + новости)

```bash
npx tsx src/market/digest.ts --hours=24 --max-news=10
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
