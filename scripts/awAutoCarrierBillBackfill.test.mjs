import { describe, expect, it } from 'vitest';
import { addDays, applyOne, buildReport, datesFor, planAutoBills } from './awAutoCarrierBillBackfill.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';
import { DEV_SUFFIX } from './lib/prodGate.mjs';

const bill = (o = {}) => ({ id: 'cb:lc-1:1', shipmentId: 'shp-1', loadId: 'lod-1', status: 'IN_REVIEW', datesPending: true, paidCents: 0, creditedCents: 0, billDate: '2026-11-13', dueAt: '2026-12-13', version: 1, carrierName: 'GIGI LINE', ...o });
const ship = (o = {}) => ({ id: 'shp-1', number: '14619', status: 'DELIVERED', revDivision: 'CAR_SHIPPING', deliveredAt: '2026-11-09T22:30:00.000Z', ...o });

describe('datesFor', () => {
  it('bills on the delivered Chicago day, due two days later', () => {
    expect(datesFor(ship(), null)).toEqual({ billDate: '2026-11-09', dueAt: '2026-11-11' });
    expect(datesFor(ship({ deliveredAt: '2026-11-10T03:00:00.000Z' }), null)?.billDate).toBe('2026-11-09');
    expect(datesFor(ship({ deliveredAt: null, status: 'IN_TRANSIT' }), { stops: JSON.stringify([{ type: 'delivery', departedAt: '2026-10-13T15:00:00Z' }]) })).toEqual({ billDate: '2026-10-13', dueAt: '2026-10-15' });
    expect(datesFor(ship({ deliveredAt: null, status: 'IN_TRANSIT' }), null)).toBeNull();
  });
  it('rolls months', () => { expect(addDays('2026-11-30', 2)).toBe('2026-12-02'); });
});

describe('planAutoBills', () => {
  it('only car-shipping bills still pending with no money; honors excludes', () => {
    const plan = planAutoBills({
      bills: [bill(), bill({ id: 'b2', shipmentId: 'shp-2' }), bill({ id: 'b3', datesPending: false }), bill({ id: 'b4', shipmentId: 'shp-3' }), bill({ id: 'b5', shipmentId: 'shp-4', paidCents: 100 })],
      shipments: [ship(), ship({ id: 'shp-2', number: '13175' }), ship({ id: 'shp-3', number: '20001', revDivision: 'BROKERAGE' }), ship({ id: 'shp-4', number: '14000' })],
      loads: [],
      exclude: ['13175'],
    });
    expect(plan.map((r) => [r.number, r.status])).toEqual([['13175', 'EXCLUDED'], ['14000', 'HAS_MONEY'], ['14619', 'READY']]);
    expect(buildReport({ plan, today: '2026-11-13' })).toContain('14619 · GIGI LINE: bill 2026-11-09, due 2026-11-11');
  });
});

describe('applyOne', () => {
  it('writes the SET_BILL_DATES fields conditionally plus an audit row; a lost race writes nothing', async () => {
    const sent = [];
    const doc = { send: async (cmd) => { sent.push(cmd.input); } };
    const row = { bill: bill(), number: '14619', billDate: '2026-11-09', dueAt: '2026-11-11' };
    expect(await applyOne({ doc, suffix: DEV_SUFFIX, row })).toEqual({ written: 1, lost: 0 });
    expect(sent[0].ExpressionAttributeValues).toMatchObject({ ':bd': '2026-11-09', ':bm': '2026-11', ':due': '2026-11-11', ':terms': 2, ':f': false, ':was': 1, ':v': 2 });
    expect(sent[1].Item.action).toBe('AW_AUTO_CARRIER_BILL_DATES');
    const lost = { send: async () => { throw Object.assign(new Error('x'), { name: 'ConditionalCheckFailedException' }); } };
    expect(await applyOne({ doc: lost, suffix: DEV_SUFFIX, row })).toEqual({ written: 0, lost: 1 });
  });
  it('declares the tables it writes for the backup gate', () => {
    expect(PROD_WRITE_SETS.awAutoCarrierBillBackfill.models).toEqual(['CarrierBill', 'AuditLog']);
  });
});
