import { describe, it, expect } from 'vitest';
import {
  AP_OPEN,
  DEV_TABLE_SUFFIX,
  planCarrierLegs,
  resolveTarget,
  stampFor,
} from './backfillApOpen.mjs';

/**
 * Isolated fixtures: one LoadCarrier per branch the migration can take, so a change in
 * the classifier shows up here rather than on the AP board. Nothing here talks to AWS.
 */
const legs = () => [
  // (a) own fleet carrying Step B's default rung — the rung comes off.
  { id: 'own-with-rung', kind: 'OWN_ASSET', status: 'ACTIVE', apStatus: 'AWAITING_INVOICE', createdAt: '2026-01-02T00:00:00.000Z' },
  // (a) own fleet already clean — nothing to do, and no apOpen is ever written here.
  { id: 'own-clean', kind: 'OWN_ASSET', status: 'ACTIVE', createdAt: '2026-01-03T00:00:00.000Z' },
  // (b) the ordinary case: stamp comes from bookedAt, not createdAt, not now.
  { id: 'carrier-active', kind: 'CARRIER', status: 'ACTIVE', apStatus: 'AWAITING_INVOICE', bookedAt: '2026-02-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' },
  // (b) a truck ordered and not used is still a bill.
  { id: 'carrier-tonu', kind: 'CARRIER', status: 'TONU', apStatus: 'AWAITING_INVOICE', createdAt: '2026-02-02T00:00:00.000Z' },
  // (b) no rung at all still belongs on the board; where in the flow it sits is a person's call.
  { id: 'carrier-no-rung', kind: 'CARRIER', status: 'ACTIVE', bookedAt: '2026-02-03T00:00:00.000Z' },
  // skipped: settled.
  { id: 'carrier-paid', kind: 'CARRIER', status: 'ACTIVE', apStatus: 'PAID', bookedAt: '2026-02-04T00:00:00.000Z' },
  // skipped: the carrier that walked is owed nothing.
  { id: 'carrier-bounced', kind: 'CARRIER', status: 'BOUNCED', apStatus: 'AWAITING_INVOICE', bookedAt: '2026-02-05T00:00:00.000Z' },
  // reported, never guessed: no kind means no ledger.
  { id: 'no-kind', status: 'ACTIVE', apStatus: 'AWAITING_INVOICE', createdAt: '2026-02-06T00:00:00.000Z' },
  // reported: the marker without a sort key is not in the sparse index anyway.
  { id: 'carrier-no-stamp', kind: 'CARRIER', status: 'ACTIVE', apStatus: 'AWAITING_INVOICE' },
];

/** What the applied plan leaves behind, so the planner can be asked to run again. */
function applyToFixtures(rows, plan) {
  const byId = new Map(rows.map((r) => [r.id, { ...r }]));
  for (const action of [...plan.clears, ...plan.opens]) {
    const row = byId.get(action.id);
    if (action.action === 'CLEAR_OWN_ASSET_AP_STATUS') delete row.apStatus;
    else {
      row.apOpen = AP_OPEN;
      row.apStatusChangedAt = action.apStatusChangedAt;
    }
  }
  return [...byId.values()];
}

