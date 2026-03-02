# TOOLS.md — Forex Trader Environment

## Data Collection (pre-heartbeat)

The check script collects ALL data before you wake up:

```bash
bash /root/Projects/openclaw-assistent/scripts/forex_check.sh
```

Output includes: trading params, weekend/session check, account, positions, drawdown,
FTMO alerts, full market analysis (H4+M15 signals), market digest (news+calendar), tasks.

**DO NOT call monitor.ts --heartbeat or --trade --dry-run yourself** — it's already in the check script output.

## Execution (when you decide to trade)

```bash
# Execute specific pair
cd /root/Projects/openclaw-assistent && npx tsx src/trading/forex/monitor.ts --trade --pair=EURUSD

# Execute all pairs with signals
cd /root/Projects/openclaw-assistent && npx tsx src/trading/forex/monitor.ts --trade

# Open order manually
cd /root/Projects/openclaw-assistent && npx tsx src/trading/forex/trade.ts --action open \
  --pair EURUSD --side BUY --lots 0.1 --sl-pips 50 --tp-pips 100

# Close position
cd /root/Projects/openclaw-assistent && npx tsx src/trading/forex/trade.ts --action close --position-id ID

# Close all (emergency)
cd /root/Projects/openclaw-assistent && npx tsx src/trading/forex/trade.ts --action close-all
```

## Config

- Credentials: `~/.openclaw/openclaw.json` → `forex` section
- Auth: `npx ctrader-ts auth` (one-time, OAuth2)
- Broker: FTMO (prop trading firm)
