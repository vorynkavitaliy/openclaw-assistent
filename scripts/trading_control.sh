#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# Trading Control — Start/stop trading via openclaw cron
# start → creates 2h cron jobs for traders = autonomous trading
# stop  → removes cron jobs + cleans sessions = $0 idle cost
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
STATE_FILE="${PROJECT_DIR}/scripts/data/trading_state.json"
CRON_IDS_FILE="${PROJECT_DIR}/scripts/data/cron_ids.json"
TELEGRAM_TOKEN="7786754527:AAGifHqv2s4VD8AYKg8LNJyAjMcoN_BT89E"
TELEGRAM_CHAT="5929886678"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

send_telegram() {
  local msg="$1"
  curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage" \
    -d chat_id="${TELEGRAM_CHAT}" \
    -d text="${msg}" \
    -d parse_mode="HTML" > /dev/null 2>&1 || true
}

usage() {
  echo "Trading Control — Manage trading bot cron heartbeats"
  echo ""
  echo "Usage: $0 <command> [agent]"
  echo ""
  echo "Commands:"
  echo "  start [agent]     Create 2h cron for agent(s) → starts trading"
  echo "  stop [agent]      Remove cron for agent(s) → stops trading (\$0)"
  echo "  status            Show current trading status and active crons"
  echo "  cleanup           Clean all agent sessions"
  echo "  cleanup-traders   Clean only trading agent sessions"
  echo ""
  echo "Agent: forex-trader, crypto-trader, or omit for both"
  echo ""
  echo "How it works:"
  echo "  start → creates openclaw cron (every 2h) → agent runs autonomously"
  echo "  stop  → removes cron → cleans sessions → \$0 idle cost"
  echo ""
  echo "No cron = no heartbeat = \$0. Crons only exist while task is active."
}

create_cron() {
  local agent="$1"
  local check_script=""

  if [[ "$agent" == "crypto-trader" ]]; then
    check_script="crypto_check.sh"
  elif [[ "$agent" == "forex-trader" ]]; then
    check_script="forex_check.sh"
  else
    echo -e "${RED}Unknown agent: $agent${NC}"
    return 1
  fi

  # Check if cron already exists
  local existing
  existing=$(openclaw cron list --json 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    for job in data:
        if job.get('name') == '${agent}-heartbeat':
            print(job['id'])
            break
except: pass
" 2>/dev/null || true)

  if [[ -n "$existing" ]]; then
    echo -e "${YELLOW}⚠️  Cron for ${agent} already exists (${existing}), skipping${NC}"
    return 0
  fi

  local msg="Heartbeat: запусти ${check_script}, проанализируй рынок и прими торговые решения по HEARTBEAT.md"

  local result
  result=$(openclaw cron add \
    --agent "$agent" \
    --name "${agent}-heartbeat" \
    --every 2h \
    --message "$msg" \
    --session isolated \
    --timeout-seconds 300 \
    --no-deliver \
    --json 2>&1)

  local cron_id
  cron_id=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null || echo "")

  if [[ -n "$cron_id" ]]; then
    echo -e "${GREEN}✅ ${agent}: cron created (every 2h) — ${cron_id}${NC}"
    save_cron_id "$agent" "$cron_id"
  else
    echo -e "${RED}❌ Failed to create cron for ${agent}${NC}"
    echo "$result"
    return 1
  fi
}

