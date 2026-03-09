---
name: trading-status
description: "Единый дашборд: баланс, позиции, последние решения Claude, P&L за день, статус сервисов. Запуск: /trading-status"
user-invocable: true
allowed-tools: Bash(pm2 *) Bash(tail *) Bash(cat *) Bash(wc *) Bash(grep *) Bash(crontab -l) Read Glob
---

# Торговый дашборд

Собери полную картину состояния торговой системы.

## Шаги

### 1. Статус сервисов
```bash
pm2 status
crontab -l | grep -E "crypto|forex|openclaw"
```

### 2. Последний цикл мониторинга
```bash
tail -100 /root/Projects/openclaw-assistent/data/monitor.log | grep -E "Confluence score|Claude|SKIP|ENTER|WAIT|cycle complete|error"
```

### 3. Решения Claude за сегодня
```bash
tail -500 /root/Projects/openclaw-assistent/data/monitor.log | grep -E "Claude (SKIP|ENTER|WAIT|CLOSE|response|cycle)"
```

### 4. Статистика решений
```bash
grep -c "ENTER" /root/Projects/openclaw-assistent/data/monitor.log 2>/dev/null || echo "0"
grep -c "SKIP" /root/Projects/openclaw-assistent/data/monitor.log 2>/dev/null || echo "0"
```

### 5. State файл (баланс, P&L, позиции)
```bash
cat /root/Projects/openclaw-assistent/data/state.json 2>/dev/null
```

### 6. Ошибки за последний час
```bash
tail -500 /root/Projects/openclaw-assistent/data/monitor.log | grep -i "error" | tail -10
```

### 7. SL-Guard статус
```bash
tail -20 /root/Projects/openclaw-assistent/data/sl-guard.log 2>/dev/null
```

## Формат результата

```
## Торговый дашборд [ДАТА ВРЕМЯ Kyiv]

### Сервисы
- Bot: online/offline (uptime)
- Monitor cron: active/inactive (*/5)
- SL-Guard cron: active/inactive (*/1)

### Баланс и позиции
- Equity: $XXX
- Открытые позиции: N
- Дневной P&L: $XXX

### Решения Claude (сегодня)
- ENTER: N | SKIP: N | WAIT: N
- Последнее решение: [пара] [действие] [причина]

### Ошибки
- [список или "Нет ошибок"]

### Сигналы (последний цикл)
- Прошли confluence: N пар
- Лучший: [пара] score=X conf=Y%
```
