#!/usr/bin/env python3
"""Fix OpenClaw config validation errors."""
import sys

filepath = sys.argv[1]

with open(filepath, 'r') as f:
    content = f.read()

# Fix 1: agents.defaults.model: string -> object { primary: "..." }
content = content.replace(
    '"model": "openai/gpt-5.2",\n      // Sandbox',
    '"model": { "primary": "openai/gpt-5.2" },\n      // Sandbox',
    1  # only first occurrence (in defaults)
)

# Fix 2: agents.defaults.subagents: remove allowAgents
content = content.replace(
    '"allowAgents": ["*"],\n        "archiveAfterMinutes"',
    '"archiveAfterMinutes"'
)

# Fix 3: tools.subagents.tools: array -> object with allow
old = '''"subagents": {
      "tools": [
        "exec",
        "read",
        "write",
        "edit",
        "apply_patch",
        "browser",
        "sessions_list",
        "sessions_history",
        "sessions_send"
      ]
    }'''

new = '''"subagents": {
      "tools": {
        "allow": [
          "exec",
          "read",
          "write",
          "edit",
          "apply_patch",
          "browser",
          "sessions_list",
          "sessions_history",
          "sessions_send"
        ]
      }
    }'''

content = content.replace(old, new)

with open(filepath, 'w') as f:
    f.write(content)

print(f"✅ Fixed: {filepath}")
