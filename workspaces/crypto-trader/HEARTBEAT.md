# HEARTBEAT.md — Crypto Trader Автономный режим

## Расписание

| Задача           | Интервал             | Скрипт              | Описание                                          |
| ---------------- | -------------------- | ------------------- | ------------------------------------------------- |
| Мониторинг рынка | Каждые 10 мин        | `crypto_monitor.js` | Анализ пар, управление позициями, открытие сделок |
| Часовой отчёт    | Каждый час в :10 UTC | `crypto_report.js`  | Отчёт в Telegram: баланс, позиции, PnL, рынок     |

## Управление

```bash
# Статус автоторговли
node scripts/crypto_killswitch.js --status

# Аварийная остановка (kill-switch)
node scripts/crypto_killswitch.js --on --reason="причина"

# Kill + закрыть все позиции
node scripts/crypto_killswitch.js --close-all

# Возобновить торговлю
node scripts/crypto_killswitch.js --off

# Ручной запуск мониторинга
node scripts/crypto_monitor.js
node scripts/crypto_monitor.js --dry-run    # без сделок
node scripts/crypto_monitor.js --pair=BTCUSDT  # одна пара

# Ручной запуск отчёта
node scripts/crypto_report.js
node scripts/crypto_report.js --format=json
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

Текущий режим задаётся в `scripts/crypto_config.js`:

- `execute` — полная автоторговля (FULL-AUTO)
- `dry-run` — только анализ, без открытия сделок
