#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# Trading Control — Kill switch for all trading bots
# Stops/starts heartbeats and cleans sessions
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
STATE_FILE="${PROJECT_DIR}/scripts/data/trading_state.json"
TELEGRAM_TOKEN="7786754527:AAGifHqv2s4VD8AYKg8LNJyAjMcoN_BT89E"
TELEGRAM_CHAT="5929886678"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

send_telegram() {
  local msg="$1"
  curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage" \
    -d chat_id="${TELEGRAM_CHAT}" \
    -d text="${msg}" \
    -d parse_mode="HTML" > /dev/null 2>&1 || true
}

usage() {
  echo "Trading Control — Kill switch for trading bots"
  echo ""
  echo "Usage: $0 <command>"
  echo ""
  echo "Commands:"
  echo "  stop              Stop ALL trading bots (disable heartbeats)"
  echo "  start             Start ALL trading bots (enable heartbeats)"
  echo "  status            Show current trading status"
  echo "  cleanup           Clean all agent sessions (free memory)"
  echo "  cleanup-traders   Clean only trading agent sessions"
  echo ""
  echo "Examples:"
  echo "  $0 stop            # Emergency stop — no more token spending"
  echo "  $0 start           # Resume trading"
  echo "  $0 cleanup         # Free sessions for all agents"
  echo ""
  echo "Telegram commands (from chat):"
  echo "  /stop    — Stop all bots"
  echo "  /start   — Start all bots"
  echo "  /status  — Show status"
}

do_stop() {
  echo -e "${RED}🛑 Stopping all trading bots...${NC}"

  # Disable heartbeats via OpenClaw
  if openclaw system heartbeat disable --timeout 10000 2>/dev/null; then
    echo -e "${GREEN}✅ Heartbeats disabled${NC}"
  else
    echo -e "${YELLOW}⚠️  Heartbeat disable command failed (gateway may be down)${NC}"
  fi

  # Clean sessions to stop any in-progress work
  echo "🧹 Cleaning trading sessions..."
  openclaw sessions cleanup --agent crypto-trader --enforce 2>/dev/null || true
  openclaw sessions cleanup --agent forex-trader --enforce 2>/dev/null || true

  # Update state file
  mkdir -p "$(dirname "$STATE_FILE")"
  cat > "$STATE_FILE" << EOF
{
  "trading_enabled": false,
  "stopped_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "stopped_by": "manual"
}
EOF

  # Notify via Telegram
  send_telegram "🛑 <b>ТОРГОВЛЯ ОСТАНОВЛЕНА</b>
⏰ $(date '+%H:%M %d.%m')
💡 Heartbeat отключён, сессии очищены
🔄 Для возобновления: /start"

  echo -e "${GREEN}✅ All trading stopped. No more token spending.${NC}"
}

do_start() {
  echo -e "${GREEN}🚀 Starting trading bots...${NC}"

  # Enable heartbeats
  if openclaw system heartbeat enable --timeout 10000 2>/dev/null; then
    echo -e "${GREEN}✅ Heartbeats enabled${NC}"
  else
    echo -e "${YELLOW}⚠️  Heartbeat enable command failed (gateway may be down)${NC}"
  fi

  # Update state file
  mkdir -p "$(dirname "$STATE_FILE")"
  cat > "$STATE_FILE" << EOF
{
  "trading_enabled": true,
  "started_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "started_by": "manual"
}
EOF

  # Notify via Telegram
  send_telegram "🚀 <b>ТОРГОВЛЯ ВОЗОБНОВЛЕНА</b>
⏰ $(date '+%H:%M %d.%m')
📊 Crypto-trader: heartbeat 30m
📈 Forex-trader: heartbeat 30m (кроме выходных)
💡 Для остановки: /stop"

  echo -e "${GREEN}✅ Trading bots started. Next heartbeat in ~30 min.${NC}"
}

do_status() {
  echo "📊 Trading Control Status"
  echo "========================="

  if [[ -f "$STATE_FILE" ]]; then
    local enabled
    enabled=$(python3 -c "import json; print(json.load(open('$STATE_FILE'))['trading_enabled'])" 2>/dev/null || echo "unknown")
    if [[ "$enabled" == "True" ]]; then
      echo -e "${GREEN}🟢 Trading: ACTIVE${NC}"
    elif [[ "$enabled" == "False" ]]; then
      echo -e "${RED}🔴 Trading: STOPPED${NC}"
    else
      echo -e "${YELLOW}🟡 Trading: UNKNOWN${NC}"
    fi
  else
    echo -e "${YELLOW}🟡 Trading: NO STATE FILE (probably active)${NC}"
  fi

  echo ""
  echo "Active sessions:"
  openclaw sessions --all-agents --active 60 2>/dev/null || echo "  (gateway not available)"

  echo ""
  echo "Heartbeat status:"
  openclaw system heartbeat last 2>/dev/null || echo "  (gateway not available)"
}

do_cleanup() {
  echo "🧹 Cleaning ALL agent sessions..."
  openclaw sessions cleanup --all-agents --enforce 2>&1 || true
  echo -e "${GREEN}✅ All sessions cleaned${NC}"
}

do_cleanup_traders() {
  echo "🧹 Cleaning trading agent sessions..."
  openclaw sessions cleanup --agent crypto-trader --enforce 2>&1 || true
  openclaw sessions cleanup --agent forex-trader --enforce 2>&1 || true
  echo -e "${GREEN}✅ Trading sessions cleaned${NC}"
}

# ─── Main ─────────────────────────────────────────────────────
case "${1:-}" in
  stop)            do_stop ;;
  start)           do_start ;;
  status)          do_status ;;
  cleanup)         do_cleanup ;;
  cleanup-traders) do_cleanup_traders ;;
  -h|--help|"")    usage ;;
  *)
    echo "Unknown command: $1"
    usage
    exit 1
    ;;
esac
