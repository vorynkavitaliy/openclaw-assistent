#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# Task Board — CLI утилита для управления задачами
# Аналог Jira для команды AI-агентов
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="${SCRIPT_DIR}/../data"
TASKS_FILE="${DATA_DIR}/tasks.json"
COUNTER_FILE="${DATA_DIR}/counter.txt"

# ─── Инициализация ───────────────────────────────────────────
init_data() {
  mkdir -p "$DATA_DIR"
  if [[ ! -f "$TASKS_FILE" ]]; then
    echo '{"tasks":[]}' > "$TASKS_FILE"
  fi
  if [[ ! -f "$COUNTER_FILE" ]]; then
    echo "0" > "$COUNTER_FILE"
  fi
}

# ─── Следующий ID ────────────────────────────────────────────
next_id() {
  local counter
  counter=$(cat "$COUNTER_FILE")
  counter=$((counter + 1))
  echo "$counter" > "$COUNTER_FILE"
  printf "TASK-%03d" "$counter"
}

# ─── Текущее время ISO ───────────────────────────────────────
now_iso() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

# ─── Получить имя текущего агента ────────────────────────────
# Приоритет: 1) --agent   2) OPENCLAW_AGENT_ID   3) OPENCLAW_AGENT_DIR
#            4) CWD /workspaces/<id>   5) ancestor CWD   6) "unknown"
_GLOBAL_AGENT=""

get_agent_name() {
  # 1) Явный --agent
  if [[ -n "$_GLOBAL_AGENT" ]]; then
    echo "$_GLOBAL_AGENT"; return
  fi
  # 2) Env var (если OpenClaw когда-нибудь начнёт устанавливать)
  if [[ -n "${OPENCLAW_AGENT_ID:-}" ]]; then
    echo "$OPENCLAW_AGENT_ID"; return
  fi
  # 3) Парсинг OPENCLAW_AGENT_DIR: /root/.openclaw/agents/<id>/agent
  if [[ -n "${OPENCLAW_AGENT_DIR:-}" ]]; then
    local dir_name
    dir_name=$(basename "$(dirname "$OPENCLAW_AGENT_DIR")")
    if [[ "$dir_name" != "." && "$dir_name" != "/" ]]; then
      echo "$dir_name"; return
    fi
  fi
  # 4) Автодетекция из CWD — OpenClaw делает chdir в workspace агента
  if [[ "$PWD" =~ /workspaces/([^/]+) ]]; then
    echo "${BASH_REMATCH[1]}"; return
  fi
  # 5) Обход предков (до 5 уровней) — ищем workspace в CWD parent shell'ов
  local pid=$$
  local depth=0
  while [[ $depth -lt 5 ]]; do
    pid=$(awk '/^PPid:/{print $2}' "/proc/$pid/status" 2>/dev/null) || break
    [[ -z "$pid" || "$pid" == "0" || "$pid" == "1" ]] && break
    local ancestor_cwd
    ancestor_cwd=$(readlink -f "/proc/$pid/cwd" 2>/dev/null) || break
    if [[ "$ancestor_cwd" =~ /workspaces/([^/]+) ]]; then
      echo "${BASH_REMATCH[1]}"; return
    fi
    depth=$((depth + 1))
  done
  echo "unknown"
}

