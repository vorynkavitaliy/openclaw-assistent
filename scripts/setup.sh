#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# Setup Script — Развертывание Multi-Agent AI Team на OpenClaw
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OPENCLAW_DIR="$HOME/.openclaw"

echo -e "${BLUE}🦞 OpenClaw Multi-Agent AI Team Setup${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ─── Проверка зависимостей ───────────────────────────────────
echo -e "${YELLOW}🔍 Проверка зависимостей...${NC}"

check_dep() {
  if command -v "$1" &> /dev/null; then
    echo -e "  ${GREEN}✅${NC} $1 найден: $(command -v "$1")"
    return 0
  else
    echo -e "  ${RED}❌${NC} $1 не найден"
    return 1
  fi
}

MISSING=0
check_dep "node" || MISSING=1
check_dep "npm" || MISSING=1
check_dep "jq" || MISSING=1
check_dep "curl" || MISSING=1

if [[ $MISSING -eq 1 ]]; then
  echo ""
  echo -e "${RED}Некоторые зависимости не найдены. Установите их и повторите.${NC}"
  echo "  node: https://nodejs.org/ (≥22)"
  echo "  jq:   brew install jq"
  echo "  curl: обычно предустановлен"
  exit 1
fi

# Проверка версии Node
NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [[ "$NODE_VERSION" -lt 22 ]]; then
  echo -e "${RED}❌ Node.js версия $NODE_VERSION, требуется ≥22${NC}"
  exit 1
fi
echo -e "  ${GREEN}✅${NC} Node.js v$NODE_VERSION (≥22 OK)"

# Проверка OpenClaw
if command -v openclaw &> /dev/null; then
  echo -e "  ${GREEN}✅${NC} OpenClaw установлен"
else
  echo -e "  ${YELLOW}⚠️${NC}  OpenClaw не найден. Устанавливаем..."
  npm install -g openclaw@latest
  echo -e "  ${GREEN}✅${NC} OpenClaw установлен"
fi

echo ""

# ─── Создание директорий ─────────────────────────────────────
echo -e "${YELLOW}📁 Создание директорий...${NC}"

AGENTS=("orchestrator" "forex-trader" "market-analyst" "crypto-trader" "tech-lead" "backend-dev" "frontend-dev" "qa-tester")

for agent in "${AGENTS[@]}"; do
  mkdir -p "$OPENCLAW_DIR/workspace-${agent}/skills"
  mkdir -p "$OPENCLAW_DIR/agents/${agent}/agent"
  mkdir -p "$OPENCLAW_DIR/agents/${agent}/sessions"
  echo -e "  ${GREEN}✅${NC} workspace-${agent}"
done

# Общая директория для skills
mkdir -p "$OPENCLAW_DIR/skills"

echo ""

# ─── Копирование workspace файлов ────────────────────────────
echo -e "${YELLOW}📝 Копирование workspace файлов...${NC}"

for agent in "${AGENTS[@]}"; do
  SRC_DIR="${PROJECT_DIR}/workspaces/${agent}"
  DST_DIR="${OPENCLAW_DIR}/workspace-${agent}"

  if [[ -d "$SRC_DIR" ]]; then
    cp -f "$SRC_DIR/SOUL.md" "$DST_DIR/SOUL.md" 2>/dev/null || true
    cp -f "$SRC_DIR/AGENTS.md" "$DST_DIR/AGENTS.md" 2>/dev/null || true
    cp -f "$SRC_DIR/TOOLS.md" "$DST_DIR/TOOLS.md" 2>/dev/null || true
    cp -f "$SRC_DIR/IDENTITY.md" "$DST_DIR/IDENTITY.md" 2>/dev/null || true
    # Копировать локальные skills если есть
    if [[ -d "$SRC_DIR/skills" ]]; then
      cp -rf "$SRC_DIR/skills/"* "$DST_DIR/skills/" 2>/dev/null || true
    fi
    echo -e "  ${GREEN}✅${NC} ${agent}: workspace файлы скопированы"
  else
    echo -e "  ${YELLOW}⚠️${NC}  ${agent}: workspace файлы не найдены в ${SRC_DIR}"
  fi
