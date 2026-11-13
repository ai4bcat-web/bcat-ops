import { describe, expect, it } from 'vitest';
import { conflictReason, planDuplicateMerges, rankMembers } from './customerDupMergePlan.mjs';

// Minimal stand-ins for the app's grouping (the script bundles the real ones).
const normalize = (n) => n.toLowerCase().replace(/[.,]/g, '').replace(/\b(inc|llc)\b/g, '').trim().replace(/\s+/g, ' ');
const buildDuplicateIndex = (cs) => {
  const by = new Map();
  for (const c of cs) by.set(normalize(c.name), [...(by.get(normalize(c.name)) ?? []), c]);
  const out = new Map();
  for (const list of by.values()) if (list.length > 1) for (const c of list) out.set(c.id, { count: list.length - 1 });
  return out;
};

describe('customer duplicate merge plan', () => {
  it('keeps the stored-ACTIVE imported account over an intake row with more history', () => {
    const imported = { id: 'cus-1', name: 'FULL SAIL LOGISTICS', status: 'ACTIVE', billingMethod: 'FACTOR', createdAt: '2026-11-08' };
    const intake = { id: 'u-1', name: 'Full Sail Logistics LLC', createdAt: '2026-11-10' };
    const counts = { 'cus-1': { shipments: 0, invoices: 0 }, 'u-1': { shipments: 2, invoices: 2 } };
    const plan = planDuplicateMerges({ customers: [imported, intake], buildDuplicateIndex, normalize, counts: (id) => counts[id] });
    expect(plan.flaggedCount).toBe(2);
    expect(plan.clusters[0].survivor.id).toBe('cus-1');
    expect(plan.clusters[0].sources.map((s) => s.id)).toEqual(['u-1']);
  });

  it('between two ACTIVE accounts the one with more shipments + invoices survives', () => {
    const a = { id: 'a', name: 'SPOT', status: 'ACTIVE', createdAt: '2' };
    const b = { id: 'b', name: 'SPOT INC', status: 'ACTIVE', createdAt: '1' };
    const ranked = rankMembers([b, a], (id) => (id === 'a' ? 10 : 2));
    expect(ranked[0].id).toBe('a');
  });

  it('skips groups whose identifiers or billing cities disagree', () => {
    expect(conflictReason([{ mcNumber: 'MC-123' }, { mcNumber: '123' }])).toBeNull();
    expect(conflictReason([{ mcNumber: '123' }, { mcNumber: '456' }])).toMatch(/different MC/);
    expect(conflictReason([{ billingAddress: { city: 'Louisville', state: 'KY' } }, { billingAddress: { city: 'Jacksonville', state: 'FL' } }])).toMatch(/billing cities/);
    const plan = planDuplicateMerges({
      customers: [
        { id: 'x', name: 'RWB TRUCKING', status: 'ACTIVE', billingAddress: { city: 'WOODRIDGE', state: 'IL' } },
        { id: 'y', name: 'RWB TRUCKING LLC', status: 'ACTIVE', billingAddress: { city: 'CAROL STREAM', state: 'IL' } },
      ],
      buildDuplicateIndex, normalize, counts: () => ({ shipments: 0, invoices: 0 }),
    });
    expect(plan.clusters[0].skip).toMatch(/billing cities/);
    expect(plan.clusters[0].sources).toEqual([]);
  });

  it('never picks a CLOSED or BLOCKED account as the target', () => {
    const plan = planDuplicateMerges({
      customers: [{ id: 'c', name: 'ACME', status: 'CLOSED' }, { id: 'd', name: 'ACME INC', status: 'BLOCKED' }],
      buildDuplicateIndex, normalize, counts: () => ({ shipments: 5, invoices: 5 }),
    });
    expect(plan.clusters[0].survivor).toBeNull();
    expect(plan.clusters[0].skip).toMatch(/CLOSED/);
  });
});
