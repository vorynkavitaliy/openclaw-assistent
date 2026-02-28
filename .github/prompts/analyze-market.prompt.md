---
name: "Анализ рынка"
description: "Технический и фундаментальный анализ торгового инструмента. Запускает мониторинг из src/, интерпретирует EMA/RSI/ATR/funding rate, собирает новостной контекст."
agent: "agent"
tools: ["execute", "web", "search"]
argument-hint: "Инструмент для анализа (например: BTCUSDT или EURUSD)"
---

Проведи анализ рынка для: ${input:instrument:например BTCUSDT или EURUSD}

## Технический анализ через код проекта

### Для крипто (Bybit)

```bash
npm run trade:crypto:monitor
npm run trade:crypto:report
```

Интерпретация `MarketAnalysis` (`src/trading/shared/types.ts`):
- `bias.emaTrend: BULLISH` — цена выше EMA50 > EMA200, восходящий тренд
- `bias.rsiZone: OVERBOUGHT` — RSI > 70, осторожно с покупками
- `marketInfo.fundingSignal: LONGS_OVERHEATED` — funding > 0.03%, риск коррекции

### Для Forex (cTrader)

```bash
npx tsx src/trading/forex/monitor.ts --heartbeat
npx tsx src/trading/forex/monitor.ts --trade --dry-run
```

### Дайджест новостей

```bash
npm run market:digest
```

## Фундаментальный контекст (web search)

Найди для ${input:instrument:инструмент}:
1. Экономический календарь на ближайшие 48 часов (ForexFactory / Investing.com)
2. Ключевые новости за последние 24 часа
3. Рыночный сентимент (risk-on/off, DXY для Forex; Fear & Greed для крипто)

## Формат итогового отчёта

```
Анализ: <инструмент>

Технический:
- Тренд: BULLISH/BEARISH (EMA: ...)
- RSI: XX (NEUTRAL/OVERBOUGHT/OVERSOLD)
- ATR: XX (волатильность)
- Уровни: Resistance XX / Support XX

Фундаментальный:
- Ближайшие события: ...
- Новости: ...
- Сентимент: Risk-On/Off

Вывод: <факты, без прямых рекомендаций>
```
