---
paths:
  - "src/**/*.test.ts"
  - "src/**/*.spec.ts"
---

# Правила тестирования

## Фреймворк: Vitest
```bash
npm run test:run    # однократный запуск
npm run test        # watch mode
```

## Структура тестов
- Тесты рядом с исходным файлом: `indicators.test.ts` рядом с `indicators.ts`
- Альтернативно — в `__tests__/` поддиректории

## Паттерн теста
```typescript
import { describe, it, expect, vi } from 'vitest';
import { functionToTest } from './module.js';

describe('functionToTest', () => {
  it('описание на русском: обрабатывает нормальный ввод', () => {
    const result = functionToTest(input);
    expect(result).toEqual(expected);
  });

  it('описание: обрабатывает граничные случаи', () => {
    expect(functionToTest([])).toEqual([]);
  });
});
```

## Приоритет тестирования
1. `shared/indicators.ts` — бизнес-логика индикаторов (EMA, RSI, ATR)
2. `shared/risk.ts` — расчёт позиций, лимиты
3. `crypto/state.ts` — trading state логика
4. `crypto/config.ts`, `forex/config.ts` — чтение конфигов
5. `utils/` — вспомогательные утилиты

## Моки
- Биржевые API — мокать через `vi.mock()`
- Конфигурация — подставлять тестовые данные
- Telegram — мокать `sendTelegramMessage`
