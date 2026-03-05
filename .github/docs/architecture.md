# Архитектура Crypto Trading Bot

## Обзор

Автоматизированная система торговли криптовалютами на Bybit с управлением через Telegram.

## Компоненты

```
┌─────────────────────────────┐
│    User (Telegram Bot)      │  /start, /stop, /status, /report
└─────────────┬───────────────┘
              │
              ▼
┌─────────────────────────────┐
│    bot.ts (Long Polling)    │  Принимает команды, управляет cron
└─────────────┬───────────────┘
              │
              ▼
┌─────────────────────────────┐
│  System Cron (*/5 min)      │  Запускает monitor.ts
└─────────────┬───────────────┘
              │
              ▼
┌─────────────────────────────┐
│    monitor.ts               │  Анализ рынка (бесплатно)
│    ├── market-analyzer.ts   │  12 пар x 6 модулей confluence
│    ├── position-manager.ts  │  Partial close, trailing SL
│    └── signal-executor.ts   │  Исполнение ордеров
└─────────────┬───────────────┘
              │ (event-driven, только при сигналах)
              ▼
┌─────────────────────────────┐
│    llm-advisor.ts           │  Claude Sonnet через OpenRouter
│    (30 мин cooldown,        │  ENTER / SKIP / WAIT решения
│     dedup SKIP 2ч)          │
└─────────────────────────────┘
```

## Потоки данных

### Каждые 5 минут (system cron, $0):
1. Проверка kill-switch, day limits
2. Обновление баланса и позиций (Bybit API)
3. Управление позициями (partial close at 1R, trailing SL at 1.5R)
4. Анализ 12 пар (confluence scoring -100..+100)
5. Fast-track: confluence >= 65 AND confidence >= 75% -> немедленное исполнение
6. Сохранение snapshot и decision journal

### Event-driven LLM (~$0.03/вызов):
Триггерится ТОЛЬКО когда ВСЕ условия выполнены:
- Есть кандидаты после confluence фильтра
- Cooldown 30 мин прошёл
- Пара не была SKIP < 2ч (или score вырос на 10+)
- Есть свободные слоты (< 3 позиций)

## Ключевые файлы

| Файл | Назначение |
|------|-----------|
| `src/bot.ts` | Telegram бот (polling, команды) |
| `src/trading/crypto/monitor.ts` | Главный цикл анализа |
| `src/trading/crypto/market-analyzer.ts` | Confluence scoring |
| `src/trading/crypto/llm-advisor.ts` | LLM решения (OpenRouter) |
| `src/trading/crypto/signal-executor.ts` | Исполнение ордеров |
| `src/trading/crypto/position-manager.ts` | Управление позициями |
| `src/trading/crypto/state.ts` | Состояние, P&L, лимиты |
| `src/trading/shared/confluence.ts` | 6 модулей confluence scoring |
| `src/trading/shared/regime.ts` | Определение рыночного режима |
| `scripts/trading_control.sh` | Start/stop через system crontab |

## Credentials

| Что | Где |
|-----|-----|
| Telegram Bot Token | `.env` -> `TELEGRAM_BOT_TOKEN` |
| Telegram Chat ID | `.env` -> `TELEGRAM_CHAT_ID` |
| OpenRouter API Key | `.env` -> `OPENROUTER_API_KEY` |
| Bybit API Keys | `~/.openclaw/credentials.json` |
| cTrader FIX | `~/.openclaw/credentials.json` |
