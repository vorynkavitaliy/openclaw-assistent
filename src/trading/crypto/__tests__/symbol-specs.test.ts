import { describe, expect, it } from 'vitest';
import { formatQty, getQtyPrecision, roundPrice } from '../symbol-specs.js';

describe('getQtyPrecision', () => {
  it('возвращает корректную точность для известных символов', () => {
    expect(getQtyPrecision('BTCUSDT')).toBe(3);
    expect(getQtyPrecision('ETHUSDT')).toBe(2);
    expect(getQtyPrecision('XRPUSDT')).toBe(0);
    expect(getQtyPrecision('DOGEUSDT')).toBe(0);
  });

  it('возвращает 1 для неизвестных символов', () => {
    expect(getQtyPrecision('UNKNOWNUSDT')).toBe(1);
  });
});

describe('formatQty', () => {
  it('форматирует BTC qty с 3 знаками', () => {
    expect(formatQty(0.123, 'BTCUSDT')).toBe('0.123');
    expect(formatQty(1.5, 'BTCUSDT')).toBe('1.500');
  });

  it('форматирует XRP qty без дробной части', () => {
    expect(formatQty(100, 'XRPUSDT')).toBe('100');
    expect(formatQty(99.7, 'XRPUSDT')).toBe('100');
  });

  it('возвращает минимальный qty если результат слишком мал', () => {
    expect(formatQty(0.0001, 'BTCUSDT')).toBe('0.001');
    expect(formatQty(0.001, 'XRPUSDT')).toBe('1');
  });
});

describe('roundPrice', () => {
  it('BTC цена с 1 знаком', () => {
    expect(roundPrice(68123.456, 'BTCUSDT')).toBe(68123.5);
  });

  it('ETH цена с 2 знаками', () => {
    expect(roundPrice(3456.789, 'ETHUSDT')).toBe(3456.79);
  });

  it('XRP цена с 4 знаками', () => {
    expect(roundPrice(0.54321, 'XRPUSDT')).toBe(0.5432);
  });

  it('неизвестный символ — 4 знака по умолчанию', () => {
    expect(roundPrice(1.23456789, 'UNKNOWNUSDT')).toBe(1.2346);
  });
});
