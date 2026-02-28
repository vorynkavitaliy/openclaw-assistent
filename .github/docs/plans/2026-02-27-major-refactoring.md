---
id: PLAN-2026-02-27-001
title: 'Масштабный рефакторинг: мониторинг, TypeScript, Forex, без Python'
date: 2026-02-27
version: 1.0
status: draft
priority: critical
author: orchestrator
assignees:
  - orchestrator
  - tech-lead
  - backend-dev
  - forex-trader
---

# Масштабный рефакторинг OpenClaw Assistant

## Резюме

Четыре ключевых направления работ:

1. **Админка и мониторинг агентов** — настроить Gateway + Dashboard OpenClaw, чтобы видеть агентов, логи, статусы и задачи через `https://76.13.250.171:8080/proxy/18789/`
2. **Реструктуризация проекта** — перевести всё на TypeScript, навести порядок
3. **Замена MT5 для Forex** — перейти на REST API-брокеров (OANDA / cTrader). Тут надо обсудить что будет лучше и удобнее для работы через агентов.
4. **Удаление Python** — переписать все Python-скрипты на TypeScript

> **Claude для dev-агентов** вынесен в отдельный план: [2026-02-27-claude-models.md](2026-02-27-claude-models.md)

---

## Текущее состояние (аудит)

### Инфраструктура

| Параметр  | Значение                                                               |
| --------- | ---------------------------------------------------------------------- |
| OpenClaw  | 2026.2.24 (доступно обновление 2026.2.26)                              |
| Node.js   | 22.22.0                                                                |
| Модель    | openai/gpt-5.2 (391k ctx) для всех агентов                             |
| Gateway   | порт 18789, режим local, статус: **не запущен**                        |
| Dashboard | https://76.13.250.171:8080/proxy/18789/ (через reverse proxy)          |
| Агенты    | 8 штук (orchestrator + 7 специализированных)                           |
| Heartbeat | включён у orchestrator, crypto/forex-trader, tech-lead, market-analyst |
| Сессии    | 2 активных                                                             |
| Telegram  | подключён (@hyrotraders_bot)                                           |

### Код

| Метрика           | Значение                            |
| ----------------- | ----------------------------------- |
| TypeScript        | **отсутствует** (нет tsconfig.json) |
| Python скрипты    | 6 файлов (~950 строк)               |
| JavaScript        | 6 файлов (~1270 строк)              |
| package.json deps | только `bybit-api`                  |
| Тесты             | **отсутствуют**                     |
| Линтинг           | **не настроен**                     |

### Python-скрипты (кандидаты на удаление)

| Файл                | Строк | Назначение                                          |
| ------------------- | ----- | --------------------------------------------------- |
| `mt5_trade.py`      | 176   | File bridge: пишет JSON ордера для MQL5 EA          |
| `mt5_get_data.py`   | 168   | Читает OHLC из CSV экспортов EA, считает индикаторы |
| `mt5_monitor.py`    | 218   | Читает позиции/аккаунт из CSV, risk-check           |
| `market_digest.py`  | 130   | RSS парсинг ForexFactory / CoinDesk                 |
| `bybit_get_data.py` | 236   | Public Bybit API для OHLC + индикаторы              |
| `fix_config.py`     | ~50   | Утилита для починки openclaw.json                   |

### JavaScript-скрипты (кандидаты на TS-миграцию)

| Файл                   | Строк | Назначение                           |
| ---------------------- | ----- | ------------------------------------ |
| `bybit_trade.js`       | 291   | Полный Bybit v5 модуль торговли      |
| `crypto_config.js`     | 64    | Конфигурация крипто-трейдинга        |
| `crypto_monitor.js`    | 280   | Автономный loop мониторинга (10 мин) |
| `crypto_state.js`      | 347   | State manager + event log            |
| `crypto_killswitch.js` | 89    | Emergency stop (CLI)                 |
| `crypto_report.js`     | 190   | Hourly Telegram отчёт                |

---

## Задача 1: Админка и мониторинг агентов

### Проблема