done

echo ""

# ─── Копирование shared skills ──────────────────────────────
echo -e "${YELLOW}🔧 Копирование shared skills...${NC}"

SKILLS=("taskboard" "forex-trading" "crypto-trading" "dev-tools" "mt5-python")

for skill in "${SKILLS[@]}"; do
  SRC_DIR="${PROJECT_DIR}/skills/${skill}"
  DST_DIR="${OPENCLAW_DIR}/skills/${skill}"

  if [[ -d "$SRC_DIR" ]]; then
    mkdir -p "$DST_DIR"
    cp -rf "$SRC_DIR/"* "$DST_DIR/"
    echo -e "  ${GREEN}✅${NC} ${skill}"
  else
    echo -e "  ${YELLOW}⚠️${NC}  ${skill}: skill не найден в ${SRC_DIR}"
  fi
done

# Сделать скрипты исполняемыми
find "$OPENCLAW_DIR/skills" -name "*.sh" -exec chmod +x {} \;

echo ""

# ─── Копирование конфигурации ────────────────────────────────
echo -e "${YELLOW}⚙️  Конфигурация...${NC}"

CONFIG_SRC="${PROJECT_DIR}/openclaw.json"
CONFIG_DST="${OPENCLAW_DIR}/openclaw.json"

if [[ -f "$CONFIG_DST" ]]; then
  echo -e "  ${YELLOW}⚠️${NC}  ${CONFIG_DST} уже существует"
  echo -e "  Бэкап: ${CONFIG_DST}.backup.$(date +%s)"
  cp "$CONFIG_DST" "${CONFIG_DST}.backup.$(date +%s)"
fi

if [[ -f "$CONFIG_SRC" ]]; then
  cp "$CONFIG_SRC" "$CONFIG_DST"
  chmod 600 "$CONFIG_DST"
  echo -e "  ${GREEN}✅${NC} Конфигурация скопирована (chmod 600)"
else
  echo -e "  ${RED}❌${NC} openclaw.json не найден в ${PROJECT_DIR}"
fi

echo ""

# ─── Напоминания ─────────────────────────────────────────────
echo -e "${BLUE}═══════════════════════════════════════════════${NC}"
echo -e "${GREEN}🎉 Setup завершён!${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════${NC}"
echo ""
echo -e "${YELLOW}📋 Следующие шаги:${NC}"
echo ""
echo "1. Отредактируйте ~/.openclaw/openclaw.json:"
echo "   - Замените YOUR_TELEGRAM_BOT_TOKEN_HERE на токен бота"
echo "   - Замените YOUR_TELEGRAM_USER_ID на ваш Telegram ID"
echo "   - Добавьте API ключи для торговли (если нужно)"
echo ""
echo "2. Создайте Telegram бота:"
echo "   - Откройте @BotFather в Telegram"
echo "   - /newbot → задайте имя и username"
echo "   - Скопируйте токен в openclaw.json"
echo ""
echo "3. Узнайте ваш Telegram ID:"
echo "   - Отправьте /start боту @userinfobot"
echo "   - Скопируйте ID в формате tg:XXXXXXXXX"
echo ""
echo "4. Запустите OpenClaw:"
echo "   openclaw onboard --install-daemon"
echo "   openclaw gateway --port 18789 --verbose"
echo ""
echo "5. Проверьте агентов:"
echo "   openclaw agents list --bindings"
echo ""
echo "6. Отправьте сообщение боту в Telegram!"
echo ""
echo -e "${BLUE}📖 Документация: https://docs.openclaw.ai/${NC}"
echo -e "${BLUE}📋 Архитектура: ${PROJECT_DIR}/ARCHITECTURE.md${NC}"
