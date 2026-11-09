import { describe, expect, it } from 'vitest';
import { planDivisionReps } from './salesRepDivisionPlan.mjs';

const profiles = [
  { id: 'u-ryne', name: 'Ryne Bandolik', status: 'ACTIVE' },
  { id: 'u-ruben', name: 'Ruben Vargas', status: 'ACTIVE' },
  { id: 'rep-ivan-cartage', name: 'Ivan Cartage', status: 'ACTIVE' },
];

describe('planDivisionReps', () => {
  const shipments = [
    { id: 's1', revDivision: 'BROKERAGE', salesRepId: 'u-ruben', salesRepCode: 'RUBEN VARGAS' },
    { id: 's2', revDivision: 'ASSETS', salesRepId: 'u-ryne', salesRepCode: 'RYNE BANDOLIK' },
    { id: 's3', revDivision: 'CAR_SHIPPING' },
    { id: 's4', revDivision: 'BROKERAGE', salesRepId: 'u-ryne', salesRepCode: 'RYNE BANDOLIK' },
    { id: 's5', revDivision: 'BROKERAGE', voidedAt: '2026-01-01' },
    { id: 's6', revDivision: 'OTHER' },
  ];
  const orders = [{ id: 'o1', shipmentId: 's1', customerRepId: 'u-ruben' }, { id: 'o4', shipmentId: 's4', customerRepId: 'u-ryne' }];
  const plan = planDivisionReps({ shipments, orders, profiles });

  it('re-tags by division, overwriting, with a group rep having no code', () => {
    const by = Object.fromEntries(plan.entries.map((e) => [e.shipment.id, e]));
    expect(by.s1.shipWrite.value).toEqual({ salesRepId: 'u-ryne', salesRepCode: 'RYNE BANDOLIK' });
    expect(by.s1.orderWrites.map((w) => w.value)).toEqual(['u-ryne']);
    expect(by.s2.shipWrite.value).toEqual({ salesRepId: 'rep-ivan-cartage', salesRepCode: '' });
    expect(by.s3.shipWrite.value.salesRepId).toBe('u-ruben');
  });
  it('leaves right, voided and unruled shipments alone', () => {
    expect(plan.entries.map((e) => e.shipment.id)).toEqual(['s1', 's2', 's3']);
    expect(plan.unchanged).toBe(1);
    expect(plan.skipped).toEqual({ voided: 1, noRule: 1 });
  });
  it('writes the default map for new shipments', () => {
    expect(plan.settings).toEqual({ changed: true, next: { ASSETS: 'rep-ivan-cartage', CAR_SHIPPING: 'u-ruben', BROKERAGE: 'u-ryne' } });
  });
  it('reports a missing profile', () => {
    expect(planDivisionReps({ shipments, orders, profiles: profiles.slice(0, 2) }).missing).toEqual(['ASSETS:Ivan Cartage:NONE']);
  });
});
