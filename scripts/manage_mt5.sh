#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# MT5 Start/Stop — управление MetaTrader 5 на VPS
# ═══════════════════════════════════════════════════════════════
#
# Использование:
#   ./manage_mt5.sh start     — запустить MT5
#   ./manage_mt5.sh stop      — остановить MT5
#   ./manage_mt5.sh restart   — перезапустить
#   ./manage_mt5.sh status    — проверить статус
#   ./manage_mt5.sh vnc       — запустить VNC для визуального доступа
#   ./manage_mt5.sh kill-vnc  — остановить VNC
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

WINEPREFIX="${WINEPREFIX:-$HOME/.mt5}"
DISPLAY="${DISPLAY:-:99}"
MT5_DATA="$HOME/.openclaw/mt5_data"
export WINEPREFIX DISPLAY

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[MT5]${NC} $*"; }
warn() { echo -e "${YELLOW}[MT5]${NC} $*"; }
err() { echo -e "${RED}[MT5]${NC} $*"; }

find_mt5() {
    find "$WINEPREFIX/drive_c" -name "terminal64.exe" 2>/dev/null | head -1
}

start_xvfb() {
    if ! pgrep -a Xvfb | grep -q ":99" 2>/dev/null; then
        log "Запускаю Xvfb :99..."
        Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset &
        sleep 2
    fi
}

start_mt5() {
    MT5_PATH=$(find_mt5)
    if [[ -z "$MT5_PATH" ]]; then
        err "MT5 не найден! Запустите install_mt5.sh"
        exit 1
    fi

    if pgrep -f "terminal64.exe" > /dev/null 2>&1; then
        warn "MT5 уже запущен"
        return 0
    fi

    start_xvfb

    log "Запускаю MT5: $MT5_PATH"
    wine "$MT5_PATH" /portable > /var/log/mt5.log 2>&1 &
    MT5_PID=$!
    log "MT5 запущен (PID: $MT5_PID)"

    # Создаём директории для файлового моста
    mkdir -p "$MT5_DATA/orders" "$MT5_DATA/results"

    # Создаём симлинки из Wine MQL5/Files/ в ~/.openclaw/mt5_data/ (если MQL5 Files доступен)
    sleep 5
    local mt5_dir=$(dirname "$MT5_PATH")
    local mql5_files="${mt5_dir}/MQL5/Files"
    if [[ -d "$mql5_files" ]]; then
        # Симлинки из MQL5/Files в наш мост
        ln -sf "$MT5_DATA/orders" "$mql5_files/orders" 2>/dev/null || true
        ln -sf "$MT5_DATA/results" "$mql5_files/results" 2>/dev/null || true
        log "Симлинки созданы: MQL5/Files/ → ~/.openclaw/mt5_data/"
    fi

    log "✅ MT5 запущен. Лог: /var/log/mt5.log"
}

stop_mt5() {
    log "Останавливаю MT5..."
    pkill -f "terminal64.exe" 2>/dev/null || true
    wineserver -k 2>/dev/null || true
    sleep 2
    log "MT5 остановлен"
}

status_mt5() {
    echo "════════════════════════════════════════"
    echo " MT5 Status Report"
    echo "════════════════════════════════════════"

    # Xvfb
    if pgrep -a Xvfb | grep -q ":99" 2>/dev/null; then
        echo -e " Xvfb:    ${GREEN}✅ Running${NC}"
    else
        echo -e " Xvfb:    ${RED}❌ Stopped${NC}"
    fi

    # MT5
    if pgrep -f "terminal64.exe" > /dev/null 2>&1; then
        echo -e " MT5:     ${GREEN}✅ Running${NC}"
    else
        echo -e " MT5:     ${RED}❌ Stopped${NC}"
    fi

    # MT5 installed
    MT5_PATH=$(find_mt5)
    if [[ -n "$MT5_PATH" ]]; then
        echo -e " Installed: ${GREEN}✅ $MT5_PATH${NC}"
    else
        echo -e " Installed: ${RED}❌ Not found${NC}"
    fi

    # Data directory
    if [[ -d "$MT5_DATA" ]]; then
        echo -e " Data dir: ${GREEN}$MT5_DATA${NC}"
        echo "   Positions: $(wc -l < "$MT5_DATA/export_positions.csv" 2>/dev/null || echo 'N/A')"
        echo "   Account:   $(test -f "$MT5_DATA/export_account.csv" && echo 'OK' || echo 'N/A')"
        echo "   Orders:    $(ls "$MT5_DATA/orders/"*.json 2>/dev/null | wc -l || echo 0) pending"
    else
        echo -e " Data dir: ${RED}❌ Not found${NC}"
    fi

    echo "════════════════════════════════════════"
}

start_vnc() {
    if ! command -v x11vnc &> /dev/null; then
        log "Устанавливаю x11vnc..."
        apt-get install -y x11vnc > /dev/null 2>&1
    fi

    start_xvfb

    if pgrep -f "x11vnc.*:99" > /dev/null 2>&1; then
        warn "VNC уже запущен"
        return 0
    fi

    log "Запускаю VNC сервер на :99 (порт 5900)..."
    x11vnc -display :99 -passwd openclaw -forever -shared -bg -o /var/log/x11vnc.log
    log "✅ VNC запущен. Подключайтесь: vnc://VPS_IP:5900 (пароль: openclaw)"
}

kill_vnc() {
    pkill -f x11vnc 2>/dev/null || true
    log "VNC остановлен"
}

case "${1:-status}" in
    start)    start_mt5 ;;
    stop)     stop_mt5 ;;
    restart)  stop_mt5; sleep 2; start_mt5 ;;
    status)   status_mt5 ;;
    vnc)      start_vnc ;;
    kill-vnc) kill_vnc ;;
    *)
        echo "Использование: $0 {start|stop|restart|status|vnc|kill-vnc}"
        exit 1
        ;;
esac
