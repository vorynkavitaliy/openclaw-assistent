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
get_agent_name() {
  echo "${OPENCLAW_AGENT_ID:-unknown}"
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
        tmp=$(mktemp)
        jq --arg id "$id" --arg val "$new_status" --arg now "$now" --arg agent "$agent" --arg old "$old_status" \
          '(.tasks[] | select(.id == $id)) |= (
            .status = $val |
            .updated_at = $now |
            .history += [{timestamp: $now, agent: $agent, action: "status_changed", from: $old, to: $val}]
          )' "$TASKS_FILE" > "$tmp"
        mv "$tmp" "$TASKS_FILE"
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

# ─── MAIN ────────────────────────────────────────────────────
init_data

command="${1:-help}"
shift || true

case "$command" in
  create)   cmd_create "$@" ;;
  list)     cmd_list "$@" ;;
  get)      cmd_get "$@" ;;
  update)   cmd_update "$@" ;;
  comment)  cmd_comment "$@" ;;
  stats)    cmd_stats ;;
  delete)   cmd_delete "$@" ;;
  help|*)
    echo "📋 Task Board — Управление задачами"
    echo ""
    echo "Команды:"
    echo "  create   --title '...' --assignee agent-id [--description '...'] [--type task] [--priority medium] [--labels 'a,b'] [--parent TASK-001]"
    echo "  list     [--assignee agent-id] [--status todo] [--priority high] [--type bug]"
    echo "  get      TASK-001"
    echo "  update   TASK-001 --status in_progress [--priority high] [--assignee agent-id]"
    echo "  comment  TASK-001 'Комментарий'"
    echo "  stats"
    echo "  delete   TASK-001"
    ;;
esac
