import { describe, expect, it } from 'vitest';
import { createRateLimiter } from '../rate-limiter.js';

describe('createRateLimiter', () => {
  it('позволяет запросы в пределах лимита', async () => {
    const limiter = createRateLimiter({ maxPerSecond: 10 });
    const start = Date.now();

    // 5 запросов при лимите 10/сек — должны пройти мгновенно
    for (let i = 0; i < 5; i++) {
      await limiter.acquire();
    }

    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(200);
  });

  it('возвращает корректную статистику', async () => {
    const limiter = createRateLimiter({ maxPerSecond: 20 });

    await limiter.acquire();
    await limiter.acquire();

    const stats = limiter.getStats();
    expect(stats.completed).toBe(2);
    expect(stats.windowRequests).toBe(2);
    expect(stats.pending).toBe(0);
  });

  it('ограничивает скорость при превышении лимита', async () => {
    // maxConcurrent должен быть больше maxPerSecond чтобы не блокировать concurrent
    const limiter = createRateLimiter({ maxPerSecond: 3, maxConcurrent: 10 });

    // 3 запроса — мгновенно
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();

    const start = Date.now();

    // 4-й запрос — должен ждать ~1 сек
    await limiter.acquire();

    const elapsed = Date.now() - start;
    // Должно пройти хотя бы ~800мс (запас на таймеры и jitter)
    expect(elapsed).toBeGreaterThanOrEqual(800);
    expect(elapsed).toBeLessThan(2000);
  }, 10_000);

  it('concurrent лимит работает', async () => {
    const limiter = createRateLimiter({ maxPerSecond: 100, maxConcurrent: 2 });

    // Первые 2 — мгновенно
    await limiter.acquire();
    await limiter.acquire();

    const stats = limiter.getStats();
    expect(stats.completed).toBe(2);
  });
});