Gateway не запущен → Dashboard недоступен → нет визуализации работы агентов, логов, задач.
Доступ к Dashboard будет через reverse proxy: `https://76.13.250.171:8080/proxy/18789/`.

### Решение

OpenClaw **уже имеет** встроенный Dashboard (Control UI). Локально он слушает на порту 18789, а пользователь обращается через reverse proxy `https://76.13.250.171:8080/proxy/18789/`. Нужно:

#### Этап 1.1: Запуск и стабилизация Gateway

```bash
# 1. Обновить OpenClaw до актуальной версии
npm update openclaw -g

# 2. Запустить Gateway
openclaw gateway start

# 3. Включить systemd service для автозапуска
openclaw gateway start  # создаст systemd unit
systemctl --user enable openclaw-gateway
```

**Результат**: Dashboard доступен на `https://76.13.250.171:8080/proxy/18789/`

#### Этап 1.2: Включить Heartbeat для всех агентов

В `~/.openclaw/openclaw.json` для каждого агента добавить heartbeat:

```json5
{
  id: 'forex-trader',
  heartbeat: {
    interval: '15m',
    prompt: 'Проверь текущие позиции и рыночную ситуацию. Отчитайся кратко.',
  },
}
```

Рекомендуемые интервалы:

| Агент          | Интервал | Heartbeat prompt                          |
| -------------- | -------- | ----------------------------------------- |
| orchestrator   | 30m      | Проверь статус всех агентов и task board  |
| forex-trader   | 15m      | Проверь позиции и рыночную ситуацию       |
| crypto-trader  | 10m      | Проверь позиции, funding rates, P&L       |
| market-analyst | 1h       | Проверь экономический календарь и новости |
| tech-lead      | 1h       | Проверь статус задач разработки           |
| backend-dev    | disabled | Работает по запросу от tech-lead          |
| frontend-dev   | disabled | Работает по запросу от tech-lead          |
| qa-tester      | disabled | Работает по запросу от tech-lead          |

#### Этап 1.3: Настроить логирование

```bash
# Просмотр логов в реальном времени
openclaw logs --follow

# Логи конкретного агента через Dashboard UI
# → https://76.13.250.171:8080/proxy/18789/ → Sessions → выбрать агента
```

#### Этап 1.4: Настройка Gateway для reverse proxy

Dashboard доступен извне через `https://76.13.250.171:8080/proxy/18789/`. Для корректной работы:

```json5
// ~/.openclaw/openclaw.json → gateway
{
  port: 18789,
  mode: 'local',
  bind: 'loopback', // или "lan" если proxy на другой машине
  trustedProxies: ['76.13.250.171'], // доверять reverse proxy
}
```

Если reverse proxy на том же сервере — `bind: "loopback"` достаточно. Если на другом — поменять на `"lan"` или указать IP.

### DoD (Критерии готовности)

- [ ] Gateway запущен и стабильно работает
- [ ] Dashboard открывается на `https://76.13.250.171:8080/proxy/18789/`
- [ ] Все 9 агентов видны в Dashboard
- [ ] Heartbeat включён для торговых агентов
- [ ] Логи доступны через `openclaw logs --follow`
- [ ] Systemd service установлен для автозапуска

### Оценка: 2-3 часа

---

## Задача 2: Реструктуризация проекта на TypeScript

### Проблема

- Нет TypeScript — всё на чистом JS и Python
- Нет сборки, линтинга, тестов
- `package.json` минимальный (только bybit-api)
- Скрипты разбросаны в одной папке `scripts/`

### Целевая структура

