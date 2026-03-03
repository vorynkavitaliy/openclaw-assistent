---
name: run-qa
description: "Полная проверка качества кода: TypeScript компиляция, ESLint, Vitest тесты. Используй после изменений в коде или перед коммитом. Запуск: /run-qa"
user-invocable: true
allowed-tools: Bash(npm run build) Bash(npm run lint) Bash(npm run test:run) Bash(npm run format)
---

# Проверка качества (QA Pipeline)

Запусти все проверки по порядку и сообщи результат.

## Шаги

1. **TypeScript компиляция**
```bash
npm run build
```
Если ошибки — показать их и остановиться.

2. **ESLint проверка**
```bash
npm run lint
```
Если ошибки — попробовать автоисправление:
```bash
npm run lint:fix
```

3. **Vitest тесты**
```bash
npm run test:run
```
Показать упавшие тесты если есть.

4. **Prettier форматирование**
```bash
npm run format
```

## Формат результата

```
## QA Результат

- TypeScript: OK / X ошибок
- ESLint: OK / X ошибок (Y исправлено автоматически)
- Тесты: X passed / Y failed / Z total
- Prettier: OK / X файлов отформатировано

Итог: PASS / FAIL
```
