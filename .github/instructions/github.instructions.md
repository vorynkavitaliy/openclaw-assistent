---
applyTo: '.github/**'
---

При работе с GitHub конфигурацией:

- `.github/copilot-instructions.md` — repository-wide инструкции для Copilot (max ~4000 символов для code review)
- `.github/instructions/*.instructions.md` — path-specific инструкции с `applyTo` frontmatter (glob паттерны через запятую); поле `excludeAgent: "code-review"` или `"coding-agent"` — исключить из конкретного агента
- `.github/agents/*.agent.md` — кастомные агенты Copilot; обязательный frontmatter: `description` (required!), `name`, `tools`, `model`; тело до 30 000 символов
- `.github/prompts/*.prompt.md` — переиспользуемые промпты через `/` в чате; frontmatter: `name`, `description`, `agent`, `tools`, `argument-hint`; переменные: `${input:name:placeholder}`, `${file}`, `${selection}`
- `.github/docs/` — полная документация проекта (rules, skills, protocols, architecture)
- `.github/ISSUE_TEMPLATE/` — шаблоны issues (YAML form format)
- `.github/workflows/` — GitHub Actions (security-scan, docs-check, health-check)
- CODEOWNERS — НЕ форматировать markdown-форматтером, это специальный формат GitHub
- Все ссылки в документации — относительные от текущей позиции файла