# ─── CREATE ──────────────────────────────────────────────────
cmd_create() {
  local title="" description="" type="task" assignee="" priority="medium" labels="" parent=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --title) title="$2"; shift 2 ;;
      --description) description="$2"; shift 2 ;;
      --type) type="$2"; shift 2 ;;
      --assignee) assignee="$2"; shift 2 ;;
      --priority) priority="$2"; shift 2 ;;
      --labels) labels="$2"; shift 2 ;;
      --parent) parent="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  if [[ -z "$title" ]]; then
    echo "Error: --title is required"
    exit 1
  fi

  local id
  id=$(next_id)
  local now
  now=$(now_iso)
  local agent
  agent=$(get_agent_name)

  # Конвертировать labels в JSON array
  local labels_json="[]"
  if [[ -n "$labels" ]]; then
    labels_json=$(echo "$labels" | tr ',' '\n' | jq -R . | jq -s .)
  fi

  # Создать задачу
  local task
  task=$(jq -n \
    --arg id "$id" \
    --arg title "$title" \
    --arg description "$description" \
    --arg type "$type" \
    --arg status "todo" \
    --arg assignee "$assignee" \
    --arg reporter "$agent" \
    --arg priority "$priority" \
    --argjson labels "$labels_json" \
    --arg parent "$parent" \
    --arg created_at "$now" \
    --arg updated_at "$now" \
    '{
      id: $id,
      title: $title,
      description: $description,
      type: $type,
      status: $status,
      assignee: $assignee,
      reporter: $reporter,
      priority: $priority,
      labels: $labels,
      parent: $parent,
      subtasks: [],
      comments: [],
      history: [{
        timestamp: $created_at,
        agent: $reporter,
        action: "created"
      }],
      created_at: $created_at,
      updated_at: $updated_at
    }')

  # Добавить в файл
  local tmp
  tmp=$(mktemp)
  jq --argjson task "$task" '.tasks += [$task]' "$TASKS_FILE" > "$tmp"
  mv "$tmp" "$TASKS_FILE"

  # Если есть parent — добавить в subtasks
  if [[ -n "$parent" ]]; then
    tmp=$(mktemp)
    jq --arg parent "$parent" --arg id "$id" \
      '(.tasks[] | select(.id == $parent) | .subtasks) += [$id]' \
      "$TASKS_FILE" > "$tmp"
    mv "$tmp" "$TASKS_FILE"
  fi

  echo "✅ Задача создана: $id"
  echo "$task" | jq '.'
}

# ─── LIST ────────────────────────────────────────────────────
cmd_list() {
  local assignee="" status="" priority="" type=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --assignee) assignee="$2"; shift 2 ;;
      --status) status="$2"; shift 2 ;;
      --priority) priority="$2"; shift 2 ;;
      --type) type="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  local filter=".tasks"

  if [[ -n "$assignee" ]]; then
    filter="$filter | map(select(.assignee == \"$assignee\"))"
  fi
  if [[ -n "$status" ]]; then
    filter="$filter | map(select(.status == \"$status\"))"
  fi
  if [[ -n "$priority" ]]; then
    filter="$filter | map(select(.priority == \"$priority\"))"
  fi
  if [[ -n "$type" ]]; then
    filter="$filter | map(select(.type == \"$type\"))"
  fi

  local result
  result=$(jq "$filter" "$TASKS_FILE")

  local count
  count=$(echo "$result" | jq 'length')

  echo "📋 Задачи ($count):"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  echo "$result" | jq -r '.[] | "[\(.id)] [\(.status | ascii_upcase)] [\(.priority)] \(.title) → \(.assignee)"'
}

# ─── GET ─────────────────────────────────────────────────────
cmd_get() {
  local id="${1:-}"

  if [[ -z "$id" ]]; then
    echo "Error: task ID required"
    exit 1
  fi

  local task
  task=$(jq --arg id "$id" '.tasks[] | select(.id == $id)' "$TASKS_FILE")

  if [[ -z "$task" || "$task" == "null" ]]; then
    echo "❌ Задача $id не найдена"
    exit 1
  fi

  echo "$task" | jq '.'
}

