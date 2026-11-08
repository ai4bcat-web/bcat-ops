import { describe, it, expect } from 'vitest';
import {
  CREATE_LEG,
  FILL_LEG_NAME,
  DEV_TABLE_SUFFIX,
  applyOwnAssetDriversPlan,
  buildOwnAssetDriversPlan,
  csvOf,
  planOwnAssetDrivers,
  resolveTarget,
  scopeSource,
  sourceRowsOf,
} from './backfillOwnAssetDrivers.mjs';
import { validatePlan } from './lib/tmsPlan.mjs';

const drivers = () => [
  { id: 'drv-a', name: 'Driver A', phone: '555-0001', active: true },
  { id: 'drv-b', name: 'Driver B', phone: '555-0002', active: true },
  { id: 'drv-off', name: 'Driver Off', phone: '555-0003', active: false },
  { id: 'drv-broker', name: 'BROKER COVERED', phone: '', active: true, type: 'broker' },
];

const stop = (type, driverId) => ({ id: `${type}-${driverId}`, type, sequence: type === 'pickup' ? 0 : 1, driverId, appt: '2026-10-01T15:00:00.000Z' });

const load = (id, extra = {}) => ({
  id,
  shipmentId: `shp-${id}`,
  aljexId: `PRO-${id}`,
  assignmentType: 'OWN_ASSET',
  status: 'BOOKED',
  pickupAppt: '2026-10-01T15:00:00.000Z',
  deliveryAppt: '2026-10-02T15:00:00.000Z',
  customer: 'Cust',
  ...extra,
});

const leg = (loadId, extra = {}) => ({ id: `lcr-${loadId}`, loadId, shipmentId: `shp-${loadId}`, kind: 'OWN_ASSET', status: 'ACTIVE', sequence: 1, ...extra });

const fixtures = () => ({
  loads: [
    load('voided', { voidedAt: '2026-09-01T00:00:00.000Z', status: 'CANCELED' }),
    load('nobody', { stops: [stop('pickup', null), stop('delivery', null)] }),
    load('legless', { pickupDriverId: 'drv-a', deliveryDriverId: 'drv-a', truckId: 'trk-1', trailerNumber: 'T9', stops: JSON.stringify([stop('pickup', 'drv-a'), stop('delivery', 'drv-a')]) }),
    load('unnamed', { pickupDriverId: 'drv-a', deliveryDriverId: 'drv-a', activeLoadCarrierId: 'lcr-unnamed' }),
    load('delivered-no-pickup', { status: 'DELIVERED', deliveryDriverId: 'drv-b', activeLoadCarrierId: 'lcr-delivered-no-pickup' }),
    load('relay', { pickupDriverId: 'drv-a', deliveryDriverId: 'drv-b', activeLoadCarrierId: 'lcr-relay' }),
    load('inactive', { status: 'DELIVERED', pickupDriverId: 'drv-off', deliveryDriverId: 'drv-off', activeLoadCarrierId: 'lcr-inactive' }),
    load('brokered', { assignmentType: 'NEED_TO_COVER', deliveryDriverId: 'drv-a' }),
    load('named', { pickupDriverId: 'drv-a', deliveryDriverId: 'drv-a', activeLoadCarrierId: 'lcr-named' }),
  ],
  legs: [
    leg('unnamed', { driverId: 'drv-a' }),
    leg('delivered-no-pickup', { driverId: 'drv-b', driverName: 'Driver B' }),
    leg('relay', { driverId: 'drv-a', driverName: 'Driver A' }),
    leg('inactive', { driverId: 'drv-off', driverName: 'Driver Off' }),
    leg('named', { driverId: 'drv-a', driverName: 'Driver A' }),
  ],
});

const plan = () => {
  const f = fixtures();
  return planOwnAssetDrivers(f.loads, f.legs, drivers());
};
const byClass = (r, cls) => r.report.filter((x) => x.class === cls).map((x) => x.loadId);

