# TOOLS.md — Crypto Trader Environment

## Data Collection (pre-heartbeat)

The check script collects ALL **raw market data** before you wake up:

```bash
bash /root/Projects/openclaw-assistent/scripts/crypto_check.sh
```

Output includes: trading params, kill switch, balance, positions, **raw indicators**
(H4+M15 EMA/RSI/ATR/bias, funding, OI, volume for all pairs), Fear & Greed, BTC dominance, tasks.

**No pre-generated signals.** YOU analyze the data and decide what to trade.

## Execution (after YOUR analysis)

```bash
# Open trade — YOU specify pair, side, qty, SL, TP based on your analysis
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/trade.ts \
  --action open --pair BTCUSDT --side BUY --qty 0.001 --sl 95000 --tp 105000 --leverage 3

# Limit order
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/trade.ts \
  --action open --pair ETHUSDT --side SELL --qty 0.01 --type Limit --price 4000 --sl 4200 --tp 3600

# Close position
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/trade.ts --action close --pair BTCUSDT

# Close all (emergency)
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/trade.ts --action close-all

# Modify SL/TP
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/trade.ts --action modify --pair BTCUSDT --sl 96000 --tp 106000

# Account status
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/trade.ts --action status

# Kill switch
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/killswitch.ts --on --reason="reason"
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/killswitch.ts --close-all
cd /root/Projects/openclaw-assistent && npx tsx src/trading/crypto/killswitch.ts --off
```

## Config

- Credentials: `~/.openclaw/openclaw.json` → `crypto` section
- Account: Unified Trading (UTA), USDT-M Linear Perpetual, Demo Trading
- Leverage: max 5x (default 3x). NEVER more than 5x.
