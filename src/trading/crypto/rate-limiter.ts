import { createLogger } from '../../utils/logger.js';

const log = createLogger('rate-limiter');

const SAFETY_TIMEOUT_MS = 30_000;

export interface RateLimiterStats {
  pending: number;
  completed: number;
  windowRequests: number;
  rps: number;
}

export interface RateLimiter {
  acquire(): Promise<void>;
  release(): void;
  getStats(): RateLimiterStats;
}

export function createRateLimiter(options: {
  maxPerSecond: number;
  maxConcurrent?: number;
}): RateLimiter {
  const { maxPerSecond, maxConcurrent = maxPerSecond } = options;

  // Sliding window: timestamps успешно выданных слотов
  const timestamps: number[] = [];

  // Очередь ожидающих concurrent слота
  const concurrentQueue: Array<() => void> = [];

  let concurrentNow = 0;
  let pending = 0;
  let completed = 0;

  function cleanup(now: number): void {
    const cutoff = now - 1000;
    while (timestamps.length > 0 && (timestamps[0] ?? now) < cutoff) {
      timestamps.shift();
    }
  }

  function release(): void {
    concurrentNow = Math.max(0, concurrentNow - 1);

    // Будим первого из очереди ожидающих concurrent слота
    const next = concurrentQueue.shift();
    if (next !== undefined) {
      next();
    }
  }

  async function waitForConcurrentSlot(): Promise<void> {
    if (concurrentNow < maxConcurrent) {
      return;
    }

    // Ждём пока release() разбудит нас
    await new Promise<void>((resolve) => {
      concurrentQueue.push(resolve);
    });
  }

  async function waitForRateWindow(): Promise<void> {
    while (true) {
      const now = Date.now();
      cleanup(now);

      if (timestamps.length < maxPerSecond) {
        timestamps.push(now);
        return;
      }

      // Ждём до момента когда самый старый timestamp выйдет из окна
      const oldestTs = timestamps[0] ?? now;
      const waitMs = Math.max(10, oldestTs + 1000 - now + 1);

      if (waitMs > 500) {
        log.debug('Rate limiter: ожидание окна', { waitMs, queued: timestamps.length });
      }

      await new Promise<void>((r) => setTimeout(r, waitMs));
    }
  }

  async function acquire(): Promise<void> {
    pending++;

    // Ждём concurrent слот через очередь (не busy-wait)
    await waitForConcurrentSlot();

    concurrentNow++;

    // Ждём rate window (sliding window по timestamps)
    await waitForRateWindow();

    pending--;
    completed++;

    // Safety timeout: если release() не был вызван за 30с — освобождаем автоматически
    setTimeout(() => {
      // Проверяем косвенно: если concurrentNow > 0, значит кто-то не вызвал release
      // Нельзя знать точно какой именно слот — просто освобождаем один
      if (concurrentNow > 0) {
        log.warn('Rate limiter: safety timeout — release() не был вызван за 30с, освобождаем слот');
        release();
      }
    }, SAFETY_TIMEOUT_MS);
  }

  function getStats(): RateLimiterStats {
    const now = Date.now();
    cleanup(now);
    return {
      pending,
      completed,
      windowRequests: timestamps.length,
      rps: timestamps.length,
    };
  }

  return { acquire, release, getStats };
}
