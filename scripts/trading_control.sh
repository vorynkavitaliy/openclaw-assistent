#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# Trading Control — Start/stop trading via system crontab
# start → creates */5 cron for monitor.ts = autonomous trading ($0 LLM on quiet market)
# stop  → removes cron = $0 idle cost
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
STATE_FILE="${PROJECT_DIR}/scripts/data/trading_state.json"
LOG_DIR="${PROJECT_DIR}/data"
# Загружаем .env если есть
if [[ -f "${PROJECT_DIR}/.env" ]]; then
  set -a
  source "${PROJECT_DIR}/.env"
  set +a
fi

TELEGRAM_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TELEGRAM_CHAT="${TELEGRAM_CHAT_ID:-}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

CRON_TAG_CRYPTO="# openclaw-crypto-monitor"
CRON_TAG_SL_GUARD="# openclaw-sl-guard"
CRON_TAG_FOREX="# openclaw-forex-monitor"

send_telegram() {
  # Пропускаем отправку если вызвано из бота (бот сам отправляет сообщения)
  if [[ "${NO_TELEGRAM:-}" == "1" ]]; then
    return 0
  fi
  local msg="$1"
  curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage" \
    -d chat_id="${TELEGRAM_CHAT}" \
    -d text="${msg}" \
    -d parse_mode="HTML" > /dev/null 2>&1 || true
}

usage() {
  echo "Trading Control — Manage trading bot via system crontab"
  echo ""
  echo "Usage: $0 <command> [agent]"
  echo ""
  echo "Commands:"
  echo "  start [agent]     Create */5 cron + RUN IMMEDIATELY"
  echo "  stop [agent]      Remove cron for agent(s) → stops trading (\$0)"
  echo "  status            Show current trading status and active crons"
  echo ""
  echo "Agent: forex-trader, crypto-trader, or omit for both"
  echo ""
  echo "How it works:"
  echo "  start → creates system crontab (every 5 min) → monitor.ts runs autonomously"
  echo "  stop  → removes cron → \$0 idle cost"
  echo "  LLM triggered ONLY when signals exist (event-driven, not timer-based)"
}

get_cron_tag() {
  local agent="$1"
  if [[ "$agent" == "crypto-trader" ]]; then
    echo "$CRON_TAG_CRYPTO"
  elif [[ "$agent" == "forex-trader" ]]; then
    echo "$CRON_TAG_FOREX"
  fi
}

has_cron() {
  local agent="$1"
  local tag
  tag=$(get_cron_tag "$agent")
  crontab -l 2>/dev/null | grep -qF "$tag"
}

has_sl_guard_cron() {
  crontab -l 2>/dev/null | grep -qF "$CRON_TAG_SL_GUARD"
}

create_cron() {
  local agent="$1"

  if has_cron "$agent"; then
    echo -e "${YELLOW}Cron for ${agent} already exists, skipping${NC}"
    return 0
  fi

  local node_bin
  node_bin="$(dirname "$(which node)")"

  local cron_line=""
  if [[ "$agent" == "crypto-trader" ]]; then
    # Каждые 5 минут: monitor.ts анализирует рынок, триггерит LLM при необходимости
    cron_line="*/5 * * * * export PATH=\"${node_bin}:\$PATH\" && cd ${PROJECT_DIR} && npx tsx src/trading/crypto/monitor.ts >> ${LOG_DIR}/monitor.log 2>&1 ${CRON_TAG_CRYPTO}"
    # Каждую минуту: sl-guard проверяет SL/TP для всех открытых позиций
    local sl_guard_line
    sl_guard_line="* * * * * export PATH=\"${node_bin}:\$PATH\" && cd ${PROJECT_DIR} && npx tsx src/trading/crypto/sl-guard.ts >> ${LOG_DIR}/sl-guard.log 2>&1 ${CRON_TAG_SL_GUARD}"

    if has_sl_guard_cron; then
      echo -e "${YELLOW}SL-Guard cron already exists, skipping${NC}"
    else
      (crontab -l 2>/dev/null || true; echo "$cron_line"; echo "$sl_guard_line") | crontab -
      echo -e "${GREEN}${agent}: cron created (monitor */5 min, sl-guard */1 min)${NC}"
      return 0
    fi
  elif [[ "$agent" == "forex-trader" ]]; then
    cron_line="*/10 * * * * export PATH=\"${node_bin}:\$PATH\" && cd ${PROJECT_DIR} && npx tsx src/trading/forex/monitor.ts >> ${LOG_DIR}/forex-monitor.log 2>&1 ${CRON_TAG_FOREX}"
  else
    echo -e "${RED}Unknown agent: $agent${NC}"
    return 1
  fi

  # Добавляем в crontab
  (crontab -l 2>/dev/null || true; echo "$cron_line") | crontab -
  echo -e "${GREEN}${agent}: cron created (every 5 min)${NC}"
}