# ─── UPDATE ──────────────────────────────────────────────────
cmd_update() {
  local id="${1:-}"
  shift || true

  if [[ -z "$id" ]]; then
    echo "Error: task ID required"
    exit 1
  fi

  local now
  now=$(now_iso)
  local agent
  agent=$(get_agent_name)

  local tmp
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --status)
        local old_status new_status="$2"
        old_status=$(jq -r --arg id "$id" '.tasks[] | select(.id == $id) | .status' "$TASKS_FILE")
        local task_title
        task_title=$(jq -r --arg id "$id" '.tasks[] | select(.id == $id) | .title' "$TASKS_FILE")
        tmp=$(mktemp)
        jq --arg id "$id" --arg val "$new_status" --arg now "$now" --arg agent "$agent" --arg old "$old_status" \
          '(.tasks[] | select(.id == $id)) |= (
            .status = $val |
            .updated_at = $now |
            .history += [{timestamp: $now, agent: $agent, action: "status_changed", from: $old, to: $val}]
          )' "$TASKS_FILE" > "$tmp"
        mv "$tmp" "$TASKS_FILE"
        # Уведомление для orchestrator
        emit_notification "$id" "$old_status" "$new_status" "$agent" "$task_title"
        echo "✅ Статус $id: $old_status → $new_status"
        shift 2
        ;;
      --priority)
        tmp=$(mktemp)
        jq --arg id "$id" --arg val "$2" --arg now "$now" --arg agent "$agent" \
          '(.tasks[] | select(.id == $id)) |= (
            .priority = $val |
            .updated_at = $now |
            .history += [{timestamp: $now, agent: $agent, action: "priority_changed", to: $val}]
          )' "$TASKS_FILE" > "$tmp"
        mv "$tmp" "$TASKS_FILE"
        echo "✅ Приоритет $id: $2"
        shift 2
        ;;
      --assignee)
        tmp=$(mktemp)
        jq --arg id "$id" --arg val "$2" --arg now "$now" --arg agent "$agent" \
          '(.tasks[] | select(.id == $id)) |= (
            .assignee = $val |
            .updated_at = $now |
            .history += [{timestamp: $now, agent: $agent, action: "reassigned", to: $val}]
          )' "$TASKS_FILE" > "$tmp"
        mv "$tmp" "$TASKS_FILE"
        echo "✅ Assignee $id: $2"
        shift 2
        ;;
      --title)
        tmp=$(mktemp)
        jq --arg id "$id" --arg val "$2" --arg now "$now" \
          '(.tasks[] | select(.id == $id)) |= (.title = $val | .updated_at = $now)' \
          "$TASKS_FILE" > "$tmp"
        mv "$tmp" "$TASKS_FILE"
        shift 2
        ;;
      --description)
        tmp=$(mktemp)
        jq --arg id "$id" --arg val "$2" --arg now "$now" \
          '(.tasks[] | select(.id == $id)) |= (.description = $val | .updated_at = $now)' \
          "$TASKS_FILE" > "$tmp"
        mv "$tmp" "$TASKS_FILE"
        shift 2
        ;;
      *) shift ;;
    esac
  done
}

# ─── COMMENT ─────────────────────────────────────────────────
cmd_comment() {
  local id="${1:-}"
  local text="${2:-}"

  if [[ -z "$id" || -z "$text" ]]; then
    echo "Error: task ID and comment text required"
    echo "Usage: taskboard.sh comment TASK-001 \"Comment text\""
    exit 1
  fi

  local now
  now=$(now_iso)
  local agent
  agent=$(get_agent_name)

  local tmp
  tmp=$(mktemp)
  jq --arg id "$id" --arg text "$text" --arg now "$now" --arg agent "$agent" \
    '(.tasks[] | select(.id == $id)) |= (
      .comments += [{author: $agent, timestamp: $now, text: $text}] |
      .updated_at = $now
    )' "$TASKS_FILE" > "$tmp"
  mv "$tmp" "$TASKS_FILE"

  echo "💬 Комментарий добавлен к $id"
}

# ─── STATS ───────────────────────────────────────────────────
cmd_stats() {
  echo "📊 Статистика Task Board"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  local total backlog todo in_progress review testing done
  total=$(jq '.tasks | length' "$TASKS_FILE")
  backlog=$(jq '[.tasks[] | select(.status == "backlog")] | length' "$TASKS_FILE")
  todo=$(jq '[.tasks[] | select(.status == "todo")] | length' "$TASKS_FILE")
  in_progress=$(jq '[.tasks[] | select(.status == "in_progress")] | length' "$TASKS_FILE")
  review=$(jq '[.tasks[] | select(.status == "review")] | length' "$TASKS_FILE")
  testing=$(jq '[.tasks[] | select(.status == "testing")] | length' "$TASKS_FILE")
  done=$(jq '[.tasks[] | select(.status == "done")] | length' "$TASKS_FILE")

  echo "📌 Всего задач: $total"
  echo "📥 Backlog:     $backlog"
  echo "📋 Todo:        $todo"
  echo "🔄 In Progress: $in_progress"
  echo "👀 Review:      $review"
  echo "🧪 Testing:     $testing"
  echo "✅ Done:        $done"
  echo ""

  echo "👤 По агентам:"
  jq -r '.tasks | group_by(.assignee) | .[] | "   \(.[0].assignee): \(length) задач"' "$TASKS_FILE"
  echo ""

  echo "🔴 По приоритетам:"
  jq -r '.tasks | group_by(.priority) | .[] | "   \(.[0].priority): \(length)"' "$TASKS_FILE"
}

