#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# Trading Control — Start/stop trading heartbeats
# Dynamically adds/removes heartbeat configs from openclaw.json
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
STATE_FILE="${PROJECT_DIR}/scripts/data/trading_state.json"
OPENCLAW_CONFIG="$HOME/.openclaw/openclaw.json"
TELEGRAM_TOKEN="7786754527:AAGifHqv2s4VD8AYKg8LNJyAjMcoN_BT89E"
TELEGRAM_CHAT="5929886678"

# Colors
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
  echo "Trading Control — Manage trading bot heartbeats"
  echo ""
  echo "Usage: $0 <command>"
  echo ""
  echo "Commands:"
  echo "  start             Inject heartbeat configs + enable (starts trading)"
  echo "  stop              Remove heartbeat configs + disable (stops trading)"
  echo "  status            Show current trading status"
  echo "  cleanup           Clean all agent sessions"
  echo "  cleanup-traders   Clean only trading agent sessions"
  echo ""
  echo "How it works:"
  echo "  start → injects heartbeat configs into openclaw.json → enables heartbeat"
  echo "  stop  → disables heartbeat → removes configs → cleans sessions"
  echo ""
  echo "Heartbeat configs are NOT in openclaw.json by default = \$0 idle cost."
}

# ─── Add heartbeat configs to openclaw.json ──────────────────

inject_heartbeats() {
  python3 - "$OPENCLAW_CONFIG" "$PROJECT_DIR" << 'PYEOF'
import json, sys

config_path = sys.argv[1]
project_dir = sys.argv[2]

forex_prompt = f"""HEARTBEAT: Run check script, analyze, act.
1. exec: bash {project_dir}/scripts/forex_check.sh
2. If WEEKEND_CLOSED → stop immediately. Zero cost.
3. Analyze output. Make trading decisions per HEARTBEAT.md rules.
4. If trade signal → execute trade. If no signal → skip.
5. Send brief Telegram IN RUSSIAN: 📊 Forex [HH:MM] | Позиций: N | P&L: $X | [действия/оценка]
6. Handle any pending tasks from output.
CRITICAL: MAX 3 tool calls total. Batch operations. Be decisive."""

crypto_prompt = f"""HEARTBEAT: Run check script, analyze, act.
1. exec: bash {project_dir}/scripts/crypto_check.sh
2. If kill-switch ON → stop. Send telegram "kill-switch active".
3. Analyze output. Make trading decisions per HEARTBEAT.md rules.
4. If trade signal → execute trade. If no signal → skip.
5. Send brief Telegram IN RUSSIAN: 🪙 Crypto [HH:MM] | Позиций: N | P&L: $X | [действия/оценка]
6. Handle any pending tasks from output.
CRITICAL: MAX 3 tool calls total. Batch operations. Be decisive."""

with open(config_path, 'r') as f:
    config = json.load(f)

for agent in config.get('agents', {}).get('list', []):
    if agent['id'] == 'forex-trader':
        agent['heartbeat'] = {
            'every': '1h',
            'prompt': forex_prompt
        }
        print(f"  ✅ forex-trader: heartbeat 1h added")
    elif agent['id'] == 'crypto-trader':
        agent['heartbeat'] = {
            'every': '1h',
            'prompt': crypto_prompt
        }
        print(f"  ✅ crypto-trader: heartbeat 1h added")

with open(config_path, 'w') as f:
    json.dump(config, f, indent=2, ensure_ascii=False)

print("  📝 Config saved.")
PYEOF
}

# ─── Remove heartbeat configs from openclaw.json ─────────────

remove_heartbeats() {
  python3 - "$OPENCLAW_CONFIG" << 'PYEOF'
import json, sys

config_path = sys.argv[1]

with open(config_path, 'r') as f:
    config = json.load(f)

removed = []
for agent in config.get('agents', {}).get('list', []):
    if 'heartbeat' in agent:
        removed.append(agent['id'])
        del agent['heartbeat']

with open(config_path, 'w') as f:
    json.dump(config, f, indent=2, ensure_ascii=False)

if removed:
    print(f"  ✅ Removed heartbeat from: {', '.join(removed)}")
else:
    print("  ℹ️  No heartbeat configs found (already clean)")
print("  📝 Config saved.")
PYEOF
}

# ─── Commands ─────────────────────────────────────────────────