remove_cron() {
  local agent="$1"
  local tag
  tag=$(get_cron_tag "$agent")

  if ! has_cron "$agent"; then
    echo -e "${YELLOW}${agent}: no active cron found${NC}"
    return 0
  fi

  if [[ "$agent" == "crypto-trader" ]]; then
    # Удаляем и monitor, и sl-guard
    crontab -l 2>/dev/null | grep -vF "$tag" | grep -vF "$CRON_TAG_SL_GUARD" | crontab -
    echo -e "${GREEN}${agent}: cron removed (monitor + sl-guard)${NC}"
  else
    crontab -l 2>/dev/null | grep -vF "$tag" | crontab -
    echo -e "${GREEN}${agent}: cron removed${NC}"
  fi
}

do_start() {
  local target="${1:-}"

  if [[ -z "$target" ]]; then
    echo -e "${RED}ERROR: Must specify agent name!${NC}"
    echo "Usage: $0 start <crypto-trader|forex-trader>"
    exit 1
  fi

  if [[ "$target" != "crypto-trader" && "$target" != "forex-trader" && "$target" != "all" ]]; then
    echo -e "${RED}Unknown agent: $target${NC}"
    echo "Valid agents: crypto-trader, forex-trader"
    exit 1
  fi

  # Проверяем, уже запущен ли
  local already_running=true
  if [[ "$target" == "all" ]]; then
    if ! has_cron "crypto-trader" || ! has_cron "forex-trader"; then
      already_running=false
    fi
  else
    if ! has_cron "$target"; then
      already_running=false
    fi
  fi

  if [[ "$already_running" == "true" ]]; then
    echo "ALREADY_RUNNING"
    return 0
  fi

  echo -e "${GREEN}Starting trading bots...${NC}"

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
  "heartbeat_interval": "5min",
  "agents": "${target}"
}
EOF

  send_telegram "🚀 <b>ТОРГОВЛЯ ЗАПУЩЕНА</b>
⏰ $(date '+%H:%M %d.%m')
🔄 Мониторинг: каждые 5 мин (system cron)
💡 LLM: event-driven (только при сигналах)
📌 Агенты: ${target}
🛑 Для остановки: СТОП"

  mkdir -p "$LOG_DIR"
  echo ""
  echo -e "${GREEN}Trading started. Cron will run every 5 min.${NC}"
}

do_stop() {
  local target="${1:-}"

  if [[ -z "$target" ]]; then
    echo -e "${RED}ERROR: Must specify agent name!${NC}"
    echo "Usage: $0 stop <crypto-trader|forex-trader>"
    exit 1
  fi

  if [[ "$target" != "crypto-trader" && "$target" != "forex-trader" && "$target" != "all" ]]; then
    echo -e "${RED}Unknown agent: $target${NC}"
    echo "Valid agents: crypto-trader, forex-trader"
    exit 1
  fi

  # Проверяем, уже остановлен ли
  local any_running=false
  if [[ "$target" == "all" ]]; then
    if has_cron "crypto-trader" || has_cron "forex-trader"; then
      any_running=true
    fi
  else
    if has_cron "$target"; then
      any_running=true
    fi
  fi

  if [[ "$any_running" == "false" ]]; then
    echo "ALREADY_STOPPED"
    return 0
  fi

  echo -e "${RED}Stopping trading bots...${NC}"

  if [[ "$target" == "all" || "$target" == "crypto-trader" ]]; then
    remove_cron "crypto-trader"
  fi
  if [[ "$target" == "all" || "$target" == "forex-trader" ]]; then
    remove_cron "forex-trader"
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
💡 Cron удалён
💰 Расход в простое: \$0
🔄 Для возобновления: напишите в чат"

  echo -e "${GREEN}Trading stopped. \$0 idle cost.${NC}"
}

do_status() {
  echo "Trading Control Status"
  echo "========================="

  if [[ -f "$STATE_FILE" ]]; then
    local enabled
    enabled=$(python3 -c "import json; print(json.load(open('$STATE_FILE'))['trading_enabled'])" 2>/dev/null || echo "unknown")
    if [[ "$enabled" == "True" ]]; then
      echo -e "${GREEN}Trading: ACTIVE${NC}"
    elif [[ "$enabled" == "False" ]]; then
      echo -e "${RED}Trading: STOPPED${NC}"
    else
      echo -e "${YELLOW}Trading: UNKNOWN${NC}"
    fi
  else
    echo -e "${YELLOW}Trading: NO STATE FILE${NC}"
  fi

  echo ""
  echo "System cron entries:"
  crontab -l 2>/dev/null | grep -E "openclaw-(crypto|forex)" || echo "  (none)"

  echo ""
  echo "Monitor log (last 15 lines):"
  tail -15 "${LOG_DIR}/monitor.log" 2>/dev/null || echo "  (no log)"

}

case "${1:-}" in
  start)           do_start "${2:-}" ;;
  stop)            do_stop "${2:-}" ;;
  status)          do_status ;;
  -h|--help|"")    usage ;;
  *)
    echo "Unknown command: $1"
    usage
    exit 1
    ;;
esac
