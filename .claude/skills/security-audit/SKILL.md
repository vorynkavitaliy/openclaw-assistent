---
name: security-audit
description: "Аудит безопасности: проверка утечек credentials, API ключей, хардкоженных секретов в коде. Используй периодически или перед деплоем. Запуск: /security-audit"
user-invocable: true
allowed-tools: Bash(grep *) Bash(git *) Read Glob Grep
---

# Аудит безопасности

Проверь проект на утечки секретов и нарушения безопасности.

## Шаги

1. **Хардкоженные API ключи**
```bash
grep -rn 'apiKey\s*=\s*"' src/
grep -rn 'apiSecret\s*=\s*"' src/
grep -rn 'password\s*=\s*"' src/
grep -rn 'token\s*=\s*"' src/
```

2. **Подозрительные строки в коммитах**
```bash
git log --all -p --diff-filter=A -- '*.ts' '*.json' | grep -iE '(api.?key|secret|password|token)\s*[:=]' | head -20
```

3. **Файлы в .gitignore**
Проверить что `.env`, `keys.md`, `credentials.json` в .gitignore:
```bash
cat .gitignore | grep -E '(\.env|keys|credentials|secret)'
```

4. **Конфигурация Telegram**
Проверить что bot token не в коде:
```bash
grep -rn 'bot.*token' src/ --include='*.ts'
```

5. **Зависимости**
```bash
npm audit 2>/dev/null || echo "npm audit не доступен"
```

## Формат результата

```
## Аудит безопасности [ДАТА]

- Хардкоженные ключи: OK / НАЙДЕНО X
- Секреты в истории git: OK / НАЙДЕНО X
- .gitignore: OK / ТРЕБУЕТ ОБНОВЛЕНИЯ
- Telegram token: OK / УТЕЧКА
- npm audit: OK / X уязвимостей

Итог: БЕЗОПАСНО / ТРЕБУЕТ ВНИМАНИЯ
```
