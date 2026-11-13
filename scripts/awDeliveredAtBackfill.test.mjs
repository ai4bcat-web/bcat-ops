import { describe, expect, it } from 'vitest';
import { applyOne, buildReport, deliveredFor, deliveredGate, planDeliveredAt } from './awDeliveredAtBackfill.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';
import { resolveScripts } from './prodBackup.mjs';
import { DEV_SUFFIX } from './lib/prodGate.mjs';

const ship = (o = {}) => ({ id: 'shp-1', number: '20027', status: 'DELIVERED', deliveredAt: null, statusChangedAt: '2026-11-12T13:11:32.050Z', statusChangedBy: 'arcie@bcatcorp.com', ...o });
const stops = [
  { type: 'pickup', arrivedAt: '2026-11-11T19:10:00.000Z', departedAt: '2026-11-11T23:15:00.000Z' },
  { type: 'delivery', arrivedAt: '2026-11-12T13:11:26.304Z', departedAt: '2026-11-12T13:11:30.808Z' },
];

describe('deliveredFor', () => {
  it('prefers the loads stamp, then the delivery stop actual, then the status change', () => {
    expect(deliveredFor(ship(), [{ deliveredAt: '2026-11-12T10:00:00Z', stops }])).toEqual({ at: '2026-11-12T10:00:00Z', source: 'load deliveredAt' });
    expect(deliveredFor(ship(), [{ deliveredAt: null, stops }])).toEqual({ at: '2026-11-12T13:11:30.808Z', source: 'last delivery stop actual' });
    expect(deliveredFor(ship(), [{ stops: JSON.stringify(stops) }]).at).toBe('2026-11-12T13:11:30.808Z');
    expect(deliveredFor(ship(), [])).toEqual({ at: '2026-11-12T13:11:32.050Z', source: 'status changed to DELIVERED' });
  });
  it('ignores voided loads', () => {
    expect(deliveredFor(ship(), [{ deliveredAt: '2026-01-01T00:00:00Z', voidedAt: '2026-02-01' }]).source).toBe('status changed to DELIVERED');
  });
});

describe('planDeliveredAt', () => {
  it('only picks DELIVERED shipments without a stamp', () => {
    const plan = planDeliveredAt({
      shipments: [ship(), ship({ id: 'shp-2', number: '20001', deliveredAt: '2026-11-01T00:00:00Z' }), ship({ id: 'shp-3', number: '20002', status: 'IN_TRANSIT' }), ship({ id: 'shp-4', number: '20003', statusChangedAt: null })],
      loads: [{ shipmentId: 'shp-1', stops }],
    });
    expect(plan.map((r) => [r.shipment.number, r.status])).toEqual([['20003', 'NO_DATE'], ['20027', 'READY']]);
    expect(buildReport({ plan, today: '2026-11-12' })).toContain('20027: 2026-11-12T13:11:30.808Z (last delivery stop actual)');
  });
});

describe('applyOne', () => {
  const row = { shipment: ship(), status: 'READY', at: '2026-11-12T13:11:30.808Z', source: 'last delivery stop actual' };
  it('writes deliveredAt only while still DELIVERED and unstamped, with an audit row', async () => {
    const calls = [];
    const doc = { send: async (c) => { calls.push({ name: c.constructor.name, input: c.input }); return {}; } };
    expect(await applyOne({ doc, suffix: DEV_SUFFIX, row })).toEqual({ written: 1, lost: 0 });
    const upd = calls.find((c) => c.name === 'UpdateCommand').input;
    expect(upd.TableName).toBe(`Shipment-${DEV_SUFFIX}`);
    expect(upd.UpdateExpression).toBe('SET deliveredAt = :d, updatedAt = :at, updatedBy = :by');
    expect(upd.ConditionExpression).toContain('attribute_type(deliveredAt, :nul)');
    expect(upd.ConditionExpression).toContain('#st = :delivered');
    expect(calls.some((c) => c.name === 'PutCommand' && c.input.TableName === `AuditLog-${DEV_SUFFIX}`)).toBe(true);
  });
  it('counts a shipment that changed meanwhile as lost', async () => {
    const doc = { send: async () => { const e = new Error('x'); e.name = 'ConditionalCheckFailedException'; throw e; } };
    expect(await applyOne({ doc, suffix: DEV_SUFFIX, row })).toEqual({ written: 0, lost: 1 });
  });
  it('is registered for backup and gated', () => {
    expect(PROD_WRITE_SETS.awDeliveredAtBackfill.models).toEqual(['Shipment', 'AuditLog']);
    expect(resolveScripts('awDeliveredAtBackfill')).toEqual(['awDeliveredAtBackfill']);
    expect(typeof deliveredGate).toBe('function');
  });
});