```
openclaw-assistent/
├── src/                          # Весь TypeScript код
│   ├── trading/                  # Торговые модули
│   │   ├── forex/                # Forex торговля
│   │   │   ├── client.ts         # REST API клиент брокера
│   │   │   ├── data.ts           # OHLC + индикаторы
│   │   │   ├── monitor.ts        # Мониторинг позиций
│   │   │   ├── trade.ts          # Исполнение ордеров
│   │   │   └── types.ts          # Типы и интерфейсы
│   │   ├── crypto/               # Крипто торговля
│   │   │   ├── bybit-client.ts   # Bybit API v5 клиент
│   │   │   ├── config.ts         # Конфигурация
│   │   │   ├── monitor.ts        # Автономный мониторинг
│   │   │   ├── state.ts          # State manager
│   │   │   ├── killswitch.ts     # Emergency stop
│   │   │   ├── report.ts         # Отчёты
│   │   │   └── types.ts          # Типы
│   │   └── shared/               # Общие модули
│   │       ├── indicators.ts     # EMA, RSI, ATR, S/R
│   │       ├── risk.ts           # Risk management
│   │       ├── position-sizer.ts # Калькулятор размера позиции
│   │       └── types.ts          # Общие торговые типы
│   ├── market/                   # Рыночные данные
│   │   ├── digest.ts             # Новостной дайджест (замена market_digest.py)
│   │   ├── calendar.ts           # Экономический календарь
│   │   └── sentiment.ts          # Fear & Greed, funding rates
│   ├── taskboard/                # Task Board (миграция из skills/)
│   │   ├── board.ts              # CRUD задач
│   │   └── types.ts              # Типы задач
│   ├── utils/                    # Утилиты
│   │   ├── config.ts             # Загрузка credentials
│   │   ├── logger.ts             # Структурированное логирование
│   │   └── telegram.ts           # Telegram helpers
│   └── index.ts                  # Entry point (если нужен)
├── workspaces/                   # Workspace агентов (без изменений)
├── skills/                       # Skills агентов (без изменений)
├── scripts/                      # Только bash/shell скрипты
│   ├── setup.sh
│   └── install_mt5.sh            # Удалить после миграции с MT5
├── data/                         # Рантайм данные (gitignored)
│   ├── state.json
│   ├── events.jsonl
│   └── logs/
├── dist/                         # Скомпилированный JS (gitignored)
├── .github/                      # GitHub конфигурация
│   ├── docs/
│   │   ├── plans/
│   │   ├── analyses/
│   │   ├── protocols/
│   │   ├── rules/
│   │   └── skills/
│   ├── instructions/
│   ├── agents/
│   └── workflows/
├── tsconfig.json
├── package.json
├── .eslintrc.json
├── .prettierrc
├── .gitignore
└── README.md
```

### Пошаговый план

#### Этап 2.1: Инициализация TypeScript проекта

```bash
# 1. TypeScript + tooling
npm install -D typescript @types/node tsx

# 2. Линтинг + форматирование
npm install -D eslint @typescript-eslint/parser @typescript-eslint/eslint-plugin prettier

# 3. Тестирование
npm install -D vitest

# 4. Production dependencies
npm install bybit-api node-fetch rss-parser
```

**tsconfig.json**:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**package.json** scripts:

```json
{
  "scripts": {
    "build": "tsc",
    "dev": "tsx watch src/index.ts",
    "lint": "eslint src/",
    "format": "prettier --write 'src/**/*.ts'",
    "test": "vitest",
    "trade:crypto:monitor": "tsx src/trading/crypto/monitor.ts",
    "trade:crypto:kill": "tsx src/trading/crypto/killswitch.ts",
    "trade:crypto:report": "tsx src/trading/crypto/report.ts",
    "trade:forex:monitor": "tsx src/trading/forex/monitor.ts",
    "market:digest": "tsx src/market/digest.ts"
  }
}
```

#### Этап 2.2: Создание shared модулей

Начать с типов и утилит, которые используют все модули:

1. `src/trading/shared/types.ts` — общие торговые типы (OHLC, Order, Position, etc.)
2. `src/trading/shared/indicators.ts` — EMA, RSI, ATR (вынести из Python)
3. `src/trading/shared/risk.ts` — управление рисками
4. `src/utils/config.ts` — загрузка credentials из `~/.openclaw/`
5. `src/utils/logger.ts` — структурированное логирование

#### Этап 2.3: Миграция крипто-модулей (JS → TS)

Порядок миграции (по зависимостям):

1. `crypto_config.js` → `src/trading/crypto/config.ts`
2. `crypto_state.js` → `src/trading/crypto/state.ts`
3. `bybit_trade.js` → `src/trading/crypto/bybit-client.ts`
4. `crypto_monitor.js` → `src/trading/crypto/monitor.ts`
5. `crypto_killswitch.js` → `src/trading/crypto/killswitch.ts`
6. `crypto_report.js` → `src/trading/crypto/report.ts`

