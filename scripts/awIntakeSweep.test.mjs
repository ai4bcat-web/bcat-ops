import { describe, expect, it } from 'vitest';
import { planIntakeSweep } from './awIntakeSweep.mjs';

describe('planIntakeSweep', () => {
  const now = new Date(2026, 10, 10, 12, 0, 0);
  const at = (m, d, h = 12) => new Date(2026, m - 1, d, h, 0, 0).toISOString();
  const shipments = [
    { id: 's1', number: '20001', createdAt: at(11, 9) },
    { id: 's2', number: '20002', createdAt: at(11, 10) },
    { id: 's3', number: '19999', createdAt: at(11, 1) },
  ];
  const orders = [
    { shipmentId: 's1', references: [{ value: 'AAA' }] },
    { shipmentId: 's2', references: [{ value: 'BBB' }] },
    { shipmentId: 's3', references: [{ value: 'CCC' }] },
  ];
  const row = (id, ref, receivedAt, status = 'OPEN') => ({ id, status, receivedAt, fields: { reference: ref } });
  const intake = [
    row('built-today', 'bbb', at(11, 10)),
    row('built-yday-dupe', 'AAA', at(11, 9)),
    row('built-yday-dupe2', 'aaa', at(11, 9)),
    row('older-build', 'CCC', at(11, 1)),
    row('old-oct30', 'ZZ', at(10, 30, 23)),
    row('old-oct1', null, at(10, 1)),
    row('fresh', 'NEW1', at(11, 8)),
    row('oct31', 'X', at(10, 31, 0)),
    row('already-moved', 'AAA', at(10, 1), 'MOVED'),
  ];

  it('moves rows for loads built today or yesterday, dismisses the rest received through the cutoff, leaves everything else', () => {
    const { moved, dismissed, stays } = planIntakeSweep({ intake, shipments, orders, now });
    expect(moved.map((e) => [e.row.id, e.shipment.number])).toEqual([['built-today', '20002'], ['built-yday-dupe', '20001'], ['built-yday-dupe2', '20001']]);
    expect(dismissed.map((r) => r.id)).toEqual(['old-oct30', 'old-oct1']);
    expect(stays.map((r) => r.id)).toEqual(['older-build', 'fresh', 'oct31']);
  });

  it('never touches a row that is not OPEN', () => {
    const { moved, dismissed, stays } = planIntakeSweep({ intake, shipments, orders, now });
    for (const id of ['already-moved']) {
      expect([...moved.map((e) => e.row.id), ...dismissed.map((r) => r.id), ...stays.map((r) => r.id)]).not.toContain(id);
    }
  });

  it('honours a different cutoff', () => {
    const { dismissed } = planIntakeSweep({ intake, shipments, orders, now, through: '2026-10-31' });
    expect(dismissed.map((r) => r.id)).toEqual(['old-oct30', 'old-oct1', 'oct31']);
  });
});
