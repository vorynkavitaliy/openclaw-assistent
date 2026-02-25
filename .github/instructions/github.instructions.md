---
applyTo: '.github/**'
---

При работе с GitHub конфигурацией:

- `.github/copilot-instructions.md` — repository-wide инструкции для Copilot (max 2 страницы)
- `.github/instructions/*.instructions.md` — path-specific инструкции с `applyTo` frontmatter
- `.github/docs/` — полная документация проекта (rules, skills, protocols, architecture)
- `.github/agents/` — профили агентов для Copilot и разработчиков
- `.github/ISSUE_TEMPLATE/` — шаблоны issues (YAML form format)
- `.github/workflows/` — GitHub Actions (security-scan, docs-check, health-check)
- CODEOWNERS — НЕ форматировать markdown-форматтером, это специальный формат GitHub
- Все ссылки в документации — относительные от текущей позиции файла
