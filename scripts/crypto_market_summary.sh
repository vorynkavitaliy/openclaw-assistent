#!/usr/bin/env bash
# Market Summary — читабельный формат для Telegram
set -euo pipefail

PROJECT_DIR="/root/Projects/openclaw-assistent"
STATE_FILE="${PROJECT_DIR}/data/state.json"
SNAPSHOTS_FILE="${PROJECT_DIR}/data/market-snapshots.jsonl"
DECISIONS_FILE="${PROJECT_DIR}/data/decisions.jsonl"

python3 - "$STATE_FILE" "$SNAPSHOTS_FILE" "$DECISIONS_FILE" << 'PYEOF'
import json, sys
from collections import defaultdict
from datetime import datetime, timezone

STATE_FILE = sys.argv[1]
SNAPSHOTS_FILE = sys.argv[2]
DECISIONS_FILE = sys.argv[3]

state = {}
try:
    with open(STATE_FILE) as f:
        state = json.load(f)
except:
    pass

b = state.get('balance', {})
d = state.get('daily', {})
positions = state.get('positions', [])
last_mon = state.get('lastMonitor', '')

mon_ago = ''
if last_mon:
    try:
        dt = datetime.fromisoformat(last_mon.replace('Z', '+00:00'))
        mins = int((datetime.now(timezone.utc) - dt).total_seconds() / 60)
        mon_ago = f'{mins} мин назад'
    except:
        mon_ago = last_mon[:16]

lines = []
lines.append(f'💰 ${b.get("total", 0):,.0f} | Позиций: {len(positions)} | Сделок: {d.get("trades", 0)} | P&L: ${d.get("totalPnl", 0):+.2f}')
if mon_ago:
    lines.append(f'🔄 Обновлено: {mon_ago}')
lines.append('')

# --- CONFLUENCE SCORES ---
scores = defaultdict(list)
try:
    with open(SNAPSHOTS_FILE) as f:
        for line in f:
            try:
                s = json.loads(line.strip())
                scores[s['pair']].append(s)
            except:
                pass
except:
    pass

if scores:
    pairs_sorted = sorted(scores.keys(), key=lambda p: abs(scores[p][-1]['confluenceScore']), reverse=True)

    lines.append('🎯 Сигналы (порог входа: 32-35)')
    lines.append('')

    for pair in pairs_sorted:
        latest = scores[pair][-1]
        sc = latest['confluenceScore']
        conf = latest['confidence']
        regime = latest['regime']
        abs_sc = abs(sc)

        if abs_sc >= 50:
            bar = '🟢🟢🟢🟢🟢'
        elif abs_sc >= 35:
            bar = '🟡🟡🟡🟡⚪'
        elif abs_sc >= 20:
            bar = '🟠🟠🟠⚪⚪'
        elif abs_sc >= 10:
            bar = '🔴🔴⚪⚪⚪'
        else:
            bar = '⚫⚪⚪⚪⚪'

        direction = '📉' if sc < -5 else ('📈' if sc > 5 else '➖')
        sym = pair.replace('USDT', '')

        hist = [x['confluenceScore'] for x in scores[pair][-4:]]
        if len(hist) >= 2:
            diff = hist[-1] - hist[0]
            trend = '↗' if diff > 5 else ('↘' if diff < -5 else '→')
        else:
            trend = ''

        regime_short = {
            'RANGING': 'Бок', 'WEAK_TREND': 'СлТр', 'WEAKTREND': 'СлТр',
            'STRONG_TREND': 'Тренд', 'VOLATILE': 'Вол', 'CHOPPY': 'Хаос'
        }.get(regime, regime[:3])

        lines.append(f'{direction} {sym:<5} {bar} {sc:+3d} ({conf}%) [{regime_short}] {trend}')

# --- РЕШЕНИЯ ---
decisions = []
try:
    with open(DECISIONS_FILE) as f:
        all_lines = f.readlines()
        for line in all_lines[-20:]:
            try:
                decisions.append(json.loads(line.strip()))
            except:
                pass
except:
    pass

if decisions:
    entries = [dd for dd in decisions if dd.get('action') in ('ENTER', 'EXECUTE')]
    skips = [dd for dd in decisions if dd.get('action') not in ('ENTER', 'EXECUTE')]

    lines.append('')
    if entries:
        lines.append('✅ Последние входы:')
        for dd in entries[-3:]:
            ts = dd.get('timestamp', '')[:16]
            sym = dd.get('symbol', dd.get('pair', '?')).replace('USDT', '')
            lines.append(f'  {ts} {sym}')
    else:
        skip_reasons = defaultdict(int)
        for dd in skips:
            skip_reasons[dd.get('action', '?')] += 1
        top_reason = max(skip_reasons, key=skip_reasons.get) if skip_reasons else '?'
        reason_map = {
            'CONFLUENCEBELOWTHRESHOLD': 'сигналы слишком слабые',
            'CONFLUENCE_BELOW_THRESHOLD': 'сигналы слишком слабые',
            'SKIP': 'LLM пропустил',
            'WAIT': 'LLM ждёт подтверждения',
            'NOSLOTS': 'нет свободных слотов',
            'NO_SLOTS': 'нет свободных слотов',
        }
        nice_reason = reason_map.get(top_reason, top_reason)
        lines.append(f'⏸ Нет входов — {nice_reason}')

print('\n'.join(lines))
PYEOF
