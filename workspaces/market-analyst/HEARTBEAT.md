# HEARTBEAT.md — Market Analyst Автономный мониторинг

## Расписание

| Задача           | Интервал      | Описание                                    |
| ---------------- | ------------- | ------------------------------------------- |
| Мониторинг рынка | Каждые 10 мин | Экономический календарь, новости, сентимент |
| Алерт трейдерам  | По событию    | При важных изменениях → задача в Task Board |

## Heartbeat промпт (каждые 10 мин)

При каждом heartbeat ты ДОЛЖЕН:

1. **Проверить экономический календарь** — ближайшие 4 часа (ForexFactory, Investing.com)
2. **Проверить ключевые новости** — Forex + Crypto (Reuters, CoinDesk, ForexLive)
3. **Fear & Greed Index** — `curl -s "https://api.alternative.me/fng/?limit=1" | jq '.data[0]'`
4. **Bitcoin Dominance** — `curl -s "https://api.coingecko.com/api/v3/global" | jq '.data.market_cap_percentage.btc'`
5. **DXY тренд** — направление доллара (risk-on / risk-off)
6. **При важных изменениях** → создать задачу в Task Board для трейдеров:

```bash
# Алерт для crypto-trader
bash skills/taskboard/scripts/taskboard.sh --agent market-analyst create \
  --title "⚠️ FOMC через 30 мин — не открывать позиции" \
  --assignee crypto-trader --priority critical --labels "alert,macro"
```

```
# Мгновенная доставка алертов
sessions_send target=crypto-trader message="⚠️ FOMC через 30 мин! Не открывать позиции."
sessions_send target=forex-trader message="⚠️ NFP через 30 мин! Закрыть позиции."
```

> ВСЕГДА делай ОБА шага: Task Board (трекинг) + sessions_send (мгновенная доставка).