#### Этап 2.4: Миграция Python → TypeScript

1. `bybit_get_data.py` → `src/trading/crypto/bybit-client.ts` (объединить с trade)
2. `mt5_get_data.py` → `src/trading/forex/data.ts`
3. `mt5_trade.py` → `src/trading/forex/trade.ts`
4. `mt5_monitor.py` → `src/trading/forex/monitor.ts`
5. `market_digest.py` → `src/market/digest.ts`
6. `fix_config.py` → удалить (одноразовая утилита)

#### Этап 2.5: Обновить workspace scripts

Каждый агент (`workspaces/*/scripts`) должен вызывать `tsx src/...` вместо `python3` или `node scripts/...`.

### DoD

- [ ] `tsconfig.json` создан и настроен
- [ ] ESLint + Prettier настроены
- [ ] Все .js файлы мигрированы в .ts с правильными типами
- [ ] Все .py файлы переписаны на .ts
- [ ] `npm run build` компилируется без ошибок
- [ ] `npm run lint` проходит
- [ ] Базовые тесты для shared модулей
- [ ] Workspace scripts обновлены

### Оценка: 8-12 часов (3-4 дня)

---

## Задача 3: Замена MT5 для Forex торговли

### Проблема

Текущая архитектура MT5:

- MT5 работает через **Wine + Xvfb** на Linux (крайне нестабильно)
- **File Bridge**: MQL5 EA экспортирует данные в CSV → Python читает/пишет CSV → EA читает ордера
- Зависимость от десктопного приложения Windows на Linux сервере
- Нет прямого API — всё через файловую систему

### Альтернативы

#### Вариант A: OANDA v20 REST API (рекомендуется)

**Плюсы**:

- Полноценный REST API (без Wine, без десктопного приложения)
- Нативно на Node.js/TypeScript
- Поддержка streaming (WebSocket) для real-time цен
- Практика-аккаунт бесплатно
- FTMO-совместимый (через OANDA-like API у FTMO)
- Хорошая документация

**Минусы**:

- Нужен отдельный аккаунт у OANDA
- Спреды могут отличаться от FTMO

```typescript
// Пример: src/trading/forex/oanda-client.ts
import { RestClient } from '@oanda/v20';

const client = new RestClient({
  url: 'https://api-fxpractice.oanda.com',
  token: process.env.OANDA_TOKEN!,
  accountId: process.env.OANDA_ACCOUNT_ID!,
});

// Получить цены
const candles = await client.instrument.candles('EUR_USD', {
  granularity: 'M15',
  count: 100,
});

// Открыть позицию
const order = await client.order.create({
  instrument: 'EUR_USD',
  units: 10000, // 0.1 лота
  type: 'MARKET',
  stopLossOnFill: { price: '1.0800' },
  takeProfitOnFill: { price: '1.0900' },
});
```

#### Вариант B: cTrader Open API

**Плюсы**:

- Modern REST + gRPC API
- Многие prop-firms используют cTrader (включая FTMO cTrader)
- Хорошо для алгоритмической торговли

**Минусы**:

- Более сложный OAuth flow
- Меньше Node.js SDK

#### Вариант C: Capital.com API

**Плюсы**:

- REST API, хорошо документирован
- Демо-аккаунт бесплатно
- Спреды конкурентные

**Минусы**:

- Не prop-firm, собственные деньги

#### Вариант D: MetaAPI (облачный MT5 API)

**Плюсы**:

- REST API поверх MT5 (MT5 в облаке)
- Совместимость с любым MT5-брокером (включая FTMO)
- Не нужен Wine/Xvfb

**Минусы**:

- Платный сервис ($20+/мес)
- Дополнительная зависимость

### Рекомендация

**Если используется FTMO** → **Вариант D: MetaAPI** — единственный способ автоматизировать именно FTMO аккаунт через REST API без Wine.

**Если можно сменить брокера** → **Вариант A: OANDA** — наиболее чистое решение, полностью REST.

