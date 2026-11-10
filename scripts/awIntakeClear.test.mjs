import { describe, expect, it } from 'vitest';
import { planIntakeClear } from './awIntakeClear.mjs';

describe('planIntakeClear', () => {
  const shipments = [{ id: 's1', number: '20001' }, { id: 's2', number: '20002' }, { id: 's3', number: '20003', voidedAt: 'x' }];
  const orders = [{ shipmentId: 's1', references: [{ value: '214129178' }] }, { shipmentId: 's3', references: [{ value: 'ZZ' }] }];
  const intake = [
    { id: 'a', status: 'OPEN', fields: JSON.stringify({ reference: '214129178' }) },
    { id: 'b', status: 'OPEN', fields: { reference: null } },
    { id: 'c', status: 'OPEN', fields: { reference: 'zz' } },
    { id: 'd', status: 'MOVED', fields: { reference: '214129178' } },
  ];
  it('matches by reference, by explicit pair, never a voided shipment or a non-open row', () => {
    const { entries, unmatched } = planIntakeClear({ intake, shipments, orders, pairs: { b: '20002' } });
    expect(entries.map((e) => [e.row.id, e.shipment.number, e.how])).toEqual([['a', '20001', 'REFERENCE'], ['b', '20002', 'PAIR']]);
    expect(unmatched.map((r) => r.id)).toEqual(['c']);
  });
});
