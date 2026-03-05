#!/usr/bin/env bash
# Full Crypto Report — баланс + позиции + рынок + решения
# Используй этот скрипт для ЛЮБОГО вопроса о крипто-трейдере
set -euo pipefail

PROJECT="/root/Projects/openclaw-assistent"

# Загружаем .env
if [[ -f "${PROJECT}/.env" ]]; then
  set -a; source "${PROJECT}/.env"; set +a
fi

# Добавляем node в PATH (для subprocess)
export PATH="/root/.nvm/versions/node/v22.22.0/bin:$PATH"

# 1. Report (баланс, позиции, P&L) — без отправки в telegram (бот сам отправит)
npx tsx "${PROJECT}/src/trading/crypto/report.ts" --format text --no-send 2>/dev/null || echo "(report error)"

# 2. Market Summary (scores, decisions)
echo ""
bash "${PROJECT}/scripts/crypto_market_summary.sh" 2>/dev/null || echo "(summary error)"
