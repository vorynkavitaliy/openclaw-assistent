#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# Trading Params — View/update trading parameters at runtime
# Used by orchestrator to apply user's Telegram commands
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARAMS_FILE="${SCRIPT_DIR}/data/trading_params.json"

usage() {
  echo "Trading Params — View/update trading parameters"
  echo ""
  echo "Usage: $0 <command> [args]"
  echo ""
  echo "Commands:"
  echo "  show                      Show all current params"
  echo "  show forex|crypto         Show params for specific trader"
  echo "  set <trader> <key> <val>  Update a parameter"
  echo ""
  echo "Keys: daily_target, max_daily_loss, max_stops_day, max_sl_per_trade,"
  echo "      budget, min_trades_day, max_positions, risk_percent, max_leverage, min_rr"
  echo ""
  echo "Examples:"
  echo "  $0 show"
  echo "  $0 show forex"
  echo "  $0 set forex daily_target 200"
  echo "  $0 set crypto max_sl_per_trade 500"
  echo "  $0 set crypto max_leverage 10x"
}

do_show() {
  local trader="${1:-all}"
  python3 - "$PARAMS_FILE" "$trader" << 'PYEOF'
import json, sys

with open(sys.argv[1]) as f:
    params = json.load(f)

trader = sys.argv[2]

def fmt(section, data):
    print(f"\n📊 {section.upper()} params:")
    for k, v in data.items():
        print(f"  {k}: {v}")

if trader == "all":
    fmt("forex", params["forex"])
    fmt("crypto", params["crypto"])
    print(f"\n⏰ Updated: {params.get('updated_at','?')} by {params.get('updated_by','?')}")
elif trader in params:
    fmt(trader, params[trader])
    print(f"\n⏰ Updated: {params.get('updated_at','?')} by {params.get('updated_by','?')}")
else:
    print(f"Unknown trader: {trader}. Use 'forex' or 'crypto'.")
    sys.exit(1)
PYEOF
}

do_set() {
  local trader="$1"
  local key="$2"
  local value="$3"

  python3 - "$PARAMS_FILE" "$trader" "$key" "$value" << 'PYEOF'
import json, sys
from datetime import datetime, timezone

params_file = sys.argv[1]
trader = sys.argv[2]
key = sys.argv[3]
value = sys.argv[4]

with open(params_file) as f:
    params = json.load(f)

if trader not in params:
    print(f"❌ Unknown trader: {trader}. Use 'forex' or 'crypto'.")
    sys.exit(1)

if key not in params[trader]:
    print(f"❌ Unknown key: {key}")
    print(f"   Available: {', '.join(params[trader].keys())}")
    sys.exit(1)

old_value = params[trader][key]

# Try numeric conversion
try:
    value_parsed = int(value)
except ValueError:
    try:
        value_parsed = float(value)
    except ValueError:
        value_parsed = value

params[trader][key] = value_parsed
params["updated_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
params["updated_by"] = "user"

with open(params_file, 'w') as f:
    json.dump(params, f, indent=2, ensure_ascii=False)

print(f"✅ {trader}.{key}: {old_value} → {value_parsed}")
PYEOF
}

case "${1:-}" in
  show)
    do_show "${2:-all}"
    ;;
  set)
    if [[ $# -lt 4 ]]; then
      echo "Usage: $0 set <trader> <key> <value>"
      exit 1
    fi
    do_set "$2" "$3" "$4"
    ;;
  -h|--help|"")
    usage
    ;;
  *)
    echo "Unknown command: $1"
    usage
    exit 1
    ;;
esac
