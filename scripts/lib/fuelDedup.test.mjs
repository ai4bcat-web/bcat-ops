import { describe, expect, it } from 'vitest';
import { fuelIdentityKey, storedFillMatcher } from './fuelDedup.mjs';

const fill = (o = {}) => ({ transactionDate: '2026-11-05', cardNumber: '00031', fuelType: 'ULSD', amount: 723.73, quantity: 113.1, ...o });

describe('storedFillMatcher', () => {
  it('knows a fill stored under a different invoice string (text vs PDF) and a card without its zeros', () => {
    const has = storedFillMatcher([fill({ invoiceNumber: '0870924283' })]);
    expect(has(fill({ invoiceNumber: '0870924283 530', cardNumber: '31' }))).toBe(true);
  });
  it('knows the same fill when the other report format rounds the amount by a few cents', () => {
    const has = storedFillMatcher([fill({ transactionDate: '2026-10-07', cardNumber: '00106', amount: 1083.7, quantity: 193.57 })]);
    expect(has(fill({ transactionDate: '2026-10-07', cardNumber: '00106', amount: 1083.79, quantity: 193.57 }))).toBe(true);
  });
  it('does not treat a different fill the same day as stored', () => {
    const has = storedFillMatcher([fill()]);
    expect(has(fill({ amount: 120.5, quantity: 20 }))).toBe(false);
    expect(has(fill({ amount: 733.73 }))).toBe(false); // $10 apart with the same gallons is not a rounding difference
    expect(has(fill({ cardNumber: '00049' }))).toBe(false);
    expect(has(fill({ fuelType: 'DEFD' }))).toBe(false);
  });
  it('compares only what was stored before the run, so identical fills inside one report all go in', () => {
    const has = storedFillMatcher([]);
    const lines = [fill({ amount: 128.67, quantity: 22.42 }), fill({ amount: 128.67, quantity: 22.42 }), fill({ amount: 128.67, quantity: 22.42 })];
    expect(lines.filter((l) => !has(l))).toHaveLength(3);
  });
  it('uses the invoice-free identity the app uses', () => {
    expect(fuelIdentityKey(fill({ cardNumber: '00031' }))).toBe('2026-11-05|31|ULSD|723.73|113.1');
  });
});
