#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# Forex Pre-Check — COMPREHENSIVE data collection for heartbeat
# Collects ALL data in ONE shot so the LLM doesn't have to.
# Output = everything the agent needs to make BUY/SELL/HOLD decisions.
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

PROJECT_DIR="/root/Projects/openclaw-assistent"
PARAMS_FILE="${PROJECT_DIR}/scripts/data/trading_params.json"

echo "=== FOREX CHECK $(date '+%Y-%m-%d %H:%M UTC') ==="

# ─── 1. Trading Params (dynamic, set by user via Telegram) ───
echo ""
echo "=== TRADING PARAMS ==="
python3 -c "
import json
with open('$PARAMS_FILE') as f:
    p = json.load(f)['forex']
for k,v in p.items():
    print(f'  {k}: {v}')
" 2>/dev/null || echo "  (params file missing, using defaults)"

# ─── 2. Weekend Check ────────────────────────────────────────
DOW=$(date +%u)
if [ "$DOW" -ge 6 ]; then
  echo ""
  echo "STATUS: WEEKEND_CLOSED"
  echo "Day: $(date +%A) (day $DOW)"
  echo "ACTION: EXIT — forex market closed. Do nothing."
  exit 0
fi

echo ""
echo "STATUS: MARKET_OPEN"
echo "Day: $(date +%A) (day $DOW)"
echo "Time UTC: $(date -u '+%H:%M')"

# ─── 3. Trading Session Detection ────────────────────────────
HOUR_UTC=$(date -u +%H)
if [ "$HOUR_UTC" -ge 6 ] && [ "$HOUR_UTC" -lt 15 ]; then
  echo "SESSION: London (active — HIGH priority)"
elif [ "$HOUR_UTC" -ge 13 ] && [ "$HOUR_UTC" -lt 21 ]; then
  echo "SESSION: New York (active — HIGH priority)"
else
  echo "SESSION: Off-hours (monitor only, no new entries)"
fi

# ─── 4. Market Snapshot (RAW DATA — no signals, no execution)
# snapshot.ts collects: account, positions, drawdown, FTMO alerts,
# H4+M15 indicators (EMA/RSI/ATR/bias) for ALL pairs.
# YOU analyze this data and decide what to trade.
echo ""
echo "=== MARKET SNAPSHOT (raw data for your analysis) ==="
cd "$PROJECT_DIR" && npx tsx src/trading/forex/snapshot.ts 2>&1 || echo "ERROR: snapshot.ts failed"

# ─── 5. Macro Sentiment ──────────────────────────────────────
echo ""
echo "=== MACRO SENTIMENT ==="
echo "--- Market Digest (24h) ---"
cd "$PROJECT_DIR" && npx tsx src/market/digest.ts --hours=24 --max-news=5 2>&1 || echo "  (unavailable)"

# ─── 6. Task Board ───────────────────────────────────────────
echo ""
echo "=== PENDING TASKS ==="
bash "$PROJECT_DIR/skills/taskboard/scripts/taskboard.sh" list --assignee forex-trader --status todo 2>&1 || echo "No tasks"

# ─── 7. Recent Events (last 5) ──────────────────────────────
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
bash "${PROJECT_DIR}/scripts/trading_log.sh" show forex-trader --last 3 2>/dev/null || echo "  (no log yet)"

echo ""
echo "=== END CHECK ==="
echo ""
echo "INSTRUCTIONS: All data above is pre-collected. DO NOT run additional data-gathering commands."
echo "Your job: ANALYZE the raw market data above, decide what to trade (or HOLD), EXECUTE if warranted, send Telegram report. MAX 2 more tool calls."