describe('backfillApOpen — which legs the AP board opens on', () => {
  it('takes Step B\'s rung off own-fleet legs and never puts one on the board', () => {
    const plan = planCarrierLegs(legs());
    expect(plan.clears.map((c) => c.id)).toEqual(['own-with-rung']);
    expect(plan.ownAlreadyClear).toBe(1);
    expect(plan.opens.some((o) => o.id.startsWith('own-'))).toBe(false);
  });

  it('opens the carrier legs we still owe on, and only those', () => {
    const plan = planCarrierLegs(legs());
    expect(plan.opens.map((o) => o.id).sort()).toEqual(['carrier-active', 'carrier-no-rung', 'carrier-tonu']);
    expect(plan.skippedPaid).toBe(1);
    expect(plan.skippedBounced).toBe(1);
  });

  it('leaves a leg of a deleted shipment off the board, however it looks on its own', () => {
    // DELETE_SHIPMENT took the marker off; the leg still reads ACTIVE / AWAITING_INVOICE
    // with the stamp the Lambda wrote, which is exactly what pass (b) would open.
    const rows = [
      ...legs(),
      { id: 'carrier-of-deleted', shipmentId: 'shp-gone', kind: 'CARRIER', status: 'ACTIVE', apStatus: 'AWAITING_INVOICE', apStatusChangedAt: '2026-02-07T00:00:00.000Z', bookedAt: '2026-02-07T00:00:00.000Z' },
      { id: 'carrier-of-live', shipmentId: 'shp-live', kind: 'CARRIER', status: 'ACTIVE', apStatus: 'AWAITING_INVOICE', bookedAt: '2026-02-08T00:00:00.000Z' },
    ];
    const shipments = [
      { id: 'shp-gone', deletedAt: '2026-02-09T00:00:00.000Z' },
      { id: 'shp-live' },
    ];
    const plan = planCarrierLegs(rows, shipments);
    expect(plan.opens.map((o) => o.id)).not.toContain('carrier-of-deleted');
    expect(plan.opens.map((o) => o.id)).toContain('carrier-of-live');
    expect(plan.skippedShipmentDeleted).toBe(1);
    expect(planCarrierLegs(rows).opens.map((o) => o.id)).toContain('carrier-of-deleted');
  });

  it('stamps when we took the leg on, not when the migration ran', () => {
    const plan = planCarrierLegs(legs());
    const stamps = Object.fromEntries(plan.opens.map((o) => [o.id, o.apStatusChangedAt]));
    expect(stamps['carrier-active']).toBe('2026-02-01T00:00:00.000Z');
    expect(stamps['carrier-tonu']).toBe('2026-02-02T00:00:00.000Z');
    expect(stampFor({ apStatusChangedAt: 'a', bookedAt: 'b', createdAt: 'c' })).toBe('a');
    expect(stampFor({ bookedAt: 'b', createdAt: 'c' })).toBe('b');
    expect(stampFor({ createdAt: 'c' })).toBe('c');
  });

  it('reports what it will not guess at instead of writing it', () => {
    const plan = planCarrierLegs(legs());
    expect(plan.unstampable.map((u) => [u.loadCarrierId, u.reason]).sort()).toEqual([
      ['carrier-no-stamp', 'NO_TIMESTAMP_TO_STAMP'],
      ['no-kind', 'NO_CARRIER_KIND'],
    ]);
  });

  it('lists a leg that already carries a bill, and still opens it', () => {
    const rows = [
      ...legs(),
      { id: 'carrier-billed', kind: 'CARRIER', status: 'ACTIVE', apStatus: 'IN_REVIEW', invoiceId: 'bill-1', bookedAt: '2026-03-01T00:00:00.000Z' },
    ];
    const plan = planCarrierLegs(rows);
    expect(plan.invoiced.map((i) => i.loadCarrierId)).toEqual(['carrier-billed']);
    expect(plan.opens.map((o) => o.id)).toContain('carrier-billed');
  });

  it('leaves a leg that should not be on the board alone, and says so', () => {
    const rows = [
      { id: 'paid-on-board', kind: 'CARRIER', status: 'ACTIVE', apStatus: 'PAID', apOpen: AP_OPEN, bookedAt: '2026-03-02T00:00:00.000Z' },
      { id: 'bounced-on-board', kind: 'CARRIER', status: 'BOUNCED', apOpen: AP_OPEN, bookedAt: '2026-03-03T00:00:00.000Z' },
      { id: 'own-on-board', kind: 'OWN_ASSET', status: 'ACTIVE', apOpen: AP_OPEN, createdAt: '2026-03-04T00:00:00.000Z' },
    ];
    const plan = planCarrierLegs(rows);
    expect(plan.opens).toEqual([]);
    expect(plan.clears).toEqual([]);
    expect(plan.unexpectedOpen.map((u) => u.reason).sort()).toEqual([
      'BOUNCED_ON_AP_BOARD',
      'OWN_ASSET_ON_AP_BOARD',
      'PAID_ON_AP_BOARD',
    ]);
  });

  it('has nothing left to do once its own plan has been applied', () => {
    const first = planCarrierLegs(legs());
    const after = applyToFixtures(legs(), first);
    const second = planCarrierLegs(after);
    expect(second.clears).toEqual([]);
    expect(second.opens).toEqual([]);
    expect(second.alreadyOpen).toBe(first.opens.length);
    expect(second.ownAlreadyClear).toBe(2);
  });

  it('refuses the production tables before it reads anything', () => {
    expect(() => resolveTarget('5ucwdyvwivelbo4k4jomvrwel4-NONE')).toThrow(/production/i);
    expect(resolveTarget(undefined)).toEqual({ suffix: DEV_TABLE_SUFFIX, environment: 'dev' });
  });
});
