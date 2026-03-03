---
name: forex-monitor
description: "Запускает мониторинг Forex позиций через cTrader FIX 4.4. Показывает позиции, баланс аккаунта, heartbeat статус. Используй когда нужен статус форекс-позиций."
allowed-tools: Bash(npm run trade:forex:monitor) Bash(bash scripts/forex_check.sh) Read
---

# Forex-мониторинг (cTrader)

## Когда использовать
- Пользователь спрашивает о статусе Forex позиций
- Проверка подключения к cTrader
- Статус FTMO аккаунта

## Команды

### Мониторинг позиций
```bash
npm run trade:forex:monitor
```

### Быстрая проверка
```bash
bash scripts/forex_check.sh
```

### Расширенные опции
```bash
npx tsx src/trading/forex/monitor.ts --heartbeat    # только heartbeat
npx tsx src/trading/forex/monitor.ts --account       # статус аккаунта
npx tsx src/trading/forex/monitor.ts --trade --dry-run  # анализ без сделок
```

## Торговые пары
- EURUSD, GBPUSD, USDJPY — основные
- XAUUSD — золото

## Файлы
- `src/trading/forex/monitor.ts` — мониторинг
- `src/trading/forex/client.ts` — API клиент
- `src/trading/forex/fix-connection.ts` — FIX 4.4 протокол
- `src/trading/forex/config.ts` — конфигурация
