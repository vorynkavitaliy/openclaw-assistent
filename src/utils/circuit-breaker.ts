import { createLogger } from './logger.js';
import { sendTelegram } from './telegram.js';

const log = createLogger('circuit-breaker');

export interface CircuitBreakerOptions {
  /** Количество последовательных ошибок до перехода в OPEN (по умолчанию 3) */
  failureThreshold?: number;
  /** Время ожидания в OPEN состоянии перед переходом в HALF_OPEN, мс (по умолчанию 5 мин) */
  resetTimeoutMs?: number;
  /** Имя для идентификации в логах и уведомлениях */
  name?: string;
}

export interface CircuitBreakerStats {
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  /** Количество последовательных ошибок */
  failures: number;
  /** Время последней ошибки (мс) или null */
  lastFailure: number | null;
  /** Общее количество переходов в OPEN */
  totalTrips: number;
}

export class CircuitBreakerOpenError extends Error {
  constructor(name: string, resetInMs: number) {
    const resetInSec = Math.ceil(resetInMs / 1000);
    super(`Circuit breaker "${name}" OPEN — повторная попытка через ${resetInSec}с`);
    this.name = 'CircuitBreakerOpenError';
  }
}

type State = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreaker {
  execute<T>(fn: () => Promise<T>): Promise<T>;
  getState(): State;
  getStats(): CircuitBreakerStats;
}

export function createCircuitBreaker(options: CircuitBreakerOptions = {}): CircuitBreaker {
  const failureThreshold = options.failureThreshold ?? 3;
  const resetTimeoutMs = options.resetTimeoutMs ?? 5 * 60 * 1000;
  const name = options.name ?? 'bybit-api';

  let state: State = 'CLOSED';
  let failures = 0;
  let lastFailure: number | null = null;
  let openedAt: number | null = null;
  let totalTrips = 0;

  function isNetworkOrServerError(err: unknown): boolean {
    if (err instanceof Error) {
      // Сетевые ошибки
      if (
        err.message.includes('fetch failed') ||
        err.message.includes('ECONNREFUSED') ||
        err.message.includes('ETIMEDOUT') ||
        err.message.includes('ENOTFOUND') ||
        err.message.includes('socket hang up') ||
        err.message.includes('network') ||
        err.name === 'AbortError'
      ) {
        return true;
      }

      // 5xx ошибки HTTP
      const match =
        err.message.match(/HTTP\s+(\d{3})/i) ?? err.message.match(/status[:\s]+(\d{3})/i);
      if (match) {
        const code = parseInt(match[1] ?? '0');
        return code >= 500 && code < 600;
      }
    }
    return false;
  }

  function transitionToOpen(): void {
    state = 'OPEN';
    openedAt = Date.now();
    totalTrips++;

    log.warn('Circuit breaker перешёл в OPEN', {
      name,
      failures,
      totalTrips,
      resetInMs: resetTimeoutMs,
    });

    // Уведомление в Telegram — не блокируем, игнорируем ошибку
    sendTelegram(
      `⚠️ Circuit breaker OPEN: Bybit API недоступен. Торговля приостановлена на ${Math.ceil(resetTimeoutMs / 60_000)} мин.`,
    ).catch(() => {
      // умолчание — уведомление не критично
    });
  }

  function transitionToClosed(): void {
    state = 'CLOSED';
    failures = 0;
    lastFailure = null;
    openedAt = null;
    log.info('Circuit breaker перешёл в CLOSED', { name });
  }

  function transitionToHalfOpen(): void {
    state = 'HALF_OPEN';
    log.info('Circuit breaker перешёл в HALF_OPEN — пробный запрос', { name });
  }

  async function execute<T>(fn: () => Promise<T>): Promise<T> {
    // OPEN: блокируем или переходим в HALF_OPEN
    if (state === 'OPEN') {
      const now = Date.now();
      const elapsed = openedAt !== null ? now - openedAt : resetTimeoutMs;

      if (elapsed < resetTimeoutMs) {
        const remaining = resetTimeoutMs - elapsed;
        throw new CircuitBreakerOpenError(name, remaining);
      }

      // Timeout прошёл → пробуем один запрос
      transitionToHalfOpen();
    }

    // HALF_OPEN: пропускаем один запрос, следим за результатом
    const inHalfOpen = state === 'HALF_OPEN';

    try {
      const result = await fn();

      // Успех
      if (inHalfOpen) {
        transitionToClosed();
      } else {
        // CLOSED: сбрасываем счётчик при успехе
        if (failures > 0) {
          failures = 0;
          log.debug('Circuit breaker: счётчик ошибок сброшен', { name });
        }
      }

      return result;
    } catch (error: unknown) {
      lastFailure = Date.now();

      // В HALF_OPEN любая ошибка → сразу обратно в OPEN
      if (inHalfOpen) {
        log.warn('Circuit breaker: HALF_OPEN запрос провалился, возврат в OPEN', { name });
        transitionToOpen();
        throw error;
      }

      // В CLOSED: считаем только сетевые/серверные ошибки
      if (isNetworkOrServerError(error)) {
        failures++;
        log.warn('Circuit breaker: зафиксирована ошибка', { name, failures, failureThreshold });

        if (failures >= failureThreshold) {
          transitionToOpen();
        }
      } else {
        // Бизнес-ошибка (4xx, validation) — не считаем
        log.debug('Circuit breaker: бизнес-ошибка, счётчик не увеличен', {
          name,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      throw error;
    }
  }

  function getState(): State {
    return state;
  }

  function getStats(): CircuitBreakerStats {
    return {
      state,
      failures,
      lastFailure,
      totalTrips,
    };
  }

  return { execute, getState, getStats };
}
