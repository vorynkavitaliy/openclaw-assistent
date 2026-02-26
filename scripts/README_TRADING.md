# Trading utilities (Bybit)

These scripts live in the repo-level directory:

- `/root/Projects/openclaw-assistent/scripts/bybit_trade.js` — Bybit v5 trading module
- `/root/Projects/openclaw-assistent/scripts/bybit` — friendly wrapper (subcommands)
- `/root/Projects/openclaw-assistent/scripts/market_digest.py` — news/macro digest without `web_search`

## Credentials

By default `bybit_trade.js` reads:

- `~/.openclaw/credentials.json`

Expected structure:

```json
{
  "bybit": {
    "api_key": "...",
    "api_secret": "...",
    "testnet": true,
    "default_leverage": 3,
    "max_leverage": 5
  }
}
```

Env vars override:

- `BYBIT_API_KEY`
- `BYBIT_API_SECRET`
- `BYBIT_TESTNET` (true/false)
- `BYBIT_DEMO_TRADING` (true/false)

## Common commands

From any agent workspace you can run either via the workspace symlink `./scripts/...`
(or via absolute paths in this repo).

```bash
# Positions
./scripts/bybit positions
./scripts/bybit positions --symbol=BTCUSDT

# Balance
./scripts/bybit balance --coin=USDT

# Open order (Market)
./scripts/bybit order --symbol=BTCUSDT --side=Buy --qty=0.01 --sl=65000 --tp=72000 --demo

# Open order (Limit)
./scripts/bybit order --symbol=BTCUSDT --side=Buy --type=Limit --price=65000 --qty=0.01 --demo

# Close
./scripts/bybit close --symbol=BTCUSDT --demo

# Partial close
./scripts/bybit partial-close --symbol=BTCUSDT --qty=0.005 --demo

# Modify SL/TP
./scripts/bybit modify --symbol=BTCUSDT --sl=64000 --tp=73000 --demo

# Leverage
./scripts/bybit leverage --symbol=BTCUSDT --leverage=3 --demo
```

All commands return JSON to stdout.

## Monitoring (simple loop)

A minimal polling loop that logs positions every 10s:

```bash
while true; do
  date -u "+%F %T"; ./scripts/bybit positions; sleep 10;
done
```

For cron (every minute):

```cron
* * * * * cd /root/Projects/openclaw-assistent/workspaces/crypto-trader && ./scripts/bybit positions >> positions.log 2>&1
```

## News & macro digest

```bash
python3 ./scripts/market_digest.py --hours=48 --max-news=20 --max-events=50
```

Note: ForexFactory XML mirrors may rate-limit (HTTP 429). If macro is required reliably, prefer enabling `web_fetch/web_search` with an API key or use a paid calendar API.
