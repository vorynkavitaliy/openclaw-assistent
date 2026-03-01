# TOOLS.md — QA Tester Environment

## Tools

### Testing

- Playwright (E2E tests)
- Jest / Vitest (unit tests)
- pytest (Python tests)

### Browser

- **browser** tool — visual UI verification
- Screenshots: /tmp/openclaw/qa_screenshots/

### Reports

- Bug reports via **taskboard**
- Test results via **Task Board** (task update + comment)

### URLs for Testing

- OpenClaw Gateway: http://127.0.0.1:18789
- `[configure target app URL]`

## Communication

- Receives tasks from **tech-lead** and **orchestrator** via **sessions_send** + **Task Board**
- Creates bug reports on **Task Board** + sends via **sessions_send**
- Reports via **sessions_send** + **Task Board** update
