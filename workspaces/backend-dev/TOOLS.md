# TOOLS.md — Backend Dev Environment

## Tools

### Runtime

- Node.js >= 20
- Python 3.10+
- npm / pnpm

### Databases

- SQLite (OpenClaw memory)
- `[configure PostgreSQL/MySQL if used]`

### API

- OpenClaw Gateway: http://127.0.0.1:18789
- `[configure external APIs if needed]`

### Testing

- Jest / Vitest
- pytest (for Python)

## Communication

- Receives tasks from **tech-lead** via **sessions_send** (instant) + **Task Board** (tracking)
- Reports via **sessions_send** + **Task Board** update
