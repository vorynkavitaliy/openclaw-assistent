# QA Tester — MEMORY.md

Долгосрочная память QA-тестера. Обновляется по мере накопления опыта.

## Команды тестирования

```bash
# TypeScript проверка типов
npm run typecheck

# Полная сборка (финальная проверка)
npm run build

# ESLint
npm run lint

# Vitest — все тесты
npm run test:run

# Vitest — watch mode
npm run test
```

## Структура тестов

- Тесты: `src/**/*.test.ts` или `tests/` папка
- Framework: Vitest (не Jest!)
- Mock: `vi.mock()`, `vi.fn()`

## Ключевые модули для тестирования

| Модуль | Путь | Критичность |
|--------|------|-------------|
| indicators | `src/trading/shared/indicators.ts` | ВЫСОКАЯ |
| confluence | `src/trading/shared/confluence.ts` | ВЫСОКАЯ |
| risk | `src/trading/shared/risk.ts` | ВЫСОКАЯ |
| bybit-client | `src/trading/crypto/bybit-client.ts` | СРЕДНЯЯ |
| state | `src/trading/crypto/state.ts` | СРЕДНЯЯ |

## Типичные ошибки которые ловим

1. **TypeScript**: `noUncheckedIndexedAccess` → обращение к `arr[0]` без проверки
2. **ES Modules**: импорт без `.js` расширения → ошибка runtime
3. **noUnusedLocals**: объявленные но неиспользуемые переменные
4. **Floating promises**: не awaited async функции
5. **Null safety**: `undefined` не обработан в опциональных полях

## Чеклист для review

- [ ] `npm run typecheck` — 0 ошибок
- [ ] `npm run lint` — 0 ошибок
- [ ] `npm run build` — успешная сборка
- [ ] Новые функции покрыты тестами
- [ ] Нет `console.log` (только `createLogger`)
- [ ] Нет хардкодированных credentials
- [ ] Импорты с `.js` расширением

## Паттерны тестирования indicators.ts

```typescript
import { describe, it, expect } from 'vitest';
import { calculateEma, calculateRsi, calculateAtr } from '../shared/indicators.js';

describe('calculateEma', () => {
  it('should return correct EMA values', () => {
    const prices = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const result = calculateEma(prices, 3);
    expect(result.length).toBe(prices.length);
    expect(result[result.length - 1]).toBeCloseTo(9.25, 2);
  });
});
```

## Уроки и инсайты

- `npm run build` — главный тест: если сборка прошла, TypeScript корректен
- Indicators — чистые функции, легко тестировать без моков
- Bybit client тестировать сложнее (API calls) → используй mock API ответы
- Confluence scoring: тестировать граничные значения (-100, 0, +100)
- После изменений в `types.ts` — проверить что все места использования обновлены
