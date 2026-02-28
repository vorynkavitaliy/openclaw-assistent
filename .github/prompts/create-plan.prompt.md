---
name: "Создать план"
description: "Создаёт структурированный план задачи в .github/docs/plans/. Анализирует затронутые модули src/, декомпозирует на этапы для developer и qa-tester."
agent: "agent"
tools: ["read", "search"]
argument-hint: "Цель задачи (например: 'добавить trailing stop для Bybit крипто-позиций')"
---

Создай план реализации: ${input:task:например 'добавить trailing stop для Bybit позиций'}

## Шаги

1. Прочитай существующие планы в `.github/docs/plans/` — посмотри формат
2. Изучи структуру кода: прочитай релевантные файлы из `src/`
3. Создай `.github/docs/plans/${input:date:YYYY-MM-DD}-<slug>.md`

## Структура плана

```yaml
---
id: PLAN-<номер>
title: <название>
status: draft
created: <дата>
priority: high | medium | low
---
```

- **Цель** — что и зачем
- **Затронутые модули** — конкретные файлы из `src/` с пояснением что изменится
- **Этапы** — кто делает (developer / qa-tester), что конкретно
- **Риски** — что может сломаться, как митигировать
- **DoD** — чек-лист: lint ✓, build ✓, tests ✓
- **Оценка**: S / M / L / XL

## Модули проекта для справки

```
src/trading/crypto/bybit-client.ts  — Bybit API: klines, positions, orders
src/trading/crypto/monitor.ts       — цикл мониторинга крипто
src/trading/crypto/state.ts         — TradingState: P&L, daily limits
src/trading/shared/indicators.ts    — EMA, RSI, ATR, S/R
src/trading/shared/risk.ts          — расчёт лотажа, risk management
src/trading/forex/client.ts         — cTrader API клиент
src/trading/forex/monitor.ts        — цикл мониторинга Forex
src/market/digest.ts                — market digest через RSS
src/utils/telegram.ts               — Telegram уведомления
```
