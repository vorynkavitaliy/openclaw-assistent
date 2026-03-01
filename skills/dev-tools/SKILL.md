```skill
---
name: dev-tools
description: 'Development tools for code generation, git operations, project scaffolding, testing, and deployment automation.'
metadata: { 'openclaw': { 'emoji': '🛠️', 'requires': { 'anyBins': ['node', 'npm', 'git'] } } }
user-invocable: true
---

# Development Tools Skill

Tools used by developer agents.

## Git Operations

### Creating a feature branch

```bash
cd /path/to/project
git checkout -b feature/TASK-XXX-description
```

### Commit with conventional commits

```bash
git add .
git commit -m "feat(module): brief description

TASK-XXX: detailed description of changes"
```

### Creating a Pull Request

```bash
git push origin feature/TASK-XXX-description
# Via GitHub CLI (if installed):
gh pr create --title "feat: description" --body "Closes TASK-XXX"
```

## Project Scaffolding

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

## Running Tests

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

### Build

```bash
docker build -t app-name .
docker-compose up -d
docker-compose logs -f
```

### Dockerfile Template (Node.js)

Create a Dockerfile:

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist/ ./dist/
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

## Linting and Formatting

### ESLint + Prettier

```bash
npx eslint src/ --fix
npx prettier --write "src/**/*.{ts,tsx}"
```

### Biome (alternative)

```bash
npx @biomejs/biome check --write src/
```

## Monitoring and Debugging

```bash
# Application logs
tail -f /path/to/app.log

# Check ports
lsof -i :3000

# Check processes
ps aux | grep node

# Resource usage
top -l 1 | head -20
```

## Updating Task Board After Work

```bash
bash ~/.openclaw/skills/taskboard/scripts/taskboard.sh update TASK-XXX --status review
bash ~/.openclaw/skills/taskboard/scripts/taskboard.sh comment TASK-XXX "Implemented: [description]. Tests passed. PR created."
```