### План миграции Forex

#### Этап 3.1: Выбор и настройка брокера

1. Решить: FTMO (MetaAPI) или самостоятельно (OANDA)
2. Создать аккаунт (demo/practice для начала)
3. Получить API ключ

#### Этап 3.2: Реализация клиента

```typescript
// src/trading/forex/client.ts — абстрактный интерфейс
export interface ForexBrokerClient {
  getCandles(symbol: string, timeframe: string, count: number): Promise<OHLC[]>;
  getPositions(): Promise<Position[]>;
  getAccount(): Promise<AccountInfo>;
  openOrder(params: OrderParams): Promise<OrderResult>;
  closePosition(id: string): Promise<void>;
  modifyPosition(id: string, params: ModifyParams): Promise<void>;
}

// src/trading/forex/oanda-client.ts — реализация для OANDA
// src/trading/forex/metaapi-client.ts — реализация для MetaAPI
```

#### Этап 3.3: Миграция мониторинга

Переписать `mt5_monitor.py` → `src/trading/forex/monitor.ts` используя REST API вместо file bridge.

#### Этап 3.4: Удаление MT5 зависимостей

- Удалить `scripts/install_mt5.sh`
- Удалить `scripts/manage_mt5.sh`
- Удалить `scripts/mt5.service`
- Удалить `scripts/xvfb.service`
- Удалить `scripts/OpenClaw_Bridge.mq5`
- Обновить workspace Forex Trader

### DoD

- [ ] Выбран брокер/API
- [ ] `ForexBrokerClient` интерфейс создан
- [ ] Реализация клиента для выбранного API
- [ ] Мониторинг работает через REST
- [ ] Тестовые сделки на demo аккаунте
- [ ] MT5 / Wine / Xvfb зависимости удалены
- [ ] Workspace forex-trader обновлён

### Оценка: 6-8 часов (2-3 дня)

---

## Задача 4: Удаление Python

### Проблема

6 Python-файлов создают ненужную зависимость от Python runtime. Весь функционал реализуем на TypeScript.

### План миграции

| Python файл         | Замена (TypeScript)                               | Зависимости                |
| ------------------- | ------------------------------------------------- | -------------------------- |
| `bybit_get_data.py` | Объединить с `src/trading/crypto/bybit-client.ts` | `bybit-api` (уже есть)     |
| `mt5_get_data.py`   | `src/trading/forex/data.ts`                       | Зависит от Задачи 3        |
| `mt5_trade.py`      | `src/trading/forex/trade.ts`                      | Зависит от Задачи 3        |
| `mt5_monitor.py`    | `src/trading/forex/monitor.ts`                    | Зависит от Задачи 3        |
| `market_digest.py`  | `src/market/digest.ts`                            | `rss-parser`, `node-fetch` |
| `fix_config.py`     | Удалить (одноразовая утилита)                     | —                          |

### Порядок

1. **market_digest.py** → TS (не зависит от MT5) — можно сразу
2. **bybit_get_data.py** → TS (уже есть JS-аналог) — можно сразу
3. **mt5\_\*.py** → TS — только после завершения Задачи 3

### Пример: market_digest.py → TypeScript

```typescript
// src/market/digest.ts
import Parser from 'rss-parser';

interface MarketEvent {
  title: string;
  impact: 'high' | 'medium' | 'low';
  currency: string;
  time: Date;
  source: string;
}

const parser = new Parser();

export async function getForexCalendar(): Promise<MarketEvent[]> {
  const feed = await parser.parseURL('https://nfs.faireconomy.media/ff_calendar_thisweek.xml');
  return feed.items
    .filter(item => /* filter by time window */)
    .map(item => ({
      title: item.title ?? '',
      impact: parseImpact(item.categories),
      currency: parseCurrency(item.title),
      time: new Date(item.pubDate ?? ''),
      source: 'forexfactory',
    }));
}

export async function getCryptoNews(): Promise<MarketEvent[]> {
  const feeds = [
    'https://www.coindesk.com/arc/outboundfeeds/rss/',
    'https://cointelegraph.com/rss',
  ];
  // ... parse and return
}
```

