---
type: analysis
topic: full-project-analysis
date: 2026-03-04
status: completed
tags: [architecture, code-review, trading, crypto, forex, agents]
---

# Полный анализ проекта OpenClaw AI Assistant

> Дата: 2026-03-04 | Статус QA: Build OK, ESLint 3 errors, Tests 112/112 passed

---

## 1. Обзор проекта

**OpenClaw AI Assistant** — мультиагентная система автоматизации торговли на платформе OpenClaw.

| Параметр | Значение |
|----------|----------|
| Стек | TypeScript 5.9, Node.js ≥20, ES Modules |
| Биржи | Bybit (крипто USDT-M futures) + cTrader FIX 4.4 (Forex) |
| Платформа | OpenClaw 2026.2.22-2 (ws://127.0.0.1:18789) |
| Telegram | @hyrotraders_bot (ID: 5929886678) |
| Режим | Demo Trading (Bybit), Live Forex (cTrader) |
| Prop Challenge | HyroTrade: 8% target, 5% daily DD, 10% max loss |

---

## 2. Структура кодовой базы

### 2.1 src/ — исходники (7441 строк всего)

```
src/
├── index.ts                              (точка входа)
├── market/
│   └── digest.ts                         (RSS дайджест рынка)
├── trading/
│   ├── crypto/                           (Bybit)
│   │   ├── bybit-client.ts      633 стр  (REST API v5 клиент)
│   │   ├── monitor.ts           474 стр  (автономный монитор)
│   │   ├── state.ts             370 стр  (состояние, P&L, лимиты)
│   │   ├── snapshot.ts          112 стр  (базовый снапшот)
│   │   ├── snapshot-v2.ts               (расширенный снапшот v2)
│   │   ├── report.ts            222 стр  (hourly Telegram отчёт)
│   │   ├── config.ts                    (конфигурация торговли)
│   │   ├── trade.ts                     (ручные операции CLI)
│   │   └── killswitch.ts               (экстренная остановка)
│   ├── forex/                           (cTrader FIX 4.4)
│   │   ├── fix-connection.ts    724 стр  (FIX протокол)
│   │   ├── client.ts            610 стр  (торговый клиент)
│   │   ├── monitor.ts           324 стр  (heartbeat, риски)
│   │   ├── snapshot.ts                  (снапшот позиций)
│   │   ├── trade.ts                     (ручные операции)
│   │   └── config.ts                    (конфигурация)
│   └── shared/                          (общие компоненты)
│       ├── types.ts                     (все типы проекта)
│       ├── indicators.ts        379 стр  (EMA/RSI/MACD/ATR/ADX/BB)
│       ├── confluence.ts        351 стр  (scoring engine)
│       ├── risk.ts                      (расчёт позиций)
│       ├── regime.ts                    (детекция режима рынка)
│       ├── orderflow.ts                 (OB/OI/funding анализ)
│       ├── volume-analysis.ts          (VWAP/delta/relative vol)
│       ├── levels.ts                    (pivot points, volume clusters)
│       ├── index.ts                     (re-exports)
│       └── __tests__/                   (56+56 тестов = 112 total)
└── utils/
    ├── config.ts                         (credentials: ~/.openclaw/)
    ├── logger.ts                         (цветной structured logger)
    ├── retry.ts                          (exponential backoff)
    ├── telegram.ts                       (отправка сообщений)
    ├── args.ts                           (CLI args parser)
    ├── process.ts                        (runMain wrapper)
    └── index.ts
```

### 2.2 .claude/ — Claude Code агенты и конфигурация

```
.claude/
├── agents/                    (6 суб-агентов)
│   ├── orchestrator.md        (координатор: sonnet, maxTurns 30)
│   ├── developer.md           (TypeScript разработчик: sonnet, maxTurns 50)
│   ├── tester.md              (QA инженер: sonnet, maxTurns 40)
│   ├── planner.md             (архитектор: sonnet, maxTurns 30, plan mode)
│   ├── analyst.md             (рыночный аналитик: sonnet, maxTurns 25)
│   └── trading-advisor.md    (торговый советник: sonnet, maxTurns 30)
├── rules/                     (path-scoped правила)
│   ├── typescript.md          (ES modules, strict TS, логгер)
│   ├── trading.md             (правила торговли, риски)
│   ├── security.md            (credentials, безопасность)
│   ├── testing.md             (Vitest паттерны)
│   ├── analysis.md            (анализ рынка)
│   └── planning.md            (планирование фич)
├── skills/                    (кастомные /команды)
│   ├── crypto-monitor/        (npm run trade:crypto:monitor)
│   ├── forex-monitor/         (npm run trade:forex:monitor)
│   ├── market-digest/         (npm run market:digest)
│   ├── run-qa/                (build + lint + test)
│   └── security-audit/        (grep credentials)
├── planning/                  (планы реализации)
│   └── 2026-03-03-crypto-agent-upgrade.md
├── analysis/                  (аналитические документы)
├── settings.json              (permissions + hooks)
├── settings.local.json
└── hooks/
    └── protect-files.sh       (защита .env, credentials)
```

### 2.3 workspaces/ — OpenClaw агенты

8 агентов OpenClaw-платформы:
- **orchestrator** — главный координатор
- **crypto-trader** — autonomous Bybit трейдер
- **forex-trader** — cTrader FIX трейдер
- **market-analyst** — рыночный аналитик
- **tech-lead**, **backend-dev**, **frontend-dev**, **qa-tester** — dev команда

### 2.4 scripts/ — Bash автоматизация

| Скрипт | Функция |
|--------|---------|
| `crypto_check.sh` | Комплексный сбор данных (94 стр): kill-switch, balance, snapshot, F&G, BTC dominance, tasks |
| `trading_control.sh` | Start/stop trading via cron (376 стр) |
| `trading_log.sh` | Запись событий в events.jsonl |
| `trading_params.sh` | Динамические параметры торговли |
| `forex_check.sh` | Аналог для Forex |
| `crypto_cron.sh` | Cron wrapper для crypto-trader |

### 2.5 skills/ — OpenClaw skills

- `crypto-trading/HYROTRADE_RULES.md` — правила prop challenge
- `forex-trading/FTMO_RULES.md` — правила FTMO
- `taskboard/` — Task Board для координации агентов
- `dev-tools/`, `ctrader-typescript/` — инструменты разработки

---

## 3. Архитектура торговой системы

### 3.1 Crypto (Bybit) — полный флоу

```
Cron (2h) → OpenClaw → crypto-trader agent
                ↓
    crypto_check.sh (данные: balance/positions/indicators)
                ↓
    monitor.ts → analyzePairV2() → 12 API calls/pair (параллельно)
                ↓
    Confluence Scoring (-100..+100):
      25% Trend (EMA D1→H4→H1→M15)
      15% Momentum (RSI/MACD/StochRSI)
      15% Volume (VWAP/delta/relative)
      15% Structure (S/R levels, pivot points)
      15% Orderflow (orderbook/OI/funding)
      15% Regime (STRONG_TREND..CHOPPY)
                ↓
    Regime threshold check → filter weak signals
                ↓
    executeSignals() → Limit orders → Bybit API v5
                ↓
    state.ts → logEvent() → events.jsonl
```

### 3.2 Forex (cTrader) — флоу

```
FIX 4.4 TCP/TLS (порт 5211/5212) → fix-connection.ts
    → EventEmitter (message events)
    → client.ts (orders, positions, quotes)
    → monitor.ts (heartbeat, риск-проверки)
```

### 3.3 Confluence Scoring Engine (новый, v2)

| Модуль | Вес | Диапазон | Факторы |
|--------|-----|----------|---------|
| Trend | 25% | -10..+10 | EMA alignment D1/H1/M15 |
| Momentum | 15% | -10..+10 | RSI zone, MACD histogram, StochRSI K/D cross |
| Volume | 15% | -10..+10 | Relative volume, buy/sell delta, VWAP proximity |
| Structure | 15% | -10..+10 | Distance to S/R, pivot levels, high volume nodes |
| Orderflow | 15% | -10..+10 | OB imbalance, OI trend (12h avg vs prev 12h), funding |
| Regime | 15% | -10..+10 | ADX + BB width + ATR ratio + EMA fan |

**Total = raw_score × 10, clamped to -100..+100**

**Signal mapping:**

| Score | Signal |
|-------|--------|
| ≥ 70 | STRONG_LONG |
| ≥ 40 | LONG |
| ≤ -70 | STRONG_SHORT |
| ≤ -40 | SHORT |
| иначе | NEUTRAL |

**Динамические пороги входа по режиму:**

| Режим | Порог |
|-------|-------|
| STRONG_TREND | 50 |
| WEAK_TREND | 65 |
| RANGING | 70 |
| VOLATILE | 75 |
| CHOPPY | 85 |

---

## 4. Конфигурация торговли

### 4.1 config.ts (crypto)

```typescript
pairs: 12 пар (BTC, ETH, SOL, XRP, DOGE, AVAX, LINK, ADA, DOT, MATIC, ARB, OP)
riskPerTrade: 0.02        // 2% от баланса
maxDailyLoss: 500         // $500 дневной лимит
maxStopsPerDay: 2         // максимум 2 стопа в день
maxRiskPerTrade: 250      // $250 максимальный риск
maxOpenPositions: 3       // максимум 3 позиции
defaultLeverage: 3        // 3x по умолчанию
maxLeverage: 5            // 5x ограничение
minRR: 2                  // минимальный R:R
partialCloseAtR: 1.0      // частичное закрытие при 1R
partialClosePercent: 0.5  // закрыть 50%
trailingStartR: 1.5       // трейлинг с 1.5R
trailingDistanceR: 0.5    // дистанция трейлинга
mode: 'execute'           // реальная торговля
demoTrading: true         // но на demo-счёте
```

### 4.2 state.ts — управление состоянием

- **Файлы**: `data/state.json`, `data/events.jsonl`, `data/KILL_SWITCH`
- **DailyStats**: trades, wins, losses, stops, totalPnl, realizedPnl, fees, maxDrawdown
- **Auto-reset**: при смене дня (00:00 UTC)
- **Events rotation**: 5MB лимит, сохраняет 50% при ротации
- **calcPositionSize**: `min(balance * riskPerTrade, maxRiskPerTrade) / slDistance`

---

## 5. Code Review

### 5.1 Качество кода — ХОРОШО ✓

- Strict TypeScript: `noUnusedLocals`, `noImplicitReturns`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
- Нет `any` типов (кроме обоснованных cast через `as`)
- ES Module импорты с `.js` — соблюдается
- `createLogger` вместо `console.log` — соблюдается в торговых модулях
- Retry с exponential backoff для API вызовов
- Все типы в `src/trading/shared/types.ts`
- 112 unit тестов, все проходят

### 5.2 QA статус

| Проверка | Результат |
|----------|-----------|
| `npm run build` | ✅ 0 ошибок |
| `npm run lint` | ⚠️ 3 ошибки (forex/trade.ts: `\|\|` вместо `??`), 30 warnings |
| `npm run test:run` | ✅ 112/112 (6 файлов x2 — src и dist) |

### 5.3 Найденные проблемы

#### КРИТИЧНО: Хардкоженный Telegram токен
```
ФАЙЛ: scripts/trading_control.sh:14
ПРОБЛЕМА: TELEGRAM_TOKEN="7786754527:AAGifHqv2s4VD8AYKg8LNJyAjMcoN_BT89E"
РИСК: Токен в открытом виде в git-репозитории
ИСПРАВЛЕНИЕ: Читать из ~/.openclaw/credentials.json или env var
```

#### ВЫСОКИЙ: ESLint 3 ошибки в forex/trade.ts
```
ФАЙЛ: src/trading/forex/trade.ts:38,39
ОШИБКА: Prefer nullish coalescing operator (`??`) over `||`
ПРИЧИНА: `||` не учитывает пустую строку '' как falsy правильно
ИСПРАВЛЕНИЕ: getArg('pair') ?? '' → уже используется везде кроме этих строк
```

#### СРЕДНИЙ: Двойные тесты (src + dist)
```
ПРОБЛЕМА: Vitest запускает тесты из src/ И dist/ одновременно = 56×2 = 112
          Это нормально если dist/ не в gitignore/vitest exclude
РИСК: Может маскировать разницу между TS и compiled JS поведением
РЕКОМЕНДАЦИЯ: Добавить exclude: ['dist/**'] в vitest.config или проверить что это намеренно
```

#### СРЕДНИЙ: race condition в state.ts
```
ФАЙЛ: src/trading/crypto/state.ts
ПРОБЛЕМА: Синхронные fs.writeFileSync + appendFileSync при параллельном
          выполнении нескольких пар могут создать race conditions
КОНТЕКСТ: analyzeMarket() параллелизирует пары, но executeSignals() последовательный
РИСК: Низкий (executeSignals последовательный), но logEvent внутри try/catch параллелен
```

#### НИЗКИЙ: Неиспользуемый `getArgOrDefault` в utils/args.ts
```
ФАЙЛ: src/utils/args.ts — функция getArgOrDefault
      Используется только в report.ts
СТАТУС: OK, не критично
```

#### НИЗКИЙ: position.entryPrice vs avgPrice дублирование
```
ФАЙЛ: src/trading/crypto/state.ts:updatePositions()
ПРОБЛЕМА: `entryPrice: p.entryPrice ?? p.avgPrice ?? '0'`
          Bybit возвращает avgPrice для открытых позиций, entryPrice для историй
СТАТУС: Правильно обработано, не баг
```

#### ИНФОРМАЦИОННО: console.log в CLI-скриптах
```
ФАЙЛЫ: trade.ts, killswitch.ts, report.ts, monitor.ts
СТАТУС: Намеренно — это CLI инструменты, console.log выводит JSON в stdout
        ESLint дает warning, но это правильное поведение для CLI
```

### 5.4 Архитектурные наблюдения

#### Хорошее
- **Dual API strategy**: bybit-api SDK для аутентифицированных запросов + прямой fetch для публичного API (правильно — экономит overhead)
- **Parallel data collection**: 12 API calls per pair в Promise.all — оптимально
- **Regime-dependent thresholds**: умное решение для адаптации к рыночным условиям
- **Confluence engine**: хорошо структурированный scoring с чёткой разбивкой по модулям
- **State persistence**: JSON файл с auto-reset по дням, ротация events файла
- **Kill switch**: файловый флаг (data/KILL_SWITCH) — простой и надёжный

#### К улучшению
- **Нет feedback loop**: открытые позиции не обновляют daily stats автоматически. `recordTrade()` вызывается вручную из внешних источников, но monitor.ts не вызывает его при закрытии позиций (нет механизма отслеживания закрытий)
- **Нет Telegram уведомлений в monitor.ts**: report.ts есть, но monitor.ts только пишет в JSON + logEvent. При реальной торговле хотелось бы уведомления при открытии ордера
- **Snapshot v1 vs v2 дублирование**: snapshot.ts (старый, для OpenClaw агента) и snapshot-v2.ts (новый, не используется?) — потенциальная путаница
- **forex/trade.ts использует console.log но нет createLogger**: в отличие от других модулей

---

## 6. Безопасность

### 6.1 Проблемы

| Уровень | Файл | Описание |
|---------|------|----------|
| 🔴 КРИТИЧНО | `scripts/trading_control.sh:14` | Реальный Telegram токен хардкоженн в git |
| 🟡 СРЕДНИЙ | `workspaces/crypto-trader/` | Пути к проекту хардкоженны как `/root/Projects/` — не портабельно |
| 🟢 OK | `src/utils/config.ts` | Credentials только из `~/.openclaw/credentials.json` или env |
| 🟢 OK | `.gitignore` | `.env`, `keys.md`, `credentials.json` исключены |
| 🟢 OK | `.claude/hooks/protect-files.sh` | Блокирует редактирование `.env`, `credentials`, `keys.md` |

### 6.2 Что хорошо реализовано

- `getBybitCredentials()` поддерживает как файл, так и env vars
- Credentials кешируются в памяти (только одно чтение файла)
- `resetCredentialsCache()` для тестов
- Нет credentials в TypeScript коде

---

## 7. Тестирование

### 7.1 Покрытие тестами

| Модуль | Тесты | Покрытие |
|--------|-------|----------|
| indicators.ts | 22 | EMA, RSI (Wilder), MACD, StochRSI, VWAP, ADX, BBWidth, ATR |
| confluence.ts | 11 | Score range, alignment, regime penalty, weights |
| regime.ts | 6 | Classification, thresholds |
| orderflow.ts | 6 | OB imbalance, OI trend, funding |
| volume-analysis.ts | 6 | VWAP, volume delta, relative volume |
| levels.ts | 5 | Pivot points, POC, Value Area |
| **Итого** | **56** | (x2 = 112 с dist/) |

### 7.2 Что НЕ покрыто тестами

- `bybit-client.ts` — API клиент (требует моки)
- `state.ts` — управление состоянием (fs зависимости)
- `risk.ts` — расчёт позиций (простые формулы, легко добавить)
- `monitor.ts` — основная торговая логика (требует моки API)
- `config.ts` — конфигурация (I/O зависимость)

---

## 8. OpenClaw Platform интеграция

### 8.1 Claude Code агенты (.claude/agents/)

6 агентов для разработки:
- **orchestrator**: координация задач через TodoWrite + Agent tool
- **developer**: код TypeScript, maxTurns 50 (самый высокий)
- **tester**: QA, ESLint, Vitest
- **planner**: архитектура, plan permissionMode
- **analyst**: анализ рынка
- **trading-advisor**: настройка стратегий

### 8.2 OpenClaw агенты (workspaces/)

Crypto-trader workspace — детально проработан:
- **SOUL.md**: личность, Token Economy (max 5 tool calls/heartbeat), Smart Money strategy
- **HEARTBEAT.md**: алгоритм на каждый цикл (5 шагов)
- **AGENTS.md**: task board интеграция, discipline rules, interrupt protocol
- **Cron**: `trading_control.sh start` → heartbeat каждые 2h
- **Активация**: задача от оркестратора → crypto-trader берёт в работу

### 8.3 Конфликт между двумя системами

**ВАЖНО**: Есть два параллельных механизма торговли:

1. **Путь 1 (Claude Code)**: `monitor.ts --dry-run/execute` с Confluence scoring
2. **Путь 2 (OpenClaw)**: crypto_check.sh → AI анализ → trade.ts (manual SmartMoney)

Оба используют один `bybit-client.ts`, но разную логику анализа. Это может создавать путаницу.

---

## 9. Зависимости

### 9.1 Production

| Пакет | Версия | Назначение |
|-------|--------|------------|
| `bybit-api` | ^4.6.0 | Bybit REST/WS SDK |
| `rss-parser` | ^3.13.0 | RSS дайджест рынка |

### 9.2 Dev

| Пакет | Версия | Назначение |
|-------|--------|------------|
| `typescript` | ^5.9.3 | Компилятор |
| `tsx` | ^4.21.0 | Прямой запуск TS |
| `vitest` | ^4.0.18 | Unit тесты |
| `eslint` | ^10.0.2 | Линтер |
| `prettier` | ^3.8.1 | Форматирование |
| `@types/node` | ^25.3.2 | Node.js типы |

### 9.3 Отсутствуют но могут понадобиться

- `dotenv` — не нужен, используется кастомный config.ts
- Нет rate limiting для API (только retry backoff) — Bybit имеет rate limits
- Нет circuit breaker для API (если N ошибок подряд → пауза)

---

## 10. Выводы и рекомендации

### 10.1 Сильные стороны

1. **Confluence Scoring** — хорошо продуманная multi-factor система анализа
2. **Строгая типизация** — полный strict TypeScript без `any`
3. **Риск-менеджмент** — daily loss limit, kill switch, maxStopsPerDay, position sizing
4. **Тесты** — 56 unit тестов для критической торговой логики
5. **Параллельный сбор данных** — Promise.all для 12 API вызовов/пару
6. **Документация агентов** — подробные SOUL.md, HEARTBEAT.md, AGENTS.md

### 10.2 Приоритетные задачи

| Приоритет | Задача |
|-----------|--------|
| 🔴 P0 | Убрать Telegram токен из `scripts/trading_control.sh` → читать из env/credentials |
| 🔴 P0 | Исправить 3 ESLint ошибки в `forex/trade.ts` (`\|\|` → `??`) |
| 🟡 P1 | Добавить Telegram уведомления в `monitor.ts` при открытии ордеров |
| 🟡 P1 | Добавить feedback loop: отслеживание закрытия позиций → `recordTrade()` |
| 🟡 P1 | Удалить агентов Claude Code: developer, tester, planner, analyst, trading-advisor (оставить orchestrator + crypto-trader) |
| 🟡 P1 | Создать `crypto-trader` Claude Code агент вместо 5 отдельных |
| 🟢 P2 | Тесты для `risk.ts`, `state.ts` |
| 🟢 P2 | Убрать хардкоженные пути `/root/Projects/` в workspaces |
| 🟢 P2 | Исключить `dist/**` из vitest (или подтвердить намеренность) |
| 🟢 P2 | Унифицировать snapshot.ts / snapshot-v2.ts (нужны оба?) |

### 10.3 Нереализованные части плана (crypto upgrade)

Из плана `2026-03-03-crypto-agent-upgrade.md` остались нереализованными:
- **Этап 0**: Auto-trade engine (auto-trade.ts) — автоматический запуск по расписанию
- **Этап 7**: Обновление скриптов (crypto_check.sh v2, workspace файлы для OpenClaw)
- **Этап 9**: Feedback loop (feedback.ts) — отслеживание результатов сделок

---

*Анализ выполнен: 2026-03-04 | Файлов: 39 | Строк кода: 7441 | Тестов: 112*
