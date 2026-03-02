# TOOLS.md — Forex Trader Environment

## Data Collection (pre-heartbeat)

The check script collects ALL **raw market data** before you wake up:

```bash
bash /root/Projects/openclaw-assistent/scripts/forex_check.sh
```

Output includes: trading params, weekend/session check, account, positions, drawdown,
FTMO alerts, **raw indicators** (H4+M15 EMA/RSI/ATR/bias for all pairs), market digest (news+calendar), tasks.

**No pre-generated signals.** YOU analyze the data and decide what to trade.

## Execution (after YOUR analysis)

```bash
# Open trade — YOU specify pair, side, lots, SL/TP based on your analysis
cd /root/Projects/openclaw-assistent && npx tsx src/trading/forex/trade.ts \
  --action open --pair EURUSD --side BUY --lots 0.1 --sl-pips 50 --tp-pips 100

# Close position
cd /root/Projects/openclaw-assistent && npx tsx src/trading/forex/trade.ts --action close --position-id ID

# Close all (emergency or Friday close)
cd /root/Projects/openclaw-assistent && npx tsx src/trading/forex/trade.ts --action close-all

# Modify SL/TP
cd /root/Projects/openclaw-assistent && npx tsx src/trading/forex/trade.ts --action modify \
  --position-id ID --sl-pips 40 --tp-pips 80
```

## Config

- Credentials: `~/.openclaw/openclaw.json` → `forex` section
- Auth: `npx ctrader-ts auth` (one-time, OAuth2)
- Broker: FTMO (prop trading firm)
