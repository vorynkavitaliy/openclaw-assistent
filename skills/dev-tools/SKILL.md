---
name: dev-tools
description: 'Development tools for code generation, git operations, project scaffolding, testing, and deployment automation.'
metadata: { 'openclaw': { 'emoji': '🛠️', 'requires': { 'anyBins': ['node', 'npm', 'git'] } } }
user-invocable: true
---

# Development Tools Skill

Инструменты для разработки, используемые агентами-разработчиками.

## Git операции

### Создание feature branch

```bash
cd /path/to/project
git checkout -b feature/TASK-XXX-description
```

### Коммит с conventional commits

```bash
git add .
git commit -m "feat(module): brief description

TASK-XXX: detailed description of changes"
```

### Создание Pull Request

```bash
git push origin feature/TASK-XXX-description
# Через GitHub CLI (если установлен):
gh pr create --title "feat: description" --body "Closes TASK-XXX"
```

## Scaffolding проектов

### Backend (Node.js + TypeScript)

```bash
mkdir -p /path/to/project && cd /path/to/project
npm init -y
npm install typescript express @types/express @types/node
npx tsc --init --target ES2022 --module NodeNext --moduleResolution NodeNext --outDir dist --strict
mkdir -p src
```

### Frontend (Next.js)

```bash
npx create-next-app@latest /path/to/project --typescript --tailwind --app --src-dir
```

### Frontend (Vite + React)

```bash
npm create vite@latest /path/to/project -- --template react-ts
```

## Запуск тестов

### Jest / Vitest

```bash
npx vitest run
npx vitest run --coverage
```

### Playwright (E2E)

```bash
npx playwright test
npx playwright test --headed
npx playwright show-report
```

## Docker

### Сборка

```bash
docker build -t app-name .
docker-compose up -d
docker-compose logs -f
```

### Шаблон Dockerfile (Node.js)

Создай файл Dockerfile:

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist/ ./dist/
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

## Линтинг и форматирование

### ESLint + Prettier

```bash
npx eslint src/ --fix
npx prettier --write "src/**/*.{ts,tsx}"
```

### Biome (альтернатива)

```bash
npx @biomejs/biome check --write src/
```

## Мониторинг и дебаг

```bash
# Логи приложения
tail -f /path/to/app.log

# Проверка портов
lsof -i :3000

# Проверка процессов
ps aux | grep node

# Использование ресурсов
top -l 1 | head -20
```

## Обновление Task Board после работы

```bash
bash ~/.openclaw/skills/taskboard/scripts/taskboard.sh update TASK-XXX --status review
bash ~/.openclaw/skills/taskboard/scripts/taskboard.sh comment TASK-XXX "Реализовано: [описание]. Тесты пройдены. PR создан."
```
