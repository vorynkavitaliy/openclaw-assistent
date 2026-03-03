---
name: crypto-monitor
description: "Запускает мониторинг криптовалютного портфеля Bybit. Показывает позиции, P&L, MarketAnalysis с индикаторами. Используй когда нужен статус крипто-позиций или рыночные данные."
allowed-tools: Bash(npm run trade:crypto:monitor) Bash(npm run trade:crypto:report) Bash(bash scripts/crypto_check.sh) Read
---

# Крипто-мониторинг (Bybit)

## Когда использовать
- Пользователь спрашивает о статусе крипто-позиций
- Нужны текущие рыночные данные (BTC, ETH и др.)
- Проверка P&L и баланса

## Команды

### Полный мониторинг (позиции + анализ)
```bash
npm run trade:crypto:monitor
```

### Отчёт по портфелю (P&L, баланс)
```bash
npm run trade:crypto:report
```

### Быстрая проверка рынка
```bash
bash scripts/crypto_check.sh
```

## Что показывает мониторинг

- Текущие позиции (symbol, side, size, PnL)
- Баланс аккаунта (equity, available margin)
- MarketAnalysis: EMA тренд, RSI зона, funding rate
- Дневной P&L и лимиты

## Файлы

- `src/trading/crypto/monitor.ts` — основной мониторинг
- `src/trading/crypto/report.ts` — отчёт
- `src/trading/crypto/state.ts` — state (P&L, лимиты)
- `src/trading/crypto/bybit-client.ts` — API клиент