describe('backfillOwnAssetDrivers — which own-fleet loads get fixed and which are only reported', () => {
  it('skips voided/canceled loads and counts them', () => {
    const p = plan();
    expect(p.counts.VOIDED_OR_CANCELED).toBe(1);
    expect(p.report.some((r) => r.loadId === 'voided')).toBe(false);
    expect(p.actions.some((a) => a.loadId === 'voided')).toBe(false);
  });

  it('reports a driverless own-fleet load and plans nothing for it, even with stops present', () => {
    const p = plan();
    expect(byClass(p, 'NO_DRIVER_ANYWHERE')).toEqual(['nobody']);
    expect(p.actions.some((a) => a.loadId === 'nobody')).toBe(false);
  });

  it('gives a leg-less load that already names a driver one leg built from the roster', () => {
    const creates = plan().actions.filter((a) => a.action === CREATE_LEG);
    expect(creates).toHaveLength(1);
    expect(creates[0].loadId).toBe('legless');
    expect(creates[0].item).toMatchObject({
      kind: 'OWN_ASSET', status: 'ACTIVE', sequence: 1, driverId: 'drv-a', driverName: 'Driver A',
      driverPhone: '555-0001', truckId: 'trk-1', trailerNumber: 'T9', shipmentId: 'shp-legless',
    });
  });

  it('numbers the new leg after the legs the load already had', () => {
    const f = fixtures();
    const legs = [...f.legs, leg('legless', { id: 'old', status: 'BOUNCED', sequence: 3 })];
    const p = planOwnAssetDrivers(f.loads, legs, drivers());
    expect(p.actions.find((a) => a.action === CREATE_LEG).item.sequence).toBe(4);
  });

  it('fills only the name and phone on an active leg that has a roster driver but no name', () => {
    const fills = plan().actions.filter((a) => a.action === FILL_LEG_NAME);
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ loadId: 'unnamed', id: 'lcr-unnamed', after: { driverName: 'Driver A', driverPhone: '555-0001' } });
  });

  it('only reports a delivered load whose pickup stop has no driver', () => {
    const p = plan();
    expect(byClass(p, 'PICKUP_STOP_NO_DRIVER')).toEqual(['delivered-no-pickup']);
    expect(p.actions.some((a) => a.loadId === 'delivered-no-pickup')).toBe(false);
  });

  it('counts a relay as information and does not touch it', () => {
    const p = plan();
    expect(p.report.filter((r) => r.class === 'SPLIT_RELAY').map((r) => [r.loadId, r.severity])).toEqual([['relay', 'info']]);
    expect(p.actions.some((a) => a.loadId === 'relay')).toBe(false);
  });

  it('reports an inactive, unknown or broker driver instead of naming a leg after them', () => {
    const f = fixtures();
    f.loads.push(load('unknown', { deliveryDriverId: 'ghost', pickupDriverId: 'ghost', activeLoadCarrierId: 'lcr-unknown' }));
    f.legs.push(leg('unknown', { driverId: 'ghost' }));
    f.loads.push(load('bk', { deliveryDriverId: 'drv-broker', pickupDriverId: 'drv-broker', activeLoadCarrierId: 'lcr-bk' }));
    f.legs.push(leg('bk', { driverId: 'drv-broker' }));
    const p = planOwnAssetDrivers(f.loads, f.legs, drivers());
    expect(byClass(p, 'DRIVER_INACTIVE')).toEqual(['inactive']);
    expect(byClass(p, 'DRIVER_UNKNOWN')).toEqual(['unknown']);
    expect(byClass(p, 'DRIVER_BROKER')).toEqual(['bk']);
    expect(p.actions.filter((a) => ['inactive', 'unknown', 'bk'].includes(a.loadId))).toEqual([]);
  });

  it('counts brokered loads that carry a driver, and leaves them alone', () => {
    const p = plan();
    expect(p.counts.NEED_TO_COVER_WITH_DRIVER).toBe(1);
    expect(p.actions.some((a) => a.loadId === 'brokered')).toBe(false);
  });

  it('skips imported Aljex history: no gap report, no leg built, counted on its own line', () => {
    const f = fixtures();
    f.loads.push(load('hist-nobody', { legacyImported: true, status: 'DELIVERED' }));
    f.loads.push(load('hist-legless', { legacyImported: true, status: 'DELIVERED', pickupDriverId: 'drv-a', deliveryDriverId: 'drv-a' }));
    const p = planOwnAssetDrivers(f.loads, f.legs, drivers());
    expect(p.counts.LEGACY_IMPORTED).toBe(2);
    expect(p.report.some((r) => r.loadId.startsWith('hist-'))).toBe(false);
    expect(p.actions.some((a) => a.loadId.startsWith('hist-'))).toBe(false);
    expect(byClass(p, 'NO_DRIVER_ANYWHERE')).toEqual(['nobody']);
  });

  it('never plans a write to a driver, date, rate or stops field — the pay inputs', () => {
    const forbidden = ['pickupDriverId', 'deliveryDriverId', 'pickupAppt', 'deliveryAppt', 'rate', 'stops'];
    for (const action of plan().actions) {
      const written = JSON.stringify([action.item ?? {}, action.after ?? {}, action.before ?? {}]);
      for (const field of forbidden) expect(written).not.toContain(`"${field}"`);
    }
  });

  it('has nothing left to do once its own plan has been applied', () => {
    const f = fixtures();
    const first = planOwnAssetDrivers(f.loads, f.legs, drivers());
    const loads = f.loads.map((l) => ({ ...l }));
    const legs = f.legs.map((l) => ({ ...l }));
    for (const a of first.actions) {
      if (a.action === CREATE_LEG) {
        legs.push({ id: a.id, ...a.item });
        loads.find((l) => l.id === a.loadId).activeLoadCarrierId = a.id;
      } else {
        Object.assign(legs.find((l) => l.id === a.id), a.after);
      }
    }
    expect(planOwnAssetDrivers(loads, legs, drivers()).actions).toEqual([]);
  });

  it('writes the gap list as CSV with quoting', () => {
    const csv = csvOf([{ class: 'NO_DRIVER_ANYWHERE', severity: 'fix', pro: 'P1', customer: 'A, "B"', detail: 'x' }]);
    expect(csv.split('\n')[0]).toBe('class,severity,pro,shipmentNumber,loadId,status,pickupDate,customer,detail');
    expect(csv.split('\n')[1]).toBe('NO_DRIVER_ANYWHERE,fix,P1,,,,,"A, ""B""",x');
  });
});

