import { describe, expect, it } from 'vitest';
import { planAssetsSubdivision } from './awAssetsSubdivision.mjs';

const shipment = (id, over = {}) => ({ id, number: id, revDivision: 'ASSETS', revSubdivision: null, revTagSource: 'RULE', ...over });
const load = (id, shipmentId) => ({ id, shipmentId, leg: 1 });
const leg = (loadId, driverId, status = 'ACTIVE') => ({ id: `lc-${loadId}`, loadId, driverId, status });
const drivers = [
  { id: 'local', fleetGroup: 'LOCAL' }, { id: 'oo', fleetGroup: 'OWNER_OPERATOR' }, { id: 'amz', fleetGroup: 'AMAZON' },
  { id: 'box', fleetGroup: 'BOX_TRUCK' }, { id: 'old', driverType: 'OWNER_OPERATOR' }, { id: 'co', fleetGroup: null, driverType: 'COMPANY' },
];

function plan(shipments, legs) {
  const loads = shipments.map((s) => load(`L-${s.id}`, s.id));
  return planAssetsSubdivision({ shipments, loads, legs: legs.map(([s, d, st]) => leg(`L-${s}`, d, st)), drivers })
    .map((p) => [p.shipment.id, p.subdivision, p.source]);
}

describe('planAssetsSubdivision', () => {
  it('gives each ASSETS shipment the subdivision of its driver', () => {
    expect(plan([shipment('a'), shipment('b'), shipment('c'), shipment('d'), shipment('e')], [['a', 'local'], ['b', 'oo'], ['c', 'amz'], ['d', 'box'], ['e', 'old']]))
      .toEqual([['a', 'LOCAL', 'RULE'], ['b', 'OWNER_OPERATOR', 'RULE'], ['c', 'OWNER_OPERATOR', 'RULE'], ['d', 'BOX_TRUCK', 'RULE'], ['e', 'OWNER_OPERATOR', 'RULE']]);
  });
  it('leaves alone: a subdivision already set, non-ASSETS, voided, no driver, a retired leg, a company driver', () => {
    expect(plan(
      [shipment('set', { revSubdivision: 'LOCAL' }), shipment('bro', { revDivision: 'BROKERAGE' }), shipment('void', { voidedAt: 'x' }), shipment('nodrv'), shipment('retired'), shipment('co')],
      [['set', 'box'], ['bro', 'box'], ['void', 'box'], ['retired', 'box', 'RETIRED'], ['co', 'co']],
    )).toEqual([]);
  });
  it('never touches a hand tag, except the intake stamp on a TENDER shipment, which becomes INTAKE', () => {
    expect(plan([shipment('hand', { revTagSource: 'HAND' }), shipment('stamp', { revTagSource: 'HAND', source: 'TENDER' }), shipment('held', { revTagSource: 'INTAKE' })], [['hand', 'local'], ['stamp', 'local'], ['held', 'box']]))
      .toEqual([['stamp', 'LOCAL', 'INTAKE'], ['held', 'BOX_TRUCK', 'INTAKE']]);
  });
});