# ─── DELETE ──────────────────────────────────────────────────
cmd_delete() {
  local id="${1:-}"

  if [[ -z "$id" ]]; then
    echo "Error: task ID required"
    exit 1
  fi

  local tmp
  tmp=$(mktemp)
  jq --arg id "$id" '.tasks |= map(select(.id != $id))' "$TASKS_FILE" > "$tmp"
  mv "$tmp" "$TASKS_FILE"

  echo "🗑️ Задача $id удалена"
}

# ─── NOTIFICATIONS ───────────────────────────────────────────
# Показать последние изменения статусов (для orchestrator heartbeat)
NOTIFICATIONS_FILE="${DATA_DIR}/notifications.json"

init_notifications() {
  if [[ ! -f "$NOTIFICATIONS_FILE" ]]; then
    echo '{"events":[]}' > "$NOTIFICATIONS_FILE"
  fi
}

# Записать уведомление о смене статуса
emit_notification() {
  local task_id="$1" from_status="$2" to_status="$3" agent="$4" title="$5"
  local now
  now=$(now_iso)

  init_notifications

  local tmp
  tmp=$(mktemp)
  jq --arg id "$task_id" --arg from "$from_status" --arg to "$to_status" \
     --arg agent "$agent" --arg title "$title" --arg ts "$now" \
    '.events += [{
      task_id: $id,
      title: $title,
      from: $from,
      to: $to,
      agent: $agent,
      timestamp: $ts,
      seen: false
    }]' "$NOTIFICATIONS_FILE" > "$tmp"
  mv "$tmp" "$NOTIFICATIONS_FILE"
}

cmd_notifications() {
  init_notifications

  local unseen_only=false ack=false limit=20

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --unseen) unseen_only=true; shift ;;
      --ack) ack=true; shift ;;
      --limit) limit="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  if [[ "$ack" == true ]]; then
    local tmp
    tmp=$(mktemp)
    jq '.events |= map(.seen = true)' "$NOTIFICATIONS_FILE" > "$tmp"
    mv "$tmp" "$NOTIFICATIONS_FILE"
    echo "✅ Все уведомления отмечены как прочитанные"
    return
  fi

  local filter=".events"
  if [[ "$unseen_only" == true ]]; then
    filter=".events | map(select(.seen == false))"
  fi
  filter="$filter | sort_by(.timestamp) | reverse | .[:$limit]"

  local result
  result=$(jq "$filter" "$NOTIFICATIONS_FILE")
  local count
  count=$(echo "$result" | jq 'length')

  if [[ "$count" -eq 0 ]]; then
    echo "📭 Нет новых уведомлений"
    return
  fi

  echo "🔔 Уведомления ($count):"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "$result" | jq -r '.[] | "[\(.timestamp)] \(.task_id): \(.from) → \(.to) (\(.agent)) — \(.title)"'
}

# ─── MAIN ────────────────────────────────────────────────────
init_data

# Парсинг глобальных опций (до команды)
while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent) _GLOBAL_AGENT="$2"; shift 2 ;;
    *) break ;;
  esac
done

command="${1:-help}"
shift || true

case "$command" in
  create)        cmd_create "$@" ;;
  list)          cmd_list "$@" ;;
  get)           cmd_get "$@" ;;
  update)        cmd_update "$@" ;;
  comment)       cmd_comment "$@" ;;
  stats)         cmd_stats ;;
  delete)        cmd_delete "$@" ;;
  notifications) cmd_notifications "$@" ;;
  help|*)
    echo "📋 Task Board — Управление задачами"
    echo ""
    echo "Глобальные опции (перед командой):"
    echo "  --agent agent-id    Указать ID агента (рекомендуется)"
    echo ""
    echo "Команды:"
    echo "  create        --title '...' --assignee agent-id [--description '...'] [--type task] [--priority medium] [--labels 'a,b'] [--parent TASK-001]"
    echo "  list          [--assignee agent-id] [--status todo] [--priority high] [--type bug]"
    echo "  get           TASK-001"
    echo "  update        TASK-001 --status in_progress [--priority high] [--assignee agent-id]"
    echo "  comment       TASK-001 'Комментарий'"
    echo "  notifications [--unseen] [--ack] [--limit N]"
    echo "  stats"
    echo "  delete        TASK-001"
    echo ""
    echo "Пример: bash taskboard.sh --agent crypto-trader create --title 'BTC LONG' --assignee orchestrator"
    ;;
esac
