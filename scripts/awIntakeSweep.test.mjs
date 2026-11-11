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

  it('moves rows by subject to the shipment number named, skips a row two subjects claim, and keeps the rest', () => {
    const open = (id, subject, receivedAt = at(11, 9)) => ({ id, status: 'OPEN', subject, receivedAt, fields: { reference: null } });
    const rows = [
      open('a', 'Re: Load from MENASHA, WI to BRIDGEVIEW, IL'),
      open('b', 'Fwd: Sussex to NY Shipping on Friday 11/13'),
      open('c', 'driver chad'),
      open('d', 'Untitled'),
      open('e', 'Sussex to NY and Untitled'),
    ];
    const ships = [{ id: 'x1', number: '20022' }, { id: 'x2', number: '20011' }, { id: 'x3', number: '20000' }];
    const { moved, stays } = planIntakeSweep({
      intake: rows, shipments: ships, orders: [], now,
      subjects: [{ text: 'menasha', number: '20022' }, { text: 'sussex to ny', number: '20011' }, { text: 'untitled', number: '20000' }],
    });
    expect(moved.map((e) => [e.row.id, e.shipment.number, e.how])).toEqual([['a', '20022', 'SUBJECT'], ['b', '20011', 'SUBJECT'], ['d', '20000', 'SUBJECT']]);
    expect(stays.map((r) => r.id).sort()).toEqual(['c', 'e']);
  });
});

describe('planIntakeSweep --dedupe', () => {
  const now = new Date(2026, 10, 11, 12, 0, 0);
  const mk = (id, receivedAt, over = {}) => ({ id, status: 'OPEN', subject: 'Fwd: Rate Confirmation for Load: 699', bodyText: 'Please see the attached rate confirmation for this load', receivedAt, ...over });
  const intake = [
    mk('b-later', '2026-11-11T14:19:30Z'), mk('a-first', '2026-11-11T14:19:00Z'),
    mk('other-load', '2026-11-11T14:19:10Z', { subject: 'Fwd: Rate Confirmation for Load: 123' }),
    mk('far', '2026-11-11T18:00:00Z'),
  ];
  it('keeps the earliest copy and dismisses the later one; nothing else', () => {
    const { duplicates, stays } = planIntakeSweep({ intake, shipments: [], orders: [], now, dedupe: true });
    expect(duplicates.map((d) => [d.row.id, d.of.id])).toEqual([['b-later', 'a-first']]);
    expect(stays.map((r) => r.id).sort()).toEqual(['a-first', 'far', 'other-load']);
  });
  it('does nothing without --dedupe', () => {
    expect(planIntakeSweep({ intake, shipments: [], orders: [], now }).duplicates).toEqual([]);
  });
});
