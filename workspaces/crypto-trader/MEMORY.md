# Crypto Trader — MEMORY.md

Долгосрочная память крипто-трейдера. Обновляется по мере накопления опыта.

## Стратегия (текущая)

- **Таймфреймы**: 4h тренд → 1h зоны → 15m вход → 5m точность
- **Тренд**: EMA200/50/20 на 4h, bias BULLISH если price > EMA50 > EMA200
- **Вход**: пробой/отскок от уровня поддержки/сопротивления + confluence ≥ 60
- **RR**: минимум 2:1, после частичного закрытия TP расширяется до 3R

## Параметры риска

- riskPerTrade: 2% баланса
- maxRiskPerTrade: $250
- maxDailyLoss: $500
- maxStopsPerDay: 2 (после 2-го стопа — стоп дня)
- maxOpenPositions: 3
- defaultLeverage: 3x (max 5x)

## Торгуемые пары и спецификации Bybit

| Пара      | qtyDec | priceDec |
| --------- | ------ | -------- |
| BTCUSDT   | 3      | 1        |
| ETHUSDT   | 2      | 2        |
| SOLUSDT   | 1      | 2        |
| XRPUSDT   | 0      | 4        |
| DOGEUSDT  | 0      | 5        |
| AVAXUSDT  | 1      | 2        |
| LINKUSDT  | 1      | 3        |
| ADAUSDT   | 0      | 4        |
| DOTUSDT   | 1      | 3        |
| MATICUSDT | 0      | 4        |
| ARBUSDT   | 0      | 4        |
| OPUSDT    | 0      | 4        |

## Фильтры входа (что блокирует сигнал)

1. **Spread** > 0.1% — пропустить пару
2. **Funding rate** > +0.05% (лонги перегреты) или < -0.05% (шорты перегреты)
3. **Confidence** < 60 — слабый сигнал
4. **maxOpenPositions** (3) достигнуто
5. **Ecosystem group** занята (ETH/ARB/OP, MATIC/ADA/DOT, AVAX/SOL/LINK)
6. **Margin** недостаточно для позиции
7. **demoTrading=false** — проверь перед включением реальной торговли!

## Управление позицией

- **Trailing SL**: активируется при 1.5R, дистанция 0.5R
- **Частичное закрытие**: при 1R прибыли закрыть 50%, SL → breakeven, TP → entry + 3R×slDist
- **Стейл ордера**: лимитные ордера > 30 мин отменяются автоматически
- **SL-Guard**: каждый цикл проверяет что SL выставлен, если нет — восстанавливает

## ATR SL

- SL = entry ± ATR(14) × 1.5 (atrSlMultiplier из конфига)
- Рассчитывается на 15m таймфрейме (entryTF)
- Минимальный SL = 0.3%, максимальный = 5% от цены

## Confluence система (score -100..+100)

| Компонент | Вес                                 | Что даёт |
| --------- | ----------------------------------- | -------- |
| Trend     | EMA alignment на 4h, 1h, 15m        |
| Momentum  | RSI, MACD, StochRSI                 |
| Volume    | Relative volume, VWAP, volume delta |
| Structure | Pivot levels, S/R clusters          |
| Orderflow | Orderbook imbalance, bid/ask walls  |
| Regime    | STRONG_TREND/WEAK_TREND/RANGING     |

Порог входа: score ≥ 60 (execute mode). STRONG сигнал: ≥ 75.

## Режимы работы

- `mode: 'execute'` — полный автоматический трейдинг
- `mode: 'dry-run'` — анализ без исполнения
- `demoTrading: true` — демо аккаунт (текущий режим)

## Kill Switch

```bash
# Включить стоп (создаёт файл)
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/killswitch.ts --on --reason="manual stop"

# Закрыть все позиции
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/killswitch.ts --close-all

# Выключить стоп (удаляет файл)
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/killswitch.ts --off
```

## Уроки и инсайты

- BTC часто ведёт рынок — если BTC в сильном тренде, альты следуют с задержкой
- DOGE/XRP — высокая волатильность, меньший размер позиции оправдан
- В ночные часы (00:00–07:00 Kyiv) объёмы ниже — spread-фильтр работает активнее
- Funding rate > 0.03% (LONGS_OVERHEATED) = хороший сигнал для шорта (против толпы)
- После major новостей (CPI, FOMC) — выждать 30 мин перед входом
