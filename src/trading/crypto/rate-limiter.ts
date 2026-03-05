import { createLogger } from '../../utils/logger.js';

const log = createLogger('rate-limiter');

export interface RateLimiterStats {
  pending: number;
  completed: number;
  windowRequests: number;
  rps: number;
}

export interface RateLimiter {
  acquire(): Promise<void>;
  getStats(): RateLimiterStats;
}

export function createRateLimiter(options: {
  maxPerSecond: number;
  maxConcurrent?: number;
}): RateLimiter {
  const { maxPerSecond, maxConcurrent = maxPerSecond } = options;

  const timestamps: number[] = [];
  let pending = 0;
  let completed = 0;
  let concurrentNow = 0;

  function cleanup(now: number): void {
    const cutoff = now - 1000;
    while (timestamps.length > 0 && (timestamps[0] ?? now) < cutoff) {
      timestamps.shift();
    }
  }

  async function acquire(): Promise<void> {
    // Ожидаем пока concurrent слот освободится
    while (concurrentNow >= maxConcurrent) {
      await new Promise((r) => setTimeout(r, 50));
    }

    pending++;

    // Ожидаем пока rate limit позволит запрос
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    while (true) {
      const now = Date.now();
      cleanup(now);

      if (timestamps.length < maxPerSecond) {
        timestamps.push(now);
        pending--;
        concurrentNow++;

        // Авто-декремент concurrent через timeout (запрос ~1-3с max)
        setTimeout(() => {
          concurrentNow = Math.max(0, concurrentNow - 1);
        }, 5000);

        completed++;
        return;
      }

      // Ждём до момента когда самый старый timestamp выйдет из окна
      const oldestTs = timestamps[0] ?? now;
      const waitMs = Math.max(10, oldestTs + 1000 - now + 1);

      if (waitMs > 500) {
        log.debug('Rate limiter: waiting', { waitMs, queued: timestamps.length });
      }

      await new Promise((r) => setTimeout(r, waitMs));
    }
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

  return { acquire, getStats };
}
