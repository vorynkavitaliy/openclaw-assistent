#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# Forex Pre-Check — Single script for heartbeat data gathering
# Runs ALL checks in one shot to minimize LLM calls
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

PROJECT_DIR="/root/Projects/openclaw-assistent"

echo "=== FOREX CHECK $(date '+%Y-%m-%d %H:%M UTC') ==="

# ─── Weekend Check ────────────────────────────────────────────
DOW=$(date +%u)
if [ "$DOW" -ge 6 ]; then
  echo "STATUS: WEEKEND_CLOSED"
  echo "Day: $(date +%A) (day $DOW)"
  echo "ACTION: EXIT — forex market closed. Do nothing."
  exit 0
fi

echo "STATUS: MARKET_OPEN"
echo "Day: $(date +%A) (day $DOW)"
echo "Time UTC: $(date -u '+%H:%M')"

# ─── Trading Session Check ───────────────────────────────────
HOUR_UTC=$(date -u +%H)
if [ "$HOUR_UTC" -ge 6 ] && [ "$HOUR_UTC" -lt 15 ]; then
  echo "SESSION: London (active)"
elif [ "$HOUR_UTC" -ge 13 ] && [ "$HOUR_UTC" -lt 21 ]; then
  echo "SESSION: New York (active)"
else
  echo "SESSION: Off-hours (monitor only, no new entries)"
fi

# ─── Positions & Account ─────────────────────────────────────
echo ""
echo "=== POSITIONS & ACCOUNT ==="
cd "$PROJECT_DIR" && npx tsx src/trading/forex/monitor.ts --heartbeat 2>&1 || echo "ERROR: monitor.ts failed"

# ─── Task Board ──────────────────────────────────────────────
echo ""
echo "=== PENDING TASKS ==="
bash "$PROJECT_DIR/skills/taskboard/scripts/taskboard.sh" list --assignee forex-trader --status todo 2>&1 || echo "No tasks"

echo ""
echo "=== END CHECK ==="
