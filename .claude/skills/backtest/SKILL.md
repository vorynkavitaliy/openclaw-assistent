---
name: backtest
description: "Запускает бэктест торговой стратегии на исторических данных Bybit. Поддерживает одну пару, все пары, equity curve, Claude LLM оценку. Запуск: /backtest"
user-invocable: true
allowed-tools: Bash(npx tsx src/trading/crypto/backtester.ts *) Read
---

# Бэктест торговой стратегии

Запусти бэктест и покажи результаты в удобном виде.

## Параметры

Спроси пользователя что нужно, или используй разумные значения по умолчанию.

### Примеры запуска

**Одна пара, 500 баров (~5 дней):**
```bash
npx tsx src/trading/crypto/backtester.ts --pair BTCUSDT --bars 500
```

**Все 45 пар, 6 месяцев, equity curve $10k:**
```bash
npx tsx src/trading/crypto/backtester.ts --all --bars 26000 --balance 10000
```

**С Claude LLM оценкой (топ-15 сигналов):**
```bash
npx tsx src/trading/crypto/backtester.ts --all --bars 26000 --balance 10000 --with-llm --llm-top 15
```

**Подробный вывод:**
```bash
npx tsx src/trading/crypto/backtester.ts --pair ETHUSDT --bars 5000 --verbose
```

## Справка по баров → период

| Баров (M15) | Период |
|-------------|--------|
| 500 | ~5 дней |
| 2700 | ~1 месяц |
| 8000 | ~3 месяца |
| 17000 | ~6 месяцев (пол года) |
| 26000 | ~9 месяцев |

## Формат результата

После завершения покажи:
1. Таблицу топ-5 прибыльных и топ-5 убыточных пар
2. Общий итог: сделки, win rate, P&L, max drawdown
3. Equity curve по месяцам (если --balance)
4. Рекомендации по парам (убрать убыточные, усилить прибыльные)