### DoD

- [ ] Все 6 Python файлов удалены
- [ ] Функциональность переписана на TypeScript
- [ ] Python больше не нужен в runtime
- [ ] Удалить `.venv/` и Python-зависимости
- [ ] Обновить README и документацию

### Оценка: 4-6 часов (входит в Задачу 2 и 3)

---

## Общий план-календарь

### Неделя 1 (27 фев — 5 мар)

| День  | Задача                                          | Результат                  |
| ----- | ----------------------------------------------- | -------------------------- |
| Чт 27 | **1.1** Запуск Gateway + Dashboard              | Dashboard работает         |
| Пт 28 | **1.2** Включение Heartbeat                     | Агенты отчитываются        |
| Пт 28 | **2.1** Инициализация TS проекта                | tsconfig, eslint, prettier |
| Сб 1  | **2.2** Shared модули (types, indicators, risk) | Базовые типы готовы        |
| Вс 2  | **2.3** Миграция крипто JS → TS                 | Крипто торговля на TS      |

### Неделя 2 (3 мар — 9 мар)

| День  | Задача                                   | Результат                   |
| ----- | ---------------------------------------- | --------------------------- |
| Пн 3  | **3.1** Выбор Forex API + аккаунт        | Решение принято, demo готов |
| Вт 4  | **3.2** ForexBrokerClient + реализация   | API клиент работает         |
| Ср 5  | **3.3** Миграция forex monitor + trading | Forex на REST API           |
| Чт 6  | **4** Удаление всех Python файлов        | Python elimination          |
| Пт 7  | **2.5** Обновление workspace scripts     | Все скрипты на tsx          |
| Сб-Вс | Тестирование + стабилизация              | Всё работает стабильно      |

### Итого: ~2 недели активной работы

---

## Зависимости между задачами

```
Задача 1 (Gateway) ──────────────────── НЕЗАВИСИМА → делать первой
Задача 2 (TypeScript) ──┬── 2.1-2.3 → НЕЗАВИСИМА
                        └── 2.4 ─────→ ЗАВИСИТ от Задачи 3
Задача 3 (Forex API)  ────────────── ЗАВИСИТ от решения по брокеру
Задача 4 (No Python)  ──┬── digest ──→ НЕЗАВИСИМА
                        └── mt5_* ───→ ЗАВИСИТ от Задачи 3
Claude для dev-агентов ──────── ОТДЕЛЬНЫЙ ПЛАН (2026-02-27-claude-models.md)
```

**Критический путь**: Задача 3 (выбор Forex API) блокирует полное удаление Python.

---

## Риски

| Риск                        | Вероятность | Влияние     | Митигация                                  |
| --------------------------- | ----------- | ----------- | ------------------------------------------ |
| FTMO не даёт API-доступ     | Средняя     | Высокое     | MetaAPI как прокси, или смена prop-firm    |
| Миграция TS ломает торговлю | Средняя     | Критическое | Параллельный запуск old+new, тесты на demo |
| Gateway нестабилен          | Низкая      | Среднее     | Systemd restart, мониторинг                |

---

## Вопросы для принятия решений

> **Решение 1**: Какой Forex API?
>
> - [ ] OANDA v20 (чистый REST, нужен свой аккаунт)
> - [ ] MetaAPI (облачный MT5, совместим с FTMO)
> - [ ] cTrader Open API (если FTMO cTrader)
> - [ ] Capital.com (демо + live)

> **Решение 2**: Приоритет?
>
> - [ ] Сначала торговля (Задачи 1, 3, 4)
> - [ ] Сначала инфраструктура (Задачи 1, 2)
> - [ ] Параллельно всё

---

## Следующие шаги

1. **Немедленно**: Запустить Gateway и открыть Dashboard на `https://76.13.250.171:8080/proxy/18789/`
2. **Сегодня**: Инициализировать TypeScript проект
3. **Решить**: Какой Forex API использовать (нужен ответ владельца)
4. **Отдельно**: Claude для dev-агентов → см. [2026-02-27-claude-models.md](2026-02-27-claude-models.md)
5. **Делегировать**: tech-lead → миграция кода на TS
