import { createLogger } from './logger.js';

const log = createLogger('retry');

export interface RetryOptions {
  retries?: number;
  backoffMs?: number;
  maxBackoffMs?: number;
  onRetry?: (error: Error, attempt: number) => void;
}

const DEFAULTS: Required<Omit<RetryOptions, 'onRetry'>> = {
  retries: 3,
  backoffMs: 1000,
  maxBackoffMs: 10_000,
};

export async function retryAsync<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { retries, backoffMs, maxBackoffMs } = { ...DEFAULTS, ...options };

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt > retries) break;

      const delay = Math.min(backoffMs * Math.pow(2, attempt - 1), maxBackoffMs);
      log.debug(`Attempt ${attempt}/${retries + 1} failed, retrying in ${delay}ms`, {
        error: lastError.message,
      });

      options.onRetry?.(lastError, attempt);
      await sleep(delay);
    }
  }

  throw lastError!;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
