import { describe, expect, it } from 'vitest';
import { planNumbers } from './awShipmentNumber.mjs';

const sh = (id, number, createdAt) => ({ id, number, createdAt, searchKey: `${number} acme dallas, tx` });

describe('awShipmentNumber planNumbers', () => {
  const tables = {
    Shipment: [sh('a', '14939', '2026-10-01'), sh('t', '99001', '2026-10-05'), sh('b', '99002', '2026-11-09T14:00'), sh('c', '99003', '2026-11-09T15:00')],
    Load: [{ id: 'la', shipmentId: 'a', loadNumber: '14939' }, { id: 'lb', shipmentId: 'b', loadNumber: '99002' }, { id: 'lc', shipmentId: 'c', loadNumber: '99003-2' }],
    Invoice: [], ProClaim: [],
  };
  it('renumbers only post-cutover counter numbers, in creation order, leaving Aljex PROs and the 99001 test load', () => {
    const { entries, summary } = planNumbers(tables);
    expect(entries.map((e) => `${e.old}->${e.next}`)).toEqual(['99002->20000', '99003->20001']);
    expect(summary.counterAfter).toBe(20001);
    const b = entries[0].writes.map((w) => `${w.model}:${JSON.stringify(w.after)}`);
    expect(b).toContain('Shipment:{"number":"20000","searchKey":"20000 acme dallas, tx"}');
    expect(b).toContain('Load:{"loadNumber":"20000"}');
    expect(entries[1].writes.find((w) => w.model === 'Load').after.loadNumber).toBe('20001-2');
  });
  it('skips numbers already taken by a shipment or a PRO claim', () => {
    const t = { ...tables, ProClaim: [{ id: '20000' }], Shipment: [...tables.Shipment, sh('d', '20001', '2026-11-01')] };
    const { entries } = planNumbers(t);
    expect(entries.map((e) => e.next)).toEqual(['20002', '20003']);
  });
  it('is a no-op when no shipment carries a 99xxx counter number', () => {
    const { entries, summary } = planNumbers({ Shipment: [sh('a', '14939', '2026-10-01')], Load: [], ProClaim: [] });
    expect(entries).toHaveLength(0);
    expect(summary.counterAfter).toBe(19999);
  });
});
