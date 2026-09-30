import { describe, it, expect } from 'vitest';
import {
  centsToDecimal,
  decimalToCents,
  formatMoney,
  moneyToCents,
} from './tmsMoney.mjs';

describe('tmsMoney', () => {
  it('converts cents to a two-decimal string', () => {
    expect(centsToDecimal(12345)).toBe('123.45');
    expect(centsToDecimal(0)).toBe('0.00');
    expect(centsToDecimal(5)).toBe('0.05');
    expect(centsToDecimal(100)).toBe('1.00');
  });

  it('converts negative cents correctly', () => {
    expect(centsToDecimal(-12345)).toBe('-123.45');
  });

  it('rejects float money inputs and converts strings', () => {
    expect(decimalToCents('123.45')).toBe(12345);
    expect(decimalToCents('0.05')).toBe(5);
    expect(() => decimalToCents(123.456)).toThrow();
    expect(() => decimalToCents('123.4')).toThrow();
    expect(() => decimalToCents('123')).toThrow();
  });

  it('formats display money', () => {
    expect(formatMoney(12345)).toBe('$123.45');
  });

  it('parses display money back to cents', () => {
    expect(moneyToCents('$123.45')).toBe(12345);
    expect(moneyToCents('123.45')).toBe(12345);
  });
});
