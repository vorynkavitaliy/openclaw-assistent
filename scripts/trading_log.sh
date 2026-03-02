#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# Trading Log — Record and view agent trading activity
#
# Usage:
#   trading_log.sh write <agent> <action> <details>   — append entry
#   trading_log.sh show [agent] [--last N]            — view log
#   trading_log.sh summary                            — today's summary
#   trading_log.sh clear                              — clear log
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="${SCRIPT_DIR}/data/trading_log.jsonl"

mkdir -p "$(dirname "$LOG_FILE")"
touch "$LOG_FILE"

usage() {
  echo "Trading Log — Agent activity tracker"
  echo ""
  echo "Usage: $0 <command> [args]"
  echo ""
  echo "Commands:"
  echo "  write <agent> <action> <details>  — Record a trading action"
  echo "  show [agent] [--last N]           — View log entries"
  echo "  summary                           — Today's summary for all agents"
  echo "  clear                             — Clear the log"
  echo ""
  echo "Actions: started | heartbeat | trade_open | trade_close | trade_modify |"
  echo "         sl_tp_set | error | report | stopped | skip"
  echo ""
  echo "Examples:"
  echo "  $0 write crypto-trader trade_open 'BUY BTCUSDT 0.001 @ 65400 SL=64500 TP=67500'"
  echo "  $0 write forex-trader heartbeat 'Analyzed 4 pairs, no setup found, holding 2 positions'"
  echo "  $0 show crypto-trader --last 10"
  echo "  $0 summary"
}

do_write() {
  local agent="${1:?Agent required}"
  local action="${2:?Action required}"
  local details="${3:-}"

  python3 -c "
import json, datetime
entry = {
    'ts': datetime.datetime.now(datetime.UTC).strftime('%Y-%m-%dT%H:%M:%SZ'),
    'agent': '$agent',
    'action': '$action',
    'details': $(python3 -c "import json; print(json.dumps('''$details'''))")
}
with open('$LOG_FILE', 'a') as f:
    f.write(json.dumps(entry, ensure_ascii=False) + '\n')
print(f'📝 Logged: {entry[\"agent\"]} | {entry[\"action\"]} | {entry[\"details\"][:80]}')
"
}

do_show() {
  local filter_agent=""
  local last_n=20

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --last) last_n="$2"; shift 2 ;;
      -*) shift ;;
      *) filter_agent="$1"; shift ;;
    esac
  done

  if [[ ! -s "$LOG_FILE" ]]; then
    echo "📭 Trading log is empty"
    return
  fi

  python3 -c "
import json

entries = []
with open('$LOG_FILE') as f:
    for line in f:
        line = line.strip()
        if line:
            try:
                entries.append(json.loads(line))
            except: pass

agent_filter = '$filter_agent'
if agent_filter:
    entries = [e for e in entries if e.get('agent') == agent_filter]

entries = entries[-$last_n:]

if not entries:
    print('📭 No entries found')
else:
    print(f'📋 Trading Log (last {len(entries)} entries)')
    print('─' * 80)
    for e in entries:
        ts = e.get('ts', '?')[:16].replace('T', ' ')
        agent = e.get('agent', '?')[:15].ljust(15)
        action = e.get('action', '?')[:12].ljust(12)
        details = e.get('details', '')[:50]
        # Color code actions
        icon = {'started': '🚀', 'heartbeat': '💓', 'trade_open': '📈',
                'trade_close': '📉', 'trade_modify': '✏️', 'sl_tp_set': '🛡️',
                'error': '❌', 'report': '📊', 'stopped': '🛑',
                'skip': '⏭️'}.get(action.strip(), '📝')
        print(f'{ts} | {agent} | {icon} {action} | {details}')
    print('─' * 80)
"
}

do_summary() {
  if [[ ! -s "$LOG_FILE" ]]; then
    echo "📭 Trading log is empty — no activity today"
    return
  fi

  python3 -c "
import json
from datetime import datetime, timezone

today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
entries = []
with open('$LOG_FILE') as f:
    for line in f:
        line = line.strip()
        if line:
            try:
                e = json.loads(line)
                if e.get('ts', '').startswith(today):
                    entries.append(e)
            except: pass

if not entries:
    print(f'📭 No trading activity today ({today})')
else:
    print(f'📊 Trading Summary — {today}')
    print('═' * 60)

    # Group by agent
    agents = {}
    for e in entries:
        a = e.get('agent', 'unknown')
        if a not in agents:
            agents[a] = {'total': 0, 'trades': 0, 'heartbeats': 0, 'errors': 0, 'last_action': '', 'last_ts': ''}
        agents[a]['total'] += 1
        action = e.get('action', '')
        if 'trade' in action:
            agents[a]['trades'] += 1
        elif action == 'heartbeat':
            agents[a]['heartbeats'] += 1
        elif action == 'error':
            agents[a]['errors'] += 1
        agents[a]['last_action'] = f\"{action}: {e.get('details', '')[:40]}\"
        agents[a]['last_ts'] = e.get('ts', '')[:16].replace('T', ' ')

    for agent, stats in agents.items():
        status = '🟢' if stats['errors'] == 0 else '🔴'
        print(f'')
        print(f'{status} {agent}')
        print(f'   Heartbeats: {stats[\"heartbeats\"]} | Trades: {stats[\"trades\"]} | Errors: {stats[\"errors\"]}')
        print(f'   Last: {stats[\"last_ts\"]} — {stats[\"last_action\"]}')

    print('')
    print('═' * 60)
    total = sum(s['total'] for s in agents.values())
    trades = sum(s['trades'] for s in agents.values())
    print(f'Total events: {total} | Total trades: {trades}')
"
}

do_clear() {
  > "$LOG_FILE"
  echo "🧹 Trading log cleared"
}

case "${1:-}" in
  write)    shift; do_write "$@" ;;
  show)     shift; do_show "$@" ;;
  summary)  do_summary ;;
  clear)    do_clear ;;
  -h|--help|"") usage ;;
  *)
    echo "Unknown command: $1"
    usage
    exit 1
    ;;
esac
