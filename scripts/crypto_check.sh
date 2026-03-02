#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# Crypto Pre-Check — COMPREHENSIVE data collection for heartbeat
# Collects ALL data in ONE shot so the LLM doesn't have to.
# Output = everything the agent needs to make BUY/SELL/HOLD decisions.
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

PROJECT_DIR="/root/Projects/openclaw-assistent"
PARAMS_FILE="${PROJECT_DIR}/scripts/data/trading_params.json"

echo "=== CRYPTO CHECK $(date '+%Y-%m-%d %H:%M UTC') ==="

# ─── 1. Trading Params (dynamic, set by user via Telegram) ───
echo ""
echo "=== TRADING PARAMS ==="
python3 -c "
import json
with open('$PARAMS_FILE') as f:
    p = json.load(f)['crypto']
for k,v in p.items():
    print(f'  {k}: {v}')
" 2>/dev/null || echo "  (params file missing, using defaults)"

echo ""
echo "STATUS: MARKET_OPEN"
echo "Time UTC: $(date -u '+%H:%M')"

# ─── 2. Kill Switch Check ────────────────────────────────────
echo ""
echo "=== KILL SWITCH ==="
cd "$PROJECT_DIR" && npx tsx src/trading/crypto/killswitch.ts 2>&1 || echo "ERROR: killswitch.ts failed"

# ─── 3. Market Snapshot (RAW DATA — no signals, no execution)
# snapshot.ts collects: balance, positions, H4+M15 indicators
# (EMA/RSI/ATR/bias), funding rate, OI, volume for ALL pairs.
# YOU analyze this data and decide what to trade.
echo ""
echo "=== MARKET SNAPSHOT (raw data for your analysis) ==="
cd "$PROJECT_DIR" && npx tsx src/trading/crypto/snapshot.ts 2>&1 || echo "ERROR: snapshot.ts failed"

# ─── 4. Macro Sentiment (quick API calls) ────────────────────
echo ""
echo "=== MACRO SENTIMENT ==="

# Fear & Greed Index
echo "--- Fear & Greed ---"
curl -sf --max-time 5 "https://api.alternative.me/fng/?limit=1" 2>/dev/null \
  | python3 -c "
import sys,json
d=json.load(sys.stdin)['data'][0]
print(f\"  Value: {d['value']} ({d['value_classification']})\")
print(f\"  Updated: {d['timestamp']}\")
" 2>/dev/null || echo "  (unavailable)"

# BTC Dominance
echo "--- BTC Dominance ---"
curl -sf --max-time 5 "https://api.coingecko.com/api/v3/global" 2>/dev/null \
  | python3 -c "
import sys,json
d=json.load(sys.stdin)['data']
btc=d['market_cap_percentage']['btc']
eth=d['market_cap_percentage']['eth']
print(f\"  BTC: {btc:.1f}%\")
print(f\"  ETH: {eth:.1f}%\")
print(f\"  Total Market Cap: \${d['total_market_cap']['usd']/1e12:.2f}T\")
" 2>/dev/null || echo "  (unavailable)"

# ─── 5. Task Board ───────────────────────────────────────────
echo ""
echo "=== PENDING TASKS ==="
bash "$PROJECT_DIR/skills/taskboard/scripts/taskboard.sh" list --assignee crypto-trader --status todo 2>&1 || echo "No tasks"

# ─── 6. Recent Events (last 5) ──────────────────────────────
echo ""
echo "=== RECENT EVENTS ==="
EVENTS_FILE="${PROJECT_DIR}/scripts/data/events.jsonl"
if [ -f "$EVENTS_FILE" ]; then
  tail -5 "$EVENTS_FILE" 2>/dev/null || echo "  (empty)"
else
  echo "  (no events file)"
fi

# ─── YOUR RECENT ACTIVITY LOG ─────────────────────────────────
echo ""
echo "=== YOUR RECENT LOG (last 3 entries) ==="
bash "${PROJECT_DIR}/scripts/trading_log.sh" show crypto-trader --last 3 2>/dev/null || echo "  (no log yet)"

echo ""
echo "=== END CHECK ==="
echo ""
echo "INSTRUCTIONS: All data above is pre-collected. DO NOT run additional data-gathering commands."
echo "Your job: ANALYZE the raw market data above, decide what to trade (or HOLD), EXECUTE if warranted, send Telegram report. MAX 2 more tool calls."
