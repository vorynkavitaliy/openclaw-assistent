# HEARTBEAT.md — Crypto Trader Автономный режим

## Расписание

| Задача             | Интервал      | Описание                                            |
| ------------------ | ------------- | --------------------------------------------------- |
| Мониторинг рынка   | Каждые 10 мин | Анализ пар, управление позициями, открытие/закрытие |
| Отчёт пользователю | Каждые 2 часа | Через orchestrator: баланс, позиции, P&L, рынок     |

## Heartbeat промпт (каждые 10 мин)

При каждом heartbeat ты ДОЛЖЕН:

1. **Проверить открытые позиции**: P&L, SL/TP, margin ratio, funding rate
2. **Проверить drawdown**: daily <4%, total <8% (HyroTrade буфер)
3. **Проанализировать пары** (BTC, ETH, SOL): 4h тренд → 15m вход → сигналы Smart Money
4. **При найденном сигнале** → открыть сделку автоматически (без ожидания пользователя)
5. **Залогировать действия** в Task Board

> ⚠️ Ты работаешь АВТОНОМНО. Не жди одобрения. Анализируй → решай → исполняй.
> Правила HyroTrade: `skills/crypto-trading/HYROTRADE_RULES.md`

## Управление

```bash
# Статус автоторговли
npx tsx src/trading/crypto/killswitch.ts

# Аварийная остановка (kill-switch)
npx tsx src/trading/crypto/killswitch.ts --on --reason="причина"

# Kill + закрыть все позиции
npx tsx src/trading/crypto/killswitch.ts --close-all

# Возобновить торговлю
npx tsx src/trading/crypto/killswitch.ts --off

# Ручной запуск мониторинга
npx tsx src/trading/crypto/monitor.ts
npx tsx src/trading/crypto/monitor.ts --dry-run    # без сделок
npx tsx src/trading/crypto/monitor.ts --pair=BTCUSDT  # одна пара

# Ручной запуск отчёта
npx tsx src/trading/crypto/report.ts
npx tsx src/trading/crypto/report.ts --format=json
```

## Cron задачи

```bash
# Установить автозапуск
./scripts/crypto_cron.sh install

# Проверить
crontab -l | grep crypto

# Удалить
./scripts/crypto_cron.sh uninstall
```

## Файлы состояния

| Файл                        | Описание                                               |
| --------------------------- | ------------------------------------------------------ |
| `scripts/data/state.json`   | Текущее состояние: дневная статистика, позиции, баланс |
| `scripts/data/events.jsonl` | Лог событий (сделки, стоп-дни, kill-switch)            |
| `scripts/data/KILL_SWITCH`  | Файл-флаг аварийной остановки                          |
| `scripts/data/logs/`        | Логи мониторинга и отчётов (ротация 7 дней)            |

## Лимиты (guard rails)

| Параметр            | Значение | Описание                     |
| ------------------- | -------- | ---------------------------- |
| Макс дневной убыток | $500     | При достижении → стоп-день   |
| Макс стопов/день    | 2        | При достижении → стоп-день   |
| Макс риск/сделку    | $250     | Не более 50% дневного лимита |
| Макс позиций        | 3        | Одновременно открытых        |
| Риск на сделку      | 2%       | От депозита                  |
| Макс плечо          | 5x       | По умолчанию 3x              |
| Мин R:R             | 1:2      | Не входить ниже              |

## Режим

Текущий режим задаётся в `~/.openclaw/openclaw.json` (секция `crypto.mode`):

- `execute` — полная автоторговля (FULL-AUTO)
- `dry-run` — только анализ, без открытия сделок
