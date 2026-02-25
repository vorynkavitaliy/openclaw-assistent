#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# MT5 Install Script — установка MetaTrader 5 в Wine на Ubuntu
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

WINEPREFIX="${WINEPREFIX:-$HOME/.mt5}"
DISPLAY="${DISPLAY:-:99}"
export WINEPREFIX DISPLAY

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[MT5]${NC} $*"; }
warn() { echo -e "${YELLOW}[MT5]${NC} $*"; }
err() { echo -e "${RED}[MT5]${NC} $*"; }

# ─── Шаг 0: Убить все предыдущие Wine процессы ──────────────
log "Убиваю старые Wine процессы..."
pkill -9 wine 2>/dev/null || true
pkill -9 wineserver 2>/dev/null || true
sleep 2

# ─── Шаг 1: Xvfb ────────────────────────────────────────────
if ! pgrep -a Xvfb | grep -q ":99" 2>/dev/null; then
    log "Запускаю Xvfb :99..."
    Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset &
    sleep 2
    log "Xvfb запущен (PID: $!)"
else
    log "Xvfb :99 уже работает"
fi

# ─── Шаг 2: Создание Wine prefix ────────────────────────────
if [[ ! -d "$WINEPREFIX/drive_c" ]]; then
    log "Создаю Wine prefix: $WINEPREFIX"
    rm -rf "$WINEPREFIX"
    WINEDLLOVERRIDES="mshtml=" wineboot --init 2>/dev/null
    wineserver -w
    log "Wine prefix создан"
else
    log "Wine prefix существует: $WINEPREFIX"
fi

# ─── Шаг 3: Windows 10 mode ─────────────────────────────────
log "Устанавливаю режим Windows 10..."
winecfg -v win10 2>/dev/null
wineserver -w
log "Windows 10 mode установлен"

# ─── Шаг 4: Скачиваем MT5 installer ─────────────────────────
MT5_INSTALLER="/tmp/mt5setup.exe"
if [[ ! -f "$MT5_INSTALLER" ]]; then
    log "Скачиваю MT5 installer..."
    wget -q "https://download.mql5.com/cdn/web/metaquotes.software.corp/mt5/mt5setup.exe" -O "$MT5_INSTALLER"
fi
log "MT5 installer: $(ls -lh $MT5_INSTALLER | awk '{print $5}')"

# ─── Шаг 5: Запуск установки ────────────────────────────────
log "Запускаю MT5 installer..."
log "Это может занять 1-3 минуты (загрузка файлов)..."

# Запускаем в виртуальном рабочем столе Wine
wine explorer /desktop=MT5Setup,1024x768 "$MT5_INSTALLER" &
INSTALLER_PID=$!
log "Installer PID: $INSTALLER_PID"

# ─── Шаг 6: Ждём и автоматизируем ───────────────────────────
# MT5 installer показывает окно с лицензией и кнопкой "Next"
# Автоматизируем клик через xdotool

sleep 10
log "Пытаюсь нажать Enter / Tab+Enter для прохождения installer..."

for attempt in $(seq 1 30); do
    # Отправляем Enter чтобы нажать "Next" / "Accept"
    xdotool key --delay 100 Tab Return 2>/dev/null || true
    sleep 5

    # Проверяем установился ли MT5
    if find "$WINEPREFIX/drive_c" -name "terminal64.exe" 2>/dev/null | grep -q .; then
        MT5_PATH=$(find "$WINEPREFIX/drive_c" -name "terminal64.exe" 2>/dev/null | head -1)
        log "✅ MT5 УСТАНОВЛЕН УСПЕШНО!"
        log "Путь: $MT5_PATH"
        break
    fi

    SIZE=$(du -sh "$WINEPREFIX/drive_c/" 2>/dev/null | cut -f1)
    warn "Попытка $attempt/30 — drive_c: $SIZE"
done

# ─── Шаг 7: Проверка ────────────────────────────────────────
wineserver -w 2>/dev/null || true

if find "$WINEPREFIX/drive_c" -name "terminal64.exe" 2>/dev/null | grep -q .; then
    MT5_PATH=$(find "$WINEPREFIX/drive_c" -name "terminal64.exe" 2>/dev/null | head -1)
    log "═══════════════════════════════════════════"
    log "✅ MT5 установлен: $MT5_PATH"
    log "Run: WINEPREFIX=$WINEPREFIX DISPLAY=$DISPLAY wine \"$MT5_PATH\" /portable"
    log "═══════════════════════════════════════════"

    # Создаём директорию для данных OpenClaw
    mkdir -p "$HOME/.openclaw/mt5_data/orders"
    mkdir -p "$HOME/.openclaw/mt5_data/results"
    log "Директории данных созданы: ~/.openclaw/mt5_data/"
else
    err "═══════════════════════════════════════════"
    err "❌ MT5 НЕ установлен. Возможные причины:"
    err "  1. Wine не поддерживает mt5setup.exe (версия: $(wine --version))"
    err "  2. Installer крашится на NtRaiseHardError"
    err "  3. Сетевые проблемы (installer скачивает файлы)"
    err ""
    err "Решение: установи MT5 вручную через RDP/VNC:"
    err "  1. Установи x11vnc: apt install x11vnc"
    err "  2. Запусти: x11vnc -display :99 -passwd openclaw -forever &"
    err "  3. Подключись VNC-клиентом к VPS_IP:5900"
    err "  4. В открывшемся окне пройди установку MT5"
    err "═══════════════════════════════════════════"
    exit 1
fi
