# HEARTBEAT.md — Market Analyst (NO HEARTBEAT)

## Mode: On-Demand (no periodic activation)

Market Analyst has **NO heartbeat**. It activates ONLY when Orchestrator sends a direct message via `sessions_send`.

## When activated:

1. Read task from Task Board (Orchestrator creates it before messaging you)
2. Change task status to `in_progress`
3. Execute analysis per task requirements
4. Write results as comment to task
5. Change task status to `done`
6. Notify orchestrator: `sessions_send target=orchestrator message="TASK-XXX done. Report on Task Board."`

## Analysis Tools:

```bash
# Market digest
cd /root/Projects/openclaw-assistent && npx tsx src/market/digest.ts --hours=24 --max-news=10

# Fear & Greed Index
curl -s "https://api.alternative.me/fng/?limit=1" | jq '.data[0]'

# Bitcoin Dominance
curl -s "https://api.coingecko.com/api/v3/global" | jq '.data.market_cap_percentage.btc'
```

> ⚠️ DO NOT create tasks. Only Orchestrator creates tasks.
> ✅ YOU change your own task statuses (todo → in_progress → done)