do_start() {
  echo -e "${GREEN}🚀 Starting trading bots...${NC}"

  # 1. Inject heartbeat configs into openclaw.json
  echo "📝 Adding heartbeat configs..."
  inject_heartbeats

  # 2. Enable heartbeats via CLI
  if openclaw system heartbeat enable --timeout 10000 2>/dev/null; then
    echo -e "${GREEN}✅ Heartbeats enabled${NC}"
  else
    echo -e "${YELLOW}⚠️  Heartbeat enable failed (gateway may need restart)${NC}"
  fi

  # 3. Update state file
  mkdir -p "$(dirname "$STATE_FILE")"
  cat > "$STATE_FILE" << EOF
{
  "trading_enabled": true,
  "started_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "started_by": "manual",
  "heartbeat_interval": "1h"
}
EOF

  # 4. Telegram notification
  local params
  params=$(python3 -c "
import json
with open('${PROJECT_DIR}/scripts/data/trading_params.json') as f:
    p = json.load(f)['forex']
print(f\"\\u0426\\u0435\\u043b\\u044c: \\${p['daily_target']}/\\u0434\\u0435\\u043d\\u044c, \\u043c\\u0430\\u043a\\u0441 \\u043f\\u0440\\u043e\\u0441\\u0430\\u0434\\u043a\\u0430 \\${p['max_daily_loss']}, SL \\u2264\\${p['max_sl_per_trade']}\")
" 2>/dev/null || echo "Цель: \$100/день, макс просадка \$50")

  send_telegram "🚀 <b>ТОРГОВЛЯ ЗАПУЩЕНА</b>
⏰ $(date '+%H:%M %d.%m')
📊 Crypto: heartbeat 1h (24/7)
📈 Forex: heartbeat 1h (пн-пт)
💰 ${params}
📌 Стратегия: лимитные ордера + управление
🛑 Для остановки: СТОП"

  echo -e "${GREEN}✅ Trading started. First heartbeat in ~1h.${NC}"
}

do_stop() {
  echo -e "${RED}🛑 Stopping all trading bots...${NC}"

  # 1. Disable heartbeats via CLI
  if openclaw system heartbeat disable --timeout 10000 2>/dev/null; then
    echo -e "${GREEN}✅ Heartbeats disabled${NC}"
  else
    echo -e "${YELLOW}⚠️  Heartbeat disable failed (gateway may be down)${NC}"
  fi

  # 2. Remove heartbeat configs from openclaw.json
  echo "📝 Removing heartbeat configs..."
  remove_heartbeats

  # 3. Clean trading sessions
  echo "🧹 Cleaning trading sessions..."
  openclaw sessions cleanup --agent crypto-trader --enforce 2>/dev/null || true
  openclaw sessions cleanup --agent forex-trader --enforce 2>/dev/null || true

  # 4. Update state file
  mkdir -p "$(dirname "$STATE_FILE")"
  cat > "$STATE_FILE" << EOF
{
  "trading_enabled": false,
  "stopped_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "stopped_by": "manual"
}
EOF

  # 5. Telegram notification
  send_telegram "🛑 <b>ТОРГОВЛЯ ОСТАНОВЛЕНА</b>
⏰ $(date '+%H:%M %d.%m')
💡 Heartbeat выключен, конфиги удалены
💰 Расход в простое: \$0
🔄 Для возобновления: напишите в чат"

  echo -e "${GREEN}✅ All trading stopped. \$0 idle cost.${NC}"
}

do_status() {
  echo "📊 Trading Control Status"
  echo "========================="

  # Check state file
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

  # Check heartbeat configs in openclaw.json
  echo ""
  echo "Heartbeat configs in openclaw.json:"
  python3 -c "
import json
with open('$OPENCLAW_CONFIG') as f:
    config = json.load(f)
found = False
for agent in config.get('agents',{}).get('list',[]):
    hb = agent.get('heartbeat')
    if hb:
        found = True
        print(f'  {agent[\"id\"]}: every {hb[\"every\"]}')
if not found:
    print('  (none — \$0 idle cost)')
" 2>/dev/null || echo "  (error reading config)"

  echo ""
  echo "Active sessions:"
  openclaw sessions 2>/dev/null || echo "  (gateway not available)"

  echo ""
  echo "Heartbeat last:"
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
  start)           do_start ;;
  stop)            do_stop ;;
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
