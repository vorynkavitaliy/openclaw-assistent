---
paths:
  - "src/**/*.ts"
  - "scripts/**"
  - "*.json"
---

# Правила безопасности (КРИТИЧНО)

## Credentials
- НИКОГДА не помещать API ключи, токены, пароли в код
- НИКОГДА не коммитить `.env`, `keys.md`, `credentials.json`
- Все секреты — из `~/.openclaw/openclaw.json` через `utils/config.ts`
- В документации — safe-формат: `7467…umn4` (показывать первые + последние 4 символа)

## Файлы-исключения (не редактировать, не коммитить)
- `.env`, `.env.*`
- `keys.md`
- `~/.openclaw/openclaw.json` (реальный конфиг)
- `~/.openclaw/credentials.json`

## Проверка перед коммитом
```bash
grep -r 'apiKey\s*=\s*"' src/     # не должно быть результатов
grep -r 'apiSecret' src/           # только ссылки на config
grep -r 'password\s*=' src/        # не должно быть хардкода
```

## Telegram
- Bot token — только из конфига
- Ограничение `allowFrom` на user ID: `tg:5929886678`
- Не логировать полные данные пользователя
