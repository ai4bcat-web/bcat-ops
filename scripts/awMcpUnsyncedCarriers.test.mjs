import { describe, expect, it } from 'vitest';
import { unsyncedCarriers } from './awMcpUnsyncedCarriers.mjs';

describe('unsyncedCarriers', () => {
  it('lists carriers with an MC or DOT and no MyCarrierPackets status, and nothing else', () => {
    const out = unsyncedCarriers([
      { id: 'a', name: 'LANDSTAR RANGER INC.', status: 'ACTIVE', mcNumber: '166960', dotNumber: '241572', insurancePolicies: [] },
      { id: 'b', name: 'SYNCED', status: 'ACTIVE', mcNumber: '1', mcpStatus: 'ACCEPTABLE' },
      { id: 'c', name: 'NO NUMBERS', status: 'INACTIVE' },
      { id: 'd', name: 'DOT ONLY', status: 'INACTIVE', dotNumber: '9' },
    ]);
    expect(out.map((r) => r.id)).toEqual(['d', 'a']);
    expect(out[1]).toMatchObject({ mcNumber: '166960', policies: 0 });
  });
});
