# HEARTBEAT.md — Market Analyst Autonomous Monitoring

## Schedule

| Task              | Interval     | Description                                          |
| ----------------- | ------------ | ---------------------------------------------------- |
| Market monitoring | Every 30 min | Economic calendar, news, sentiment                   |
| Trader alerts     | On event     | On important changes → comment to task in Task Board  |

## Heartbeat prompt (every 30 min)

On each heartbeat you MUST:

1. **Check economic calendar** — next 4 hours (ForexFactory, Investing.com)
2. **Check key news** — Forex + Crypto (Reuters, CoinDesk, ForexLive)
3. **Fear & Greed Index** — `curl -s "https://api.alternative.me/fng/?limit=1" | jq '.data[0]'`
4. **Bitcoin Dominance** — `curl -s "https://api.coingecko.com/api/v3/global" | jq '.data.market_cap_percentage.btc'`
5. **DXY trend** — dollar direction (risk-on / risk-off)
6. **If important changes** → add comment to relevant task, notify via sessions_send

> ⚠️ DO NOT create tasks. Only Orchestrator creates tasks. Write alerts as comments.
