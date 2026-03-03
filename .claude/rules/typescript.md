---
paths:
  - "src/**/*.ts"
  - "src/**/*.tsx"
---

# TypeScript правила проекта

## ES Modules (КРИТИЧНО)
- Расширение `.js` обязательно во ВСЕХ import путях:
  ```typescript
  import { foo } from './bar.js';       // OK
  import { foo } from './bar';          // ОШИБКА
  import { foo } from './bar/index.js'; // OK
  ```

## Strict TypeScript
- tsconfig: `strict: true`, `noUnusedLocals`, `noImplicitReturns`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
- НЕ использовать `any` без крайней необходимости и комментария почему
- Все функции — с явными типами возвращаемого значения для публичного API

## Импорт типов
- Использовать `import type { ... }` для чисто типовых импортов
- Все торговые типы из `src/trading/shared/types.ts`

## Логгер
- Использовать `createLogger('module-name')` из `../../utils/logger.js`
- НЕ использовать `console.log` / `console.error` — только через логгер

## Обработка ошибок
- Всегда ловить и логировать ошибки API-вызовов
- Использовать `retryAsync()` для нестабильных операций (биржевые API)
- В catch-блоках — типизировать ошибку: `catch (error: unknown)`

## Паттерн конфигурации
```typescript
import { getBybitCredentials } from '../../utils/config.js';
const creds = getBybitCredentials(); // из ~/.openclaw/openclaw.json
```
