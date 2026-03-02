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

**SL and TP are MANDATORY for every order.** Use absolute prices from your analysis.

```bash
# Open trade — YOU specify pair, side, lots, SL/TP as ABSOLUTE PRICES
cd /root/Projects/openclaw-assistent && npx tsx src/trading/forex/trade.ts \
  --action open --pair EURUSD --side BUY --lots 0.1 --sl 1.0800 --tp 1.0950

# Close position
cd /root/Projects/openclaw-assistent && npx tsx src/trading/forex/trade.ts --action close --position-id ID

# Close all (emergency or Friday close)
cd /root/Projects/openclaw-assistent && npx tsx src/trading/forex/trade.ts --action close-all

# Modify SL/TP (absolute prices)
cd /root/Projects/openclaw-assistent && npx tsx src/trading/forex/trade.ts --action modify \
  --position-id ID --sl 1.0820 --tp 1.0970
```

> ⚠️ **ALWAYS use `--sl` and `--tp` with absolute prices.** You have current prices from snapshot data — calculate SL/TP levels yourself. Orders without SL or TP will be REJECTED.

## Config

- Credentials: `~/.openclaw/openclaw.json` → `forex` section
- Auth: `npx ctrader-ts auth` (one-time, OAuth2)
- Broker: FTMO (prop trading firm)
