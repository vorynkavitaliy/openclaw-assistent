import { describe, expect, it, vi } from 'vitest';
import { createCircuitBreaker, CircuitBreakerOpenError } from '../circuit-breaker.js';

// Мокаем telegram, чтобы тесты не делали реальных HTTP-запросов
vi.mock('../telegram.js', () => ({
  sendTelegram: vi.fn().mockResolvedValue(true),
}));

// Мокаем logger, чтобы тесты не засоряли вывод
vi.mock('../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const NETWORK_ERROR = new Error('fetch failed: ECONNREFUSED');
const SERVER_ERROR = new Error('HTTP 503 Service Unavailable');
const BUSINESS_ERROR = new Error('Order REJECTED: insufficient balance');

describe('CircuitBreaker', () => {
  describe('Состояние CLOSED (нормальная работа)', () => {
    it('пропускает успешные запросы', async () => {
      const cb = createCircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 5000 });
      const result = await cb.execute(() => Promise.resolve(42));
      expect(result).toBe(42);
      expect(cb.getState()).toBe('CLOSED');
    });

    it('успешные запросы сбрасывают счётчик ошибок', async () => {
      const cb = createCircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 5000 });

      // 2 ошибки — ещё не OPEN
      await expect(cb.execute(() => Promise.reject(NETWORK_ERROR))).rejects.toThrow();
      await expect(cb.execute(() => Promise.reject(NETWORK_ERROR))).rejects.toThrow();
      expect(cb.getStats().failures).toBe(2);

      // Успешный запрос сбрасывает счётчик
      await cb.execute(() => Promise.resolve('ok'));
      expect(cb.getStats().failures).toBe(0);
      expect(cb.getState()).toBe('CLOSED');
    });

    it('бизнес-ошибки (не 5xx/network) не увеличивают счётчик', async () => {
      const cb = createCircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 5000 });

      for (let i = 0; i < 5; i++) {
        await expect(cb.execute(() => Promise.reject(BUSINESS_ERROR))).rejects.toThrow();
      }

      expect(cb.getState()).toBe('CLOSED');
      expect(cb.getStats().failures).toBe(0);
    });
  });

  describe('Переход CLOSED → OPEN после 3 ошибок', () => {
    it('переходит в OPEN после failureThreshold сетевых ошибок', async () => {
      const cb = createCircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 5000 });

      await expect(cb.execute(() => Promise.reject(NETWORK_ERROR))).rejects.toThrow();
      await expect(cb.execute(() => Promise.reject(NETWORK_ERROR))).rejects.toThrow();
      expect(cb.getState()).toBe('CLOSED'); // ещё не OPEN

      await expect(cb.execute(() => Promise.reject(NETWORK_ERROR))).rejects.toThrow();
      expect(cb.getState()).toBe('OPEN'); // теперь OPEN
    });

    it('переходит в OPEN после 5xx ошибок HTTP', async () => {
      const cb = createCircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 5000 });

      for (let i = 0; i < 3; i++) {
        await expect(cb.execute(() => Promise.reject(SERVER_ERROR))).rejects.toThrow();
      }

      expect(cb.getState()).toBe('OPEN');
    });

    it('getStats() отражает количество ошибок и totalTrips', async () => {
      const cb = createCircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 5000 });

      for (let i = 0; i < 3; i++) {
        await expect(cb.execute(() => Promise.reject(NETWORK_ERROR))).rejects.toThrow();
      }

      const stats = cb.getStats();
      expect(stats.state).toBe('OPEN');
      expect(stats.failures).toBe(3);
      expect(stats.totalTrips).toBe(1);
      expect(stats.lastFailure).not.toBeNull();
    });
  });

  describe('Состояние OPEN блокирует запросы', () => {
    it('бросает CircuitBreakerOpenError, не вызывая fn', async () => {
      const cb = createCircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 60_000 });
      const fn = vi.fn().mockRejectedValue(NETWORK_ERROR);

      // Открываем breaker
      for (let i = 0; i < 3; i++) {
        await expect(cb.execute(fn)).rejects.toThrow();
      }

      fn.mockReset();

      // Теперь breaker OPEN — fn не должна вызываться
      await expect(cb.execute(fn)).rejects.toThrow(CircuitBreakerOpenError);
      expect(fn).not.toHaveBeenCalled();
    });

    it('CircuitBreakerOpenError содержит имя breaker', async () => {
      const cb = createCircuitBreaker({
        failureThreshold: 3,
        resetTimeoutMs: 60_000,
        name: 'test-api',
      });

      for (let i = 0; i < 3; i++) {
        await expect(cb.execute(() => Promise.reject(NETWORK_ERROR))).rejects.toThrow();
      }

      await expect(cb.execute(() => Promise.resolve())).rejects.toThrow(/test-api/);
    });
  });

  describe('Переход OPEN → HALF_OPEN после timeout', () => {
    it('пропускает один запрос после resetTimeoutMs', async () => {
      const cb = createCircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 10 });
      const fn = vi.fn().mockRejectedValue(NETWORK_ERROR);

      // Открываем breaker
      for (let i = 0; i < 3; i++) {
        await expect(cb.execute(fn)).rejects.toThrow();
      }
      expect(cb.getState()).toBe('OPEN');

      // Ждём сброса
      await new Promise((r) => setTimeout(r, 20));

      // Теперь должен перейти в HALF_OPEN и пропустить запрос
      fn.mockResolvedValueOnce('probe-ok');
      const result = await cb.execute(fn);
      expect(result).toBe('probe-ok');
      expect(cb.getState()).toBe('CLOSED');
    });
  });

  describe('Переход HALF_OPEN → CLOSED при успехе', () => {
    it('переходит в CLOSED если пробный запрос успешен', async () => {
      const cb = createCircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 10 });

      // Открываем breaker
      for (let i = 0; i < 3; i++) {
        await expect(cb.execute(() => Promise.reject(NETWORK_ERROR))).rejects.toThrow();
      }

      // Ждём сброса в HALF_OPEN
      await new Promise((r) => setTimeout(r, 20));

      // Успешный пробный запрос → CLOSED
      await cb.execute(() => Promise.resolve('success'));
      expect(cb.getState()).toBe('CLOSED');

      // Счётчик ошибок сброшен
      const stats = cb.getStats();
      expect(stats.failures).toBe(0);
    });
  });

  describe('Переход HALF_OPEN → OPEN при ошибке', () => {
    it('возвращается в OPEN если пробный запрос провалился', async () => {
      const cb = createCircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 10 });

      // Открываем breaker
      for (let i = 0; i < 3; i++) {
        await expect(cb.execute(() => Promise.reject(NETWORK_ERROR))).rejects.toThrow();
      }

      // Ждём сброса в HALF_OPEN
      await new Promise((r) => setTimeout(r, 20));

      // Провальный пробный запрос → обратно в OPEN
      await expect(cb.execute(() => Promise.reject(new Error('still down')))).rejects.toThrow();
      expect(cb.getState()).toBe('OPEN');

      // totalTrips увеличился
      expect(cb.getStats().totalTrips).toBe(2);
    });
  });

  describe('getStats()', () => {
    it('возвращает корректную структуру в начальном состоянии', () => {
      const cb = createCircuitBreaker();
      const stats = cb.getStats();
      expect(stats.state).toBe('CLOSED');
      expect(stats.failures).toBe(0);
      expect(stats.lastFailure).toBeNull();
      expect(stats.totalTrips).toBe(0);
    });

    it('обновляет lastFailure при ошибке', async () => {
      const cb = createCircuitBreaker({ failureThreshold: 3 });
      const before = Date.now();
      await expect(cb.execute(() => Promise.reject(NETWORK_ERROR))).rejects.toThrow();
      const after = Date.now();

      const stats = cb.getStats();
      expect(stats.lastFailure).not.toBeNull();
      expect(stats.lastFailure!).toBeGreaterThanOrEqual(before);
      expect(stats.lastFailure!).toBeLessThanOrEqual(after);
    });
  });
});
