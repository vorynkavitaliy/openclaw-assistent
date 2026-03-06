import { describe, expect, it } from 'vitest';
import { calculateCost } from '../llm-cost-tracker.js';

describe('llm-cost-tracker', () => {
  describe('calculateCost', () => {
    it('рассчитывает стоимость правильно', () => {
      // 1000 prompt tokens * $3/1M + 500 completion tokens * $15/1M
      const cost = calculateCost(1000, 500);
      expect(cost).toBeCloseTo(0.0105, 4);
    });

    it('возвращает 0 для нулевых токенов', () => {
      expect(calculateCost(0, 0)).toBe(0);
    });

    it('считает только prompt tokens', () => {
      const cost = calculateCost(1_000_000, 0);
      expect(cost).toBeCloseTo(3.0, 2); // $3/1M prompt
    });

    it('считает только completion tokens', () => {
      const cost = calculateCost(0, 1_000_000);
      expect(cost).toBeCloseTo(15.0, 2); // $15/1M completion
    });

    it('типичный вызов advisor ~$0.03', () => {
      // ~2000 prompt + ~300 completion
      const cost = calculateCost(2000, 300);
      expect(cost).toBeGreaterThan(0.01);
      expect(cost).toBeLessThan(0.05);
    });
  });
});
