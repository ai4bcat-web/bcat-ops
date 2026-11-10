import { describe, expect, it } from 'vitest';
import { planPhones, PHONES } from './awCompanyPhones.mjs';
import { referenceCounts } from './awDriverDelete.mjs';

describe('company phones and driver delete', () => {
  it('creates only the phones that are missing', () => {
    expect(planPhones([]).length).toBe(3);
    expect(planPhones([{ label: PHONES[0].label }]).map((p) => p.label)).toEqual(['Two Ivan Cartage', 'Three Ivan Cartage']);
  });
  it('counts what points at a driver', () => {
    const r = referenceCounts({ loadCarriers: [{ driverId: 'd' }, { driverId: 'x' }], loads: [{ deliveryDriverId: 'd' }], submissions: [] }, 'd');
    expect(r).toEqual({ loadCarriers: 1, loads: 1, submissions: 0 });
  });
});
