---
applyTo: '**/*.ts,**/*.js,**/*.tsx,**/*.jsx'
---

При работе с кодом проекта OpenClaw:

- Runtime: Node.js ≥ 20.19, TypeScript
- Стиль: ESLint + Prettier
- Коммиты: Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`)
- Обработка ошибок — обязательна, с proper logging
- НИКОГДА не хардкодить credentials — использовать env vars или `~/.openclaw/openclaw.json`
- Тесты: Jest/Vitest для unit, Playwright для E2E
- Backend: Express/Fastify, PostgreSQL/MongoDB
- Frontend: React/Next.js, TailwindCSS
