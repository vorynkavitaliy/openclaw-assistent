#!/bin/bash
# protect-files.sh — блокирует редактирование чувствительных файлов

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

PROTECTED_PATTERNS=(".env" "keys.md" "credentials.json" "openclaw.json" ".git/")

for pattern in "${PROTECTED_PATTERNS[@]}"; do
  if [[ "$FILE_PATH" == *"$pattern"* ]]; then
    echo "Заблокировано: $FILE_PATH содержит защищённый паттерн '$pattern'. Этот файл нельзя редактировать через Claude Code." >&2
    exit 2
  fi
done

exit 0
