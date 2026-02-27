#!/usr/bin/env bash
set -euo pipefail
#
# crypto_cron.sh — запускает мониторинг (10м) и отчёт (1ч в :10)
# через cron или systemd timer.
#
# Использование из cron:
#   */10 * * * * /root/Projects/openclaw-assistent/scripts/crypto_cron.sh monitor
#   10   * * * * /root/Projects/openclaw-assistent/scripts/crypto_cron.sh report
#
# Или напрямую:
#   ./scripts/crypto_cron.sh monitor
#   ./scripts/crypto_cron.sh report
#   ./scripts/crypto_cron.sh status
#   ./scripts/crypto_cron.sh install    # установить cron задачи
#   ./scripts/crypto_cron.sh uninstall  # удалить cron задачи
#

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$SCRIPT_DIR/data/logs"
# Cron может запускаться с урезанным PATH (без nvm). Фиксируем node явно.
export PATH="/root/.nvm/versions/node/v22.22.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"
NODE="$(command -v node || true)"
if [[ -z "$NODE" ]]; then
  echo "ERROR: node не найден в PATH" >&2
  exit 1
fi

# Убедимся что директория логов существует
mkdir -p "$LOG_DIR"

# Лог-файл с ротацией по дням
TODAY=$(date -u +%Y-%m-%d)
MONITOR_LOG="$LOG_DIR/monitor_${TODAY}.log"
REPORT_LOG="$LOG_DIR/report_${TODAY}.log"

# Ротация: удалить логи старше 7 дней
find "$LOG_DIR" -name "*.log" -mtime +7 -delete 2>/dev/null || true

cmd="${1:-status}"

case "$cmd" in
  monitor)
    echo "=== $(date -u -Iseconds) === MONITOR ===" >> "$MONITOR_LOG"
    cd "$PROJECT_DIR"
    "$NODE" "$SCRIPT_DIR/crypto_monitor.js" >> "$MONITOR_LOG" 2>&1
    echo "" >> "$MONITOR_LOG"
    ;;

  report)
    echo "=== $(date -u -Iseconds) === REPORT ===" >> "$REPORT_LOG"
    cd "$PROJECT_DIR"

    # Генерируем отчёт
    REPORT_TEXT=$("$NODE" "$SCRIPT_DIR/crypto_report.js" --format=text 2>&1)
    echo "$REPORT_TEXT" >> "$REPORT_LOG"

    # Отправляем через OpenClaw agent → Telegram
    if command -v openclaw &>/dev/null; then
      openclaw agent --agent crypto-trader \
        --message "Отправь этот часовой отчёт в Telegram чату telegram:5929886678 (через message.send):\n\n${REPORT_TEXT}" \
        >> "$REPORT_LOG" 2>&1 || true
    fi
    echo "" >> "$REPORT_LOG"
    ;;

  status)
    cd "$PROJECT_DIR"
    "$NODE" "$SCRIPT_DIR/crypto_killswitch.js" --status
    echo ""
    echo "📁 Логи: $LOG_DIR"
    echo "📋 Последний мониторинг:"
    tail -5 "$MONITOR_LOG" 2>/dev/null || echo "   (нет логов)"
    ;;

  install)
    echo "📝 Устанавливаю cron задачи для crypto-trader..."

    # Собираем crontab: сохраняем существующие + добавляем наши
    CRON_TAG="# openclaw-crypto-trader"
    EXISTING=$(crontab -l 2>/dev/null | grep -v "$CRON_TAG" | grep -v "crypto_cron.sh" || true)

    NEW_CRON=$(cat <<EOF
${EXISTING}
# --- OpenClaw Crypto Trader Auto-Trading --- ${CRON_TAG}
*/10 * * * * ${SCRIPT_DIR}/crypto_cron.sh monitor ${CRON_TAG}
10   * * * * ${SCRIPT_DIR}/crypto_cron.sh report  ${CRON_TAG}
EOF
)
    echo "$NEW_CRON" | crontab -
    echo "✅ Cron установлен:"
    echo "   */10 * * * *  monitor (каждые 10 минут)"
    echo "   10   * * * *  report  (каждый час в :10 UTC)"
    echo ""
    echo "Проверка: crontab -l"
    crontab -l | grep crypto_cron
    ;;

  uninstall)
    echo "🗑️ Удаляю cron задачи crypto-trader..."
    EXISTING=$(crontab -l 2>/dev/null | grep -v "openclaw-crypto-trader" | grep -v "crypto_cron.sh" || true)
    echo "$EXISTING" | crontab -
    echo "✅ Cron задачи удалены."
    ;;

  *)
    echo "Использование: $0 {monitor|report|status|install|uninstall}"
    exit 2
    ;;
esac