describe('backfillOwnAssetDrivers — apply', () => {
  it('stamps the non-nullable createdBy/updatedBy on a created leg', async () => {
    const f = fixtures();
    const source = scopeSource({ Load: f.loads, LoadCarrier: f.legs, Driver: drivers(), Shipment: [] }, ['legless']);
    const p = buildOwnAssetDriversPlan({ source, environment: 'dev', suffix: DEV_TABLE_SUFFIX });
    const sent = [];
    const doc = { send: async (command) => { sent.push(command.input); return {}; } };
    await applyOwnAssetDriversPlan({ doc, plan: p, suffix: DEV_TABLE_SUFFIX });
    const put = sent.flatMap((i) => i.TransactItems ?? []).find((t) => t.Put)?.Put.Item;
    expect(put.createdBy).toBe('migration:backfillOwnAssetDrivers');
    expect(put.updatedBy).toBe('migration:backfillOwnAssetDrivers');
  });
});

describe('backfillOwnAssetDrivers — safety rails', () => {
  it('refuses the production tables before it reads anything', () => {
    expect(() => resolveTarget('5ucwdyvwivelbo4k4jomvrwel4-NONE')).toThrow(/production/i);
    expect(resolveTarget(undefined)).toEqual({ suffix: DEV_TABLE_SUFFIX, environment: 'dev' });
  });

  it('refuses to apply a plan whose source rows have moved', () => {
    const f = fixtures();
    const source = { Load: f.loads, LoadCarrier: f.legs, Driver: drivers(), Shipment: [] };
    const p = buildOwnAssetDriversPlan({ source, environment: 'dev', suffix: DEV_TABLE_SUFFIX });
    const ctx = { environment: 'dev', endpoint: p.endpoint };
    expect(() => validatePlan(p, { ...ctx, sourceRows: sourceRowsOf(source) })).not.toThrow();
    const moved = { ...source, Load: f.loads.map((l) => (l.id === 'legless' ? { ...l, deliveryDriverId: 'drv-b' } : l)) };
    expect(() => validatePlan(p, { ...ctx, sourceRows: sourceRowsOf(moved) })).toThrow(/fingerprint/i);
  });

  it('--only-load scopes the loads and their legs, and the plan to match', () => {
    const f = fixtures();
    const source = scopeSource({ Load: f.loads, LoadCarrier: f.legs, Driver: drivers(), Shipment: [] }, ['legless', 'unnamed']);
    expect(source.Load.map((l) => l.id)).toEqual(['legless', 'unnamed']);
    expect(source.LoadCarrier.map((l) => l.loadId)).toEqual(['unnamed']);
    const p = buildOwnAssetDriversPlan({ source, environment: 'dev', suffix: DEV_TABLE_SUFFIX });
    expect(p.actions.map((a) => a.action).sort()).toEqual([CREATE_LEG, FILL_LEG_NAME]);
  });
});
