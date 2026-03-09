---
name: deploy
description: "Сборка, проверка, коммит, пуш и перезапуск проекта. Полный деплой pipeline. Запуск: /deploy"
user-invocable: true
allowed-tools: Bash(npm run build) Bash(npm run lint) Bash(git *) Bash(pm2 *) Bash(crontab -l) Read
---

# Deploy Pipeline

Выполни полный цикл деплоя по шагам. Остановись при ошибке.

## Шаги

### 1. Проверка качества
```bash
npm run lint
npm run build
```
Если ошибки — покажи и останови деплой.

### 2. Git статус
```bash
git status
git diff --stat
```
Покажи что изменилось. Если нет изменений — пропусти коммит.

### 3. Коммит и пуш
- Составь осмысленное сообщение коммита на основе diff
- Формат: `feat(crypto):`, `fix(forex):`, `refactor(shared):` и т.д.
- Добавь Co-Authored-By
```bash
git add <файлы>
git commit -m "сообщение

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
git push
```

### 4. Перезапуск сервисов
```bash
pm2 restart openclaw-bot
pm2 status
```

### 5. Проверка cron
```bash
crontab -l | grep -E "crypto|forex|openclaw"
```

### 6. Верификация
Подожди 10 секунд, проверь что бот жив:
```bash
pm2 logs openclaw-bot --lines 5 --nostream
```

## Формат результата

```
## Deploy [ДАТА]

- Lint: OK
- Build: OK
- Commit: <hash> <message>
- Push: OK
- PM2: openclaw-bot restarted (pid XXXX)
- Cron: crypto-monitor */5, sl-guard */1, report */60

Итог: DEPLOYED
```
