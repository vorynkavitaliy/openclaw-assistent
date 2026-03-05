import { describe, expect, it } from 'vitest';
import { retryAsync } from '../retry.js';

describe('retryAsync', () => {
  it('возвращает результат при первом успехе', async () => {
    const result = await retryAsync(() => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it('повторяет при ошибке и возвращает результат', async () => {
    let attempts = 0;
    const result = await retryAsync(
      () => {
        attempts++;
        if (attempts < 3) throw new Error('fail');
        return Promise.resolve('ok');
      },
      { retries: 3, backoffMs: 10 },
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('выбрасывает ошибку после исчерпания попыток', async () => {
    await expect(
      retryAsync(
        () => {
          throw new Error('always fails');
        },
        { retries: 2, backoffMs: 10 },
      ),
    ).rejects.toThrow('always fails');
  });

  it('вызывает onRetry callback при повторе', async () => {
    const retries: number[] = [];
    let attempts = 0;

    await retryAsync(
      () => {
        attempts++;
        if (attempts < 2) throw new Error('fail');
        return Promise.resolve('ok');
      },
      {
        retries: 3,
        backoffMs: 10,
        onRetry: (_err, attempt) => retries.push(attempt),
      },
    );

    expect(retries).toEqual([1]);
  });

  it('exponential backoff с jitter (не мгновенный)', async () => {
    const start = Date.now();
    let attempts = 0;

    await retryAsync(
      () => {
        attempts++;
        if (attempts < 3) throw new Error('fail');
        return Promise.resolve('ok');
      },
      { retries: 3, backoffMs: 50 },
    );

    const elapsed = Date.now() - start;
    // 2 ретрая: ~50ms + ~100ms = ~150ms, с jitter ±15% -> минимум ~100ms
    expect(elapsed).toBeGreaterThanOrEqual(80);
  });
});
