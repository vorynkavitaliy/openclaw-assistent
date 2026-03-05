#!/usr/bin/env bash
# Full Crypto Report — баланс + позиции + рынок + решения
# Используй этот скрипт для ЛЮБОГО вопроса о крипто-трейдере
set -euo pipefail

PROJECT="/root/Projects/openclaw-assistent"

# Загружаем .env
if [[ -f "${PROJECT}/.env" ]]; then
  set -a; source "${PROJECT}/.env"; set +a
fi

echo "=== CRYPTO FULL REPORT $(date -u '+%Y-%m-%d %H:%M UTC') ==="

# 1. Report (баланс, позиции, P&L)
echo ""
echo "--- REPORT ---"
npx tsx "${PROJECT}/src/trading/crypto/report.ts" --format text 2>/dev/null || echo "(report error)"

# 2. Market Summary (scores, decisions)
echo ""
bash "${PROJECT}/scripts/crypto_market_summary.sh" 2>/dev/null || echo "(summary error)"
