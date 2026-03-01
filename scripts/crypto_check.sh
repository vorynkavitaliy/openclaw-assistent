#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# Crypto Pre-Check — Single script for heartbeat data gathering
# Runs ALL checks in one shot to minimize LLM calls
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

PROJECT_DIR="/root/Projects/openclaw-assistent"

echo "=== CRYPTO CHECK $(date '+%Y-%m-%d %H:%M UTC') ==="

echo "STATUS: MARKET_OPEN"
echo "Time UTC: $(date -u '+%H:%M')"

# ─── Kill Switch Check ───────────────────────────────────────
echo ""
echo "=== KILL SWITCH ==="
cd "$PROJECT_DIR" && npx tsx src/trading/crypto/killswitch.ts 2>&1 || echo "ERROR: killswitch.ts failed"

# ─── Positions & Account ─────────────────────────────────────
echo ""
echo "=== POSITIONS & ACCOUNT ==="
cd "$PROJECT_DIR" && npx tsx src/trading/crypto/monitor.ts --dry-run 2>&1 || echo "ERROR: monitor.ts failed"

# ─── Task Board ──────────────────────────────────────────────
echo ""
echo "=== PENDING TASKS ==="
bash "$PROJECT_DIR/skills/taskboard/scripts/taskboard.sh" list --assignee crypto-trader --status todo 2>&1 || echo "No tasks"

echo ""
echo "=== END CHECK ==="
