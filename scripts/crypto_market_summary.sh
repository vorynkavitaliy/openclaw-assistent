#!/usr/bin/env bash
# Market Summary — HTML формат для Telegram
set -euo pipefail

PROJECT_DIR="/root/Projects/openclaw-assistent"
SNAPSHOTS_FILE="${PROJECT_DIR}/data/market-snapshots.jsonl"
DECISIONS_FILE="${PROJECT_DIR}/data/decisions.jsonl"

# Торгуемые пары (должны совпадать с config.ts)
PAIRS="BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,BNBUSDT,LINKUSDT,AVAXUSDT,SUIUSDT"

python3 - "$SNAPSHOTS_FILE" "$DECISIONS_FILE" "$PAIRS" << 'PYEOF'
import json, sys
from collections import defaultdict

SNAPSHOTS_FILE = sys.argv[1]
DECISIONS_FILE = sys.argv[2]
ALLOWED_PAIRS = set(sys.argv[3].split(','))

# --- CONFLUENCE SCORES ---
scores = defaultdict(list)
try:
    with open(SNAPSHOTS_FILE) as f:
        for line in f:
            try:
                s = json.loads(line.strip())
                if s['pair'] in ALLOWED_PAIRS:
                    scores[s['pair']].append(s)
            except:
                pass
except:
    pass

lines = []

if scores:
    pairs_sorted = sorted(scores.keys(), key=lambda p: abs(scores[p][-1]['confluenceScore']), reverse=True)

    lines.append('<b>Сигналы</b>')
    lines.append('')

    for pair in pairs_sorted:
        latest = scores[pair][-1]
        sc = latest['confluenceScore']
        conf = latest['confidence']
        regime = latest['regime']
        abs_sc = abs(sc)

        if abs_sc >= 50:
            bar = '█████'
        elif abs_sc >= 35:
            bar = '████░'
        elif abs_sc >= 20:
            bar = '███░░'
        elif abs_sc >= 10:
            bar = '██░░░'
        else:
            bar = '█░░░░'

        direction = '📉' if sc < -5 else ('📈' if sc > 5 else '➖')
        sym = pair.replace('USDT', '')

        hist = [x['confluenceScore'] for x in scores[pair][-4:]]
        if len(hist) >= 2:
            diff = hist[-1] - hist[0]
            trend = '↗' if diff > 5 else ('↘' if diff < -5 else '→')
        else:
            trend = ''

        regime_map = {
            'RANGING': 'Бок', 'WEAK_TREND': 'СлТр', 'WEAKTREND': 'СлТр',
            'STRONG_TREND': 'Тренд', 'VOLATILE': 'Вол', 'CHOPPY': 'Хаос'
        }
        regime_short = regime_map.get(regime, regime[:3])

        lines.append(f'{direction} <b>{sym:<5}</b> <code>{bar} {sc:+3d}</code> ({conf}%) [{regime_short}] {trend}')

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
        lines.append('<b>Последние входы:</b>')
        for dd in entries[-3:]:
            ts = dd.get('timestamp', '')[:16]
            sym = dd.get('symbol', dd.get('pair', '?')).replace('USDT', '')
            lines.append(f'  <code>{ts}</code> {sym}')
    else:
        skip_reasons = defaultdict(int)
        for dd in skips:
            skip_reasons[dd.get('action', '?')] += 1
        top_reason = max(skip_reasons, key=skip_reasons.get) if skip_reasons else '?'
        reason_map = {
            'CONFLUENCEBELOWTHRESHOLD': 'сигналы слабые',
            'CONFLUENCE_BELOW_THRESHOLD': 'сигналы слабые',
            'SKIP': 'LLM пропустил',
            'WAIT': 'LLM ждёт',
            'NOSLOTS': 'нет слотов',
            'NO_SLOTS': 'нет слотов',
        }
        nice_reason = reason_map.get(top_reason, top_reason)
        lines.append(f'⏸ Нет входов — {nice_reason}')

print('\n'.join(lines))
PYEOF