remove_cron() {
  local agent="$1"

  local cron_id
  cron_id=$(openclaw cron list --json 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    for job in data:
        if job.get('name') == '${agent}-heartbeat':
            print(job['id'])
            break
except: pass
" 2>/dev/null || true)

  if [[ -z "$cron_id" ]]; then
    cron_id=$(get_saved_cron_id "$agent" 2>/dev/null || true)
  fi

  if [[ -n "$cron_id" ]]; then
    openclaw cron rm "$cron_id" 2>/dev/null && \
      echo -e "${GREEN}✅ ${agent}: cron removed${NC}" || \
      echo -e "${YELLOW}⚠️  ${agent}: cron removal failed${NC}"
    remove_saved_cron_id "$agent"
  else
    echo -e "${YELLOW}ℹ️  ${agent}: no active cron found${NC}"
  fi
}

save_cron_id() {
  local agent="$1" cron_id="$2"
  mkdir -p "$(dirname "$CRON_IDS_FILE")"
  python3 -c "
import json, os
path = '$CRON_IDS_FILE'
data = {}
if os.path.exists(path):
    with open(path) as f:
        data = json.load(f)
data['$agent'] = '$cron_id'
with open(path, 'w') as f:
    json.dump(data, f, indent=2)
"
}

get_saved_cron_id() {
  local agent="$1"
  python3 -c "
import json
with open('$CRON_IDS_FILE') as f:
    print(json.load(f).get('$agent', ''))
" 2>/dev/null || true
}

remove_saved_cron_id() {
  local agent="$1"
  python3 -c "
import json, os
path = '$CRON_IDS_FILE'
if os.path.exists(path):
    with open(path) as f:
        data = json.load(f)
    data.pop('$agent', None)
    with open(path, 'w') as f:
        json.dump(data, f, indent=2)
" 2>/dev/null || true
}

do_start() {
  local target="${1:-all}"
  echo -e "${GREEN}🚀 Starting trading bots...${NC}"

  if [[ "$target" == "all" || "$target" == "crypto-trader" ]]; then
    create_cron "crypto-trader"
  fi
  if [[ "$target" == "all" || "$target" == "forex-trader" ]]; then
    create_cron "forex-trader"
  fi

  mkdir -p "$(dirname "$STATE_FILE")"
  cat > "$STATE_FILE" << EOF
{
  "trading_enabled": true,
  "started_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "started_by": "manual",
  "heartbeat_interval": "2h",
  "agents": "${target}"
}
EOF

  local params
  params=$(python3 -c "
import json
with open('${PROJECT_DIR}/scripts/data/trading_params.json') as f:
    p = json.load(f)['crypto']
print(f\"Цель: \${p['daily_target']}/день, макс просадка \${p['max_daily_loss']}, SL ≤\${p['max_sl_per_trade']}\")
" 2>/dev/null || echo "Цель: \$100/день, макс просадка \$50")

  send_telegram "🚀 <b>ТОРГОВЛЯ ЗАПУЩЕНА</b>
⏰ $(date '+%H:%M %d.%m')
🔄 Heartbeat: каждые 2 часа (cron)
💰 ${params}
📌 Агенты: ${target}
🛑 Для остановки: СТОП"

  echo -e "${GREEN}✅ Trading started. First heartbeat in ~2h.${NC}"
}

do_stop() {
  local target="${1:-all}"
  echo -e "${RED}🛑 Stopping trading bots...${NC}"

  if [[ "$target" == "all" || "$target" == "crypto-trader" ]]; then
    remove_cron "crypto-trader"
    openclaw sessions cleanup --agent crypto-trader --enforce 2>/dev/null || true
  fi
  if [[ "$target" == "all" || "$target" == "forex-trader" ]]; then
    remove_cron "forex-trader"
    openclaw sessions cleanup --agent forex-trader --enforce 2>/dev/null || true
  fi

  mkdir -p "$(dirname "$STATE_FILE")"
  cat > "$STATE_FILE" << EOF
{
  "trading_enabled": false,
  "stopped_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "stopped_by": "manual"
}
EOF

  send_telegram "🛑 <b>ТОРГОВЛЯ ОСТАНОВЛЕНА</b>
⏰ $(date '+%H:%M %d.%m')
💡 Cron удалён, сессии очищены
💰 Расход в простое: \$0
🔄 Для возобновления: напишите в чат"

  echo -e "${GREEN}✅ Trading stopped. \$0 idle cost.${NC}"
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
    echo -e "${YELLOW}🟡 Trading: NO STATE FILE${NC}"
  fi

  echo ""
  echo "Active cron jobs:"
  openclaw cron list 2>&1 || echo "  (gateway not available)"

  echo ""
  echo "Active sessions:"
  openclaw sessions 2>/dev/null || echo "  (gateway not available)"
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

case "${1:-}" in
  start)           do_start "${2:-all}" ;;
  stop)            do_stop "${2:-all}" ;;
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
