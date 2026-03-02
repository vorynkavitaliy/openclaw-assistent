# TOOLS.md — Crypto Trader Environment

## Data Collection (pre-heartbeat)

The check script collects ALL data before you wake up:

```bash
bash /root/Projects/openclaw-assistent/scripts/crypto_check.sh
```

Output includes: trading params, kill switch, balance, positions, full market analysis
(H4+M15 OHLC, EMA/RSI/ATR, funding, OI, BUY/SELL signals), Fear & Greed, BTC dominance, tasks.

**DO NOT call monitor.ts --dry-run yourself** — it's already in the check script output.

## Execution (when you decide to trade)

```bash
# Execute specific pair
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/monitor.ts --pair=BTCUSDT

# Execute all pairs with signals
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/monitor.ts

# Kill switch
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/killswitch.ts --on --reason="reason"
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/killswitch.ts --close-all
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/killswitch.ts --off
```

## Config

- Credentials: `~/.openclaw/openclaw.json` → `crypto` section
- Account: Unified Trading (UTA), USDT-M Linear Perpetual, Demo Trading
- Leverage: max 5x (default 3x). NEVER more than 5x.
