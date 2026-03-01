# HEARTBEAT.md — Forex Trader Autonomous Mode

## Schedule

| Task                     | Interval                    | Description                                       |
| ------------------------ | --------------------------- | ------------------------------------------------- |
| Market monitoring        | Every 10 min **(Mon-Fri)**  | Pair analysis, position management, open/close     |
| User report              | Every 2 hrs **(Mon-Fri)**   | Via orchestrator: balance, positions, P&L, drawdown |
| **Weekends (Sat-Sun)**   | **NOT WORKING**             | Forex market closed — save tokens                  |

> ⚡ **Implementation**: Heartbeat moved from agent config to OpenClaw cron job
> `forex-trader-heartbeat` with schedule `*/10 * * * 1-5` (TZ: Europe/Kyiv).
> On weekends agent is NOT called — zero tokens.

## Heartbeat prompt (every 10 min, weekdays only)

On each heartbeat you MUST:

1. **Check open positions**: P&L, SL/TP, drawdown (FTMO limits: daily <4%, total <8%)
2. **If trading session** (London 09:00-17:00 Kyiv / NY 16:00-00:00 Kyiv):
   - Analyze pairs (EUR/USD, GBP/USD, USD/JPY, AUD/USD, USD/CHF): H4 trend → M15 entry → Smart Money signals
   - If signal found → open trade automatically (without waiting for user)
3. **If outside session** — only monitor open positions
4. **Check economic calendar** — ±30 min from High Impact = don't trade
5. **Log actions** as comments to active task in Task Board

> ⚠️ You work AUTONOMOUSLY. Don't wait for approval. Analyze → decide → execute.
> FTMO rules: `skills/forex-trading/FTMO_RULES.md`

## Management

```bash
# Heartbeat — account, positions, drawdown, FTMO alerts
cd /root/Projects/openclaw-assistent && npx tsx src/trading/forex/monitor.ts --heartbeat

# Monitoring with analysis
cd /root/Projects/openclaw-assistent && npx tsx src/trading/forex/monitor.ts --trade --dry-run

# Live mode (auto-trading)
cd /root/Projects/openclaw-assistent && npx tsx src/trading/forex/monitor.ts --trade

# Risk check (FTMO max daily/total drawdown)
cd /root/Projects/openclaw-assistent && npx tsx src/trading/forex/monitor.ts --risk-check
```
