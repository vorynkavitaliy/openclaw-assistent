#!/usr/bin/env bash
# Market Summary — выводит последние данные монитора для оркестратора
set -euo pipefail

PROJECT_DIR="/root/Projects/openclaw-assistent"
STATE_FILE="${PROJECT_DIR}/data/state.json"
SNAPSHOTS_FILE="${PROJECT_DIR}/data/market-snapshots.jsonl"
DECISIONS_FILE="${PROJECT_DIR}/data/decisions.jsonl"
WATCHLIST_FILE="${PROJECT_DIR}/data/watchlist.json"

echo "=== CRYPTO MARKET SUMMARY $(date -u '+%Y-%m-%d %H:%M UTC') ==="

# State
echo ""
echo "--- STATE ---"
if [ -f "$STATE_FILE" ]; then
  python3 -c "
import json
with open('$STATE_FILE') as f:
    s = json.load(f)
d = s.get('daily', {})
b = s.get('balance', {})
print(f'Balance: \${b.get(\"total\", 0):.0f} (available: \${b.get(\"available\", 0):.0f})')
print(f'Positions: {len(s.get(\"positions\", []))}')
for p in s.get('positions', []):
    pnl = float(p.get('unrealisedPnl', '0') or '0')
    emoji = '+' if pnl >= 0 else ''
    print(f'  {p[\"symbol\"]} {p[\"side\"]} x{p.get(\"leverage\",\"?\")} size={p[\"size\"]} entry={p[\"entryPrice\"]} P&L={emoji}\${pnl:.2f} SL={p.get(\"stopLoss\",\"-\")} TP={p.get(\"takeProfit\",\"-\")}')
print(f'Daily: trades={d.get(\"trades\",0)} wins={d.get(\"wins\",0)} losses={d.get(\"losses\",0)} stops={d.get(\"stops\",0)} P&L=\${d.get(\"totalPnl\",0):.2f}')
print(f'Stop day: {d.get(\"stopDay\", False)}')
llm = s.get('lastLLMCycleAt')
mon = s.get('lastMonitor')
print(f'Last monitor: {mon or \"never\"}')
print(f'Last LLM cycle: {llm or \"never\"}')
" 2>/dev/null || echo "(state parse error)"
fi

# Latest confluence scores from snapshots
echo ""
echo "--- LATEST CONFLUENCE SCORES ---"
if [ -f "$SNAPSHOTS_FILE" ]; then
  python3 -c "
import json
from collections import defaultdict

scores = defaultdict(list)
with open('$SNAPSHOTS_FILE') as f:
    for line in f:
        try:
            s = json.loads(line.strip())
            scores[s['pair']].append(s)
        except:
            pass

# Show latest score per pair
pairs = sorted(scores.keys())
for pair in pairs:
    latest = scores[pair][-1]
    hist = [x['confluenceScore'] for x in scores[pair][-4:]]
    hist_str = ' -> '.join(str(h) for h in hist)
    print(f'{pair}: score={latest[\"confluenceScore\"]} conf={latest[\"confidence\"]}% regime={latest[\"regime\"]} signal={latest[\"confluenceSignal\"]} [{hist_str}]')
" 2>/dev/null || echo "(no snapshots)"
else
  echo "(no snapshots file)"
fi

# Watchlist
echo ""
echo "--- WATCHLIST ---"
if [ -f "$WATCHLIST_FILE" ]; then
  python3 -c "
import json
with open('$WATCHLIST_FILE') as f:
    w = json.load(f)
items = w.get('items', [])
if not items:
    print('(empty)')
else:
    for item in items:
        print(f'{item[\"pair\"]}: reason={item.get(\"reason\",\"?\")} expires={item.get(\"expiresAt\",\"?\")}')
" 2>/dev/null || echo "(empty)"
else
  echo "(no watchlist)"
fi

# Recent decisions (last 10)
echo ""
echo "--- RECENT DECISIONS (last 10) ---"
if [ -f "$DECISIONS_FILE" ]; then
  tail -10 "$DECISIONS_FILE" | python3 -c "
import sys, json
for line in sys.stdin:
    try:
        d = json.loads(line.strip())
        ts = d.get('timestamp','')[:16]
        sym = d.get('symbol', d.get('pair','?'))
        action = d.get('action','?')
        data = d.get('data', {})
        score = data.get('confluenceScore','')
        regime = data.get('regime','')
        reason_list = d.get('reasoning', [])
        reason = reason_list[0][:60] if reason_list else ''
        extra = f' score={score} {regime}' if score else ''
        print(f'[{ts}] {sym} {action}{extra}: {reason}')
    except:
        pass
" 2>/dev/null || echo "(no decisions)"
else
  echo "(no decisions file)"
fi

echo ""
echo "=== END ==="
