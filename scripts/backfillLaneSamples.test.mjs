import { describe, it, expect } from 'vitest';
import {
  LEGACY_CLASS_SKIPPED,
  applyLaneSamplePlan,
  buildLaneSamplePlan,
  laneKey3For,
  laneKeyFor,
  laneSampleFacts,
  legacyRateCents,
  materialOf,
  planLaneSamples,
  proveLegacyRateUnit,
  resolveTarget,
  reviewText,
  sourceRowsOf,
} from './backfillLaneSamples.mjs';
import { validatePlan } from './lib/tmsPlan.mjs';
import { laneKeyFor as tsLaneKeyFor, laneKey3For as tsLaneKey3For } from '../src/lib/laneKey.ts';

const NOW = '2026-04-01T12:00:00.000Z';

/**
 * Isolated fixtures: one Load per branch the migration can take, so a change in the
 * classifier shows up here rather than on a dispatcher's Historical Rates panel.
 * Nothing here talks to AWS.
 */
const stops = (from, to, { appt = '2026-03-04T08:00:00.000Z', zips } = {}) => [
  { id: 'pu', type: 'pickup', city: from, appt: '2026-03-02T08:00:00.000Z', sequence: 0, ...(zips ? { address: { zip: zips[0] } } : {}) },
  { id: 'de', type: 'delivery', city: to, appt, sequence: 1, ...(zips ? { address: { zip: zips[1] } } : {}) },
];

const financials = (loadId, revenueCents, extra = {}) => ({
  id: loadId,
  loadId,
  shipmentId: 'shp-1',
  customerRateCents: revenueCents,
  revenueCents,
  carrierRateCents: Math.round(revenueCents * 0.8),
  costCents: Math.round(revenueCents * 0.8),
  profitCents: revenueCents - Math.round(revenueCents * 0.8),
  marginBps: 2000,
  ...extra,
});

/** Ten loads carrying both a legacy rate and financials — the unit prover's evidence. */
function comparableLoads(unit) {
  const loads = [];
  const fins = [];
  for (let i = 0; i < 10; i += 1) {
    const id = `cmp-${i}`;
    const revenueCents = 150_000 + i * 10_000;
    loads.push({
      id,
      status: 'DELIVERED',
      shipmentId: 'shp-1',
      orderId: 'ord-1',
      miles: 400 + i,
      rate: unit === 'dollars' ? revenueCents / 100 : revenueCents,
      stops: stops('Joliet, IL', `Peoria, IL`),
    });
    fins.push(financials(id, revenueCents));
  }
  return { loads, fins };
}

function baseSource({ unit = 'dollars', comparables = 10 } = {}) {
  const cmp = comparableLoads(unit);
  const cmpLoads = cmp.loads.slice(0, comparables);
  const cmpFins = cmp.fins.slice(0, comparables);

  return {
    Shipment: [
      {
        id: 'shp-1', number: 'S10001', customerId: 'cust-1', customerName: 'Acme Foods',
        mode: 'FTL', status: 'DELIVERED',
        // Step R: the dashboard's facts live on the shipment and its mirrored load.
        revDivision: 'BROKERAGE', revSubdivision: null, salesRepId: 'rep-sub-1',
        datPostedAt: '2026-03-01T09:00:00.000Z',
      },
    ],
    Order: [
      { id: 'ord-1', shipmentId: 'shp-1', customerId: 'cust-1', customerName: 'Acme Foods', mode: 'FTL', rateType: 'SPOT', equipmentType: 'DRY_VAN', customerRepId: 'rep@bcatcorp.com', invoiceId: 'inv-1', invoicedAt: '2026-04-02T12:00:00.000Z' },
    ],
    LoadCarrier: [
      { id: 'lc-1', loadId: 'tms-delivered', kind: 'CARRIER', status: 'ACTIVE', carrierId: 'car-1', carrierName: 'Blue Line Trucking', carrierRepId: 'carrier.rep@bcatcorp.com' },
    ],
    Load: [
      // BACKFILL: delivered, priced, lane on both ends. `stops` arrives as the AWSJSON
      // string the table actually holds.
      {
        id: 'tms-delivered',
        status: 'DELIVERED',
        shipmentId: 'shp-1',
        orderId: 'ord-1',
        activeLoadCarrierId: 'lc-1',
        miles: 132,
        divisionKey: 'BROKERAGE',
        equipmentType: 'REEFER',
        revDivision: 'BROKERAGE',
        salesRepId: 'rep-sub-1',
        trackingProvider: 'LINK',
        deliveredAt: '2026-03-04T15:00:00.000Z',
        stops: JSON.stringify(stops('Chicago, IL', 'Danville, IL', { zips: ['60601', '61832-1234'] })),
      },
      // Still moving: priced, but there is no rate history in a load that has not landed.
      { id: 'tms-moving', status: 'IN_TRANSIT', shipmentId: 'shp-1', orderId: 'ord-1', stops: stops('Chicago, IL', 'Danville, IL') },
      // Delivered inside the TMS and never priced: reported, never sampled from the legacy rate.
      { id: 'tms-unpriced', status: 'DELIVERED', shipmentId: 'shp-1', orderId: 'ord-1', stops: stops('Chicago, IL', 'Danville, IL') },
      // Priced and delivered, but "Springfield" is nine cities.
      { id: 'tms-no-state', status: 'DELIVERED', shipmentId: 'shp-1', orderId: 'ord-1', stops: stops('Springfield', 'Danville, IL') },
      // LEGACY_LOAD: no TMS status, no financials, a lane, and a rate.
      {
        id: 'legacy-run',
        rate: 1850,
        miles: 210,
        customer: 'Midwest Paper',
        originCity: 'St. Louis, MO',
        destinationCity: 'Decatur, IL',
        pickupAppt: '2026-03-10T07:00:00.000Z',
        deliveryAppt: '2026-03-11T13:00:00.000Z',
      },
      // Legacy with no rate: nothing to learn, nothing invented.
      {
        id: 'legacy-no-rate',
        originCity: 'St. Louis, MO',
        destinationCity: 'Decatur, IL',
        pickupAppt: '2026-03-10T07:00:00.000Z',
        deliveryAppt: '2026-03-11T13:00:00.000Z',
      },
      // Legacy with a rate and nothing that says when it ran: "today" would move the
      // row on every re-run, so it is left alone.
      { id: 'legacy-no-date', rate: 1200, originCity: 'St. Louis, MO', destinationCity: 'Decatur, IL', pickupAppt: '', deliveryAppt: '' },
      // Legacy booked for next month: a legacy row has no status, so the date is the
      // only thing that says whether it has run.
      {
        id: 'legacy-future',
        rate: 1500,
        originCity: 'St. Louis, MO',
        destinationCity: 'Decatur, IL',
        pickupAppt: '2026-05-09T07:00:00.000Z',
        deliveryAppt: '2026-05-10T13:00:00.000Z',
      },
      ...cmpLoads,
    ],
    LoadFinancials: [financials('tms-delivered', 245_000), financials('tms-no-state', 100_000), ...cmpFins],
    Customer: [{ id: 'cust-1', name: 'Acme Foods', teamKey: 'EAST' }],
    // Step R facts: two scheduled check calls (one answered inside the grace, one
    // answered an hour late), and the rows where the rule this script used to apply
    // and the rule the live Lambda applies give different answers — a dispatcher-typed
    // ping carrying a position, a POD still waiting for review, and a POD filed
    // against the other leg of the same shipment.
    LoadCheckCall: [
      { id: 'cc-1', loadId: 'tms-delivered', at: '2026-03-02T08:00:00.000Z', type: 'DISPATCH', nextCheckCallAt: '2026-03-02T14:00:00.000Z' },
      { id: 'cc-manual', loadId: 'tms-delivered', at: '2026-03-02T09:30:00.000Z', type: 'TRACKING_PING', source: 'MANUAL', lat: 41.6, lng: -87.9 },
      { id: 'cc-2', loadId: 'tms-delivered', at: '2026-03-02T14:10:00.000Z', type: 'TRACKING_PING', source: 'LINK', lat: 41.5, lng: -88.1, nextCheckCallAt: '2026-03-03T02:00:00.000Z' },
      { id: 'cc-3', loadId: 'tms-delivered', at: '2026-03-03T03:00:00.000Z', type: 'LOCATION_UPDATE', source: 'MOTIVE', lat: 40.1, lng: -88.3 },
    ],
    ShipmentDocument: [
      { id: 'doc-bol', shipmentId: 'shp-1', type: 'BOL', status: 'ACTIVE', createdAt: '2026-03-02T09:00:00.000Z' },
      { id: 'doc-pod-void', shipmentId: 'shp-1', type: 'POD', status: 'VOID', createdAt: '2026-03-04T18:00:00.000Z' },
      { id: 'doc-pod-other-leg', shipmentId: 'shp-1', loadId: 'tms-moving', type: 'POD', status: 'ACTIVE', reviewStatus: 'APPROVED', uploadedAt: '2026-03-03T10:00:00.000Z', createdAt: '2026-03-03T10:00:00.000Z' },
      { id: 'doc-pod-pending', shipmentId: 'shp-1', loadId: 'tms-delivered', type: 'POD', status: 'ACTIVE', reviewStatus: 'PENDING', uploadedAt: '2026-03-04T19:00:00.000Z', createdAt: '2026-03-04T19:00:00.000Z' },
      { id: 'doc-pod', shipmentId: 'shp-1', loadId: 'tms-delivered', type: 'POD', status: 'ACTIVE', reviewStatus: 'APPROVED', uploadedAt: '2026-03-05T10:00:00.000Z', createdAt: '2026-03-05T11:00:00.000Z' },
      { id: 'doc-pod-2', shipmentId: 'shp-1', loadId: 'tms-delivered', type: 'POD', status: 'ACTIVE', reviewStatus: 'APPROVED', uploadedAt: '2026-03-06T10:00:00.000Z', createdAt: '2026-03-06T10:00:00.000Z' },
    ],
    TmsSettings: [{ id: 'default', checkCallGraceMinutes: 20 }],
    LaneRateSample: [],
  };
}

const actionFor = (planned, loadId) => planned.actions.find((a) => a.loadId === loadId);

describe('backfillLaneSamples — which loads become lane rate samples', () => {
  it('samples a delivered, priced load with the money off its financials row', () => {
    const planned = planLaneSamples(baseSource(), NOW);
    const action = actionFor(planned, 'tms-delivered');

    expect(action.source).toBe('BACKFILL');
    expect(action.id).toBe('lrs:tms-delivered');
    expect(action.item).toMatchObject({
      laneKey: 'CHICAGO|IL>DANVILLE|IL',
      laneKey3: '606>618',
      date: '2026-03-04',
      shipmentId: 'shp-1',
      shipmentNumber: 'S10001',
      customerName: 'Acme Foods',
      carrierName: 'Blue Line Trucking',
      assignmentKind: 'CARRIER',
      mode: 'FTL',
      rateType: 'SPOT',
      equipmentType: 'REEFER',
      miles: 132,
      customerRateCents: 245_000,
      revenueCents: 245_000,
      carrierRateCents: 196_000,
      costCents: 196_000,
      profitCents: 49_000,
      marginBps: 2000,
      loadStatus: 'DELIVERED',
      source: 'BACKFILL',
      version: 1,
    });
  });

  it('writes no NULL attributes, because a NULL on laneKey3 is a type mismatch in the index', () => {
    const planned = planLaneSamples(baseSource(), NOW);
    for (const action of planned.actions) {
      for (const [field, value] of Object.entries(action.item)) {
        expect(value, `${action.id}.${field}`).not.toBeNull();
      }
    }
    // The legacy lane has no ZIPs at all, so laneKey3 is simply absent.
    expect(actionFor(planned, 'legacy-run').item).not.toHaveProperty('laneKey3');
  });

  it('reports what it will not sample instead of guessing it', () => {
    const planned = planLaneSamples(baseSource(), NOW);
    const reasons = Object.fromEntries(planned.skipped.map((s) => [s.loadId, s.reason]));

    expect(reasons['tms-moving']).toBe('belowDelivered');
    expect(reasons['tms-unpriced']).toBe('noFinancials');
    expect(reasons['tms-no-state']).toBe('noLaneKey');
    expect(reasons['legacy-no-rate']).toBe('noLegacyRate');
    expect(reasons['legacy-no-date']).toBe('noDate');
    expect(reasons['legacy-future']).toBe('belowDelivered');
    expect(planned.byReason).toMatchObject({ belowDelivered: 2, noFinancials: 1, noLaneKey: 1, noLegacyRate: 1, noDate: 1 });
  });

  it('never overwrites a sample the live load already wrote', () => {
    const source = baseSource();
    source.LaneRateSample = [
      { id: 'lrs:tms-delivered', laneKey: 'CHICAGO|IL>DANVILLE|IL', loadId: 'tms-delivered', source: 'LOAD', revenueCents: 260_000, date: '2026-03-04' },
    ];
    const planned = planLaneSamples(source, NOW);

    expect(actionFor(planned, 'tms-delivered')).toBeUndefined();
    expect(planned.skipped.find((s) => s.loadId === 'tms-delivered').reason).toBe('liveSampleWins');
    expect(planned.reviewables[0].kind).toBe('LIVE_SAMPLE_DIFFERS');
  });
});

describe('backfillLaneSamples — the legacy rate unit, proved or not used', () => {
  it('converts the legacy rate once ten comparable loads say it is whole dollars', () => {
    const planned = planLaneSamples(baseSource({ unit: 'dollars' }), NOW);

    expect(planned.legacyUnit.unit).toBe('dollars');
    expect(actionFor(planned, 'legacy-run').item).toMatchObject({
      source: 'LEGACY_LOAD',
      laneKey: 'ST LOUIS|MO>DECATUR|IL',
      date: '2026-03-11',
      customerRateCents: 185_000,
      revenueCents: 185_000,
      assignmentKind: 'OWN_ASSET',
    });
    // Own fleet: what the truck cost is a settlement, not a carrier rate.
    expect(actionFor(planned, 'legacy-run').item).not.toHaveProperty('carrierRateCents');
    expect(actionFor(planned, 'legacy-run').item).not.toHaveProperty('profitCents');
  });

  it('uses the legacy rate as-is when the comparable loads say it is already cents', () => {
    const planned = planLaneSamples(baseSource({ unit: 'cents' }), NOW);

    expect(planned.legacyUnit.unit).toBe('cents');
    expect(actionFor(planned, 'legacy-run').item).toMatchObject({ revenueCents: 1850, customerRateCents: 1850 });
  });

  it('skips the whole LEGACY_LOAD class when fewer than ten loads can prove the unit', () => {
    const planned = planLaneSamples(baseSource({ unit: 'dollars', comparables: 4 }), NOW);

    expect(planned.legacyUnit.unit).toBeNull();
    expect(planned.legacyUnit.reason).toContain('only 4 load(s) carry both');
    expect(planned.bySource.LEGACY_LOAD).toBe(0);
    expect(planned.skipped.find((s) => s.loadId === 'legacy-run').reason).toBe('legacyRateUnitUnproven');
    // The BACKFILL class is unaffected: those rows have their own money.
    expect(planned.bySource.BACKFILL).toBeGreaterThan(0);
  });

  it('refuses a sample that matches both units, and says so in the plan and the printout', () => {
    const source = baseSource({ unit: 'dollars' });
    // rate 1, revenue 100: `rate * 100` and `rate` are both within a dollar of it.
    for (let i = 0; i < 10; i += 1) {
      const load = source.Load.find((l) => l.id === `cmp-${i}`);
      load.rate = 1;
      const fin = source.LoadFinancials.find((f) => f.loadId === `cmp-${i}`);
      fin.revenueCents = 100;
    }
    const plan = buildLaneSamplePlan({ source, environment: 'dev', suffix: 'dev-suffix', nowIso: NOW });

    expect(plan.summary.legacyRate.unit).toBeNull();
    expect(plan.summary.legacyRate.classSkipped).toBe(true);
    expect(plan.summary.legacyRate.matchingBoth).toBe(10);
    expect(plan.actions.some((a) => a.source === 'LEGACY_LOAD')).toBe(false);

    const printed = reviewText(plan);
    expect(printed).toContain(
      `${LEGACY_CLASS_SKIPPED}: none of the 10 comparable load(s) decide the unit: 10 match both dollars and cents and 0 match neither.`
    );
    expect(printed).toContain('money had to be guessed moves every future quote on that lane, so none is written.');
  });

  it('refuses a sample that disagrees with itself', () => {
    const comparables = [
      ...Array.from({ length: 6 }, (_, i) => ({ loadId: `d${i}`, rate: 1500 + i, revenueCents: (1500 + i) * 100 })),
      ...Array.from({ length: 6 }, (_, i) => ({ loadId: `c${i}`, rate: 190_000 + i, revenueCents: 190_000 + i })),
    ];
    const proof = proveLegacyRateUnit(comparables);

    expect(proof.unit).toBeNull();
    expect(proof.reason).toBe(
      '6 load(s) match whole dollars and 6 match cents across 12 comparable load(s); the sample disagrees with itself'
    );
    expect(legacyRateCents(1850, proof.unit)).toBeNull();
  });

  it('refuses when most comparable loads match neither unit', () => {
    const proof = proveLegacyRateUnit([
      ...Array.from({ length: 10 }, (_, i) => ({ loadId: `d${i}`, rate: 1500 + i, revenueCents: (1500 + i) * 100 })),
      ...Array.from({ length: 10 }, (_, i) => ({ loadId: `x${i}`, rate: 42 + i, revenueCents: 777_000 + i })),
    ]);

    expect(proof.unit).toBeNull();
    expect(proof.reason).toContain('Load.rate is not reliably the revenue');
  });
});

describe('backfillLaneSamples — the plan protocol', () => {
  it('has nothing left to do once its own plan has been applied', () => {
    const source = baseSource();
    const first = buildLaneSamplePlan({ source, environment: 'dev', suffix: 'dev-suffix', nowIso: NOW });
    expect(first.actions.length).toBeGreaterThan(0);

    // What the apply step leaves behind, item for item.
    const applied = { ...source, LaneRateSample: first.actions.map((a) => ({ ...a.item })) };
    const second = buildLaneSamplePlan({
      source: applied,
      environment: 'dev',
      suffix: 'dev-suffix',
      nowIso: '2026-04-02T09:30:00.000Z',
    });

    expect(second.actions).toHaveLength(0);
    expect(second.summary.alreadyCurrent).toBe(first.actions.length);
    // A row re-sampled a day later is the same row: only `sampledAt` moved.
    expect(materialOf(applied.LaneRateSample[0])).toBe(materialOf(first.actions[0].item));
  });

  it('rejects a plan whose source rows have moved underneath it', () => {
    const source = baseSource();
    const plan = buildLaneSamplePlan({ source, environment: 'dev', suffix: 'dev-suffix', nowIso: NOW });
    const current = { environment: 'dev', endpoint: plan.endpoint, sourceRows: sourceRowsOf(source) };

    expect(() => validatePlan(plan, current)).not.toThrow();

    source.LoadFinancials.find((f) => f.loadId === 'tms-delivered').revenueCents = 999_000;
    expect(() => validatePlan(plan, { ...current, sourceRows: sourceRowsOf(source) })).toThrow(/fingerprint mismatch/i);
  });

  it('refuses the production tables before it reads anything', () => {
    expect(() => resolveTarget('tms-5ucwdyvwivelbo4k4jomvrwel4-NONE')).toThrow(/production/i);
    expect(resolveTarget('nc3jsnxdmjhkpequimypiatkma-NONE')).toEqual({
      suffix: 'nc3jsnxdmjhkpequimypiatkma-NONE',
      environment: 'dev',
    });
  });

  it('refuses to write to production even if a plan is handed to it directly', async () => {
    const sent = [];
    const doc = { send: async (cmd) => { sent.push(cmd); return {}; } };
    const plan = buildLaneSamplePlan({ source: baseSource(), environment: 'dev', suffix: 'dev-suffix', nowIso: NOW });

    await expect(
      applyLaneSamplePlan({ doc, plan, suffix: 'tms-5ucwdyvwivelbo4k4jomvrwel4-NONE' })
    ).rejects.toThrow(/production/i);
    expect(sent).toHaveLength(0);
  });

  it('only ever puts LaneRateSample and AuditLog rows, and deletes nothing', async () => {
    const sent = [];
    const doc = { send: async (cmd) => { sent.push(cmd); return {}; } };
    const plan = buildLaneSamplePlan({ source: baseSource(), environment: 'dev', suffix: 'dev-suffix', nowIso: NOW });

    const report = await applyLaneSamplePlan({ doc, plan, suffix: 'dev-suffix' });

    expect(report.written).toBe(plan.actions.length);
    expect(report.failures).toHaveLength(0);
    expect(report.bySource.LEGACY_LOAD).toBe(1);
    expect(sent.every((cmd) => cmd.constructor.name === 'PutCommand')).toBe(true);
    const tables = new Set(sent.map((cmd) => cmd.input.TableName));
    expect([...tables].sort()).toEqual(['AuditLog-dev-suffix', 'LaneRateSample-dev-suffix']);

    const samplePut = sent.find((cmd) => cmd.input.TableName === 'LaneRateSample-dev-suffix');
    expect(samplePut.input.ConditionExpression).toBe(
      'attribute_not_exists(id) OR (#source <> :live AND sampledAt < :sampledAt)'
    );
    expect(samplePut.input.ExpressionAttributeValues[':live']).toBe('LOAD');
  });

  it('counts a replayed plan as already current instead of writing it again', async () => {
    const doc = {
      send: async (cmd) => {
        if (cmd.input.TableName === 'LaneRateSample-dev-suffix') {
          const err = new Error('The conditional request failed');
          err.name = 'ConditionalCheckFailedException';
          throw err;
        }
        return {};
      },
    };
    const plan = buildLaneSamplePlan({ source: baseSource(), environment: 'dev', suffix: 'dev-suffix', nowIso: NOW });

    const report = await applyLaneSamplePlan({ doc, plan, suffix: 'dev-suffix' });

    expect(report.written).toBe(0);
    expect(report.alreadyCurrent).toBe(plan.actions.length);
    expect(report.failures).toHaveLength(0);
  });

  it('prints the per-source and per-reason counts a reviewer decides on', () => {
    const plan = buildLaneSamplePlan({ source: baseSource(), environment: 'dev', suffix: 'dev-suffix', nowIso: NOW });
    const printed = reviewText(plan);

    expect(printed).toContain('BACKFILL: 11');
    expect(printed).toContain('LEGACY_LOAD: 1');
    expect(printed).toContain('noFinancials: 1');
    expect(printed).toContain('noLaneKey: 1');
    expect(printed).toContain('belowDelivered: 2');
    expect(printed).toContain('Legacy Load.rate unit: dollars');
  });
});

/**
 * The script cannot import src/lib/laneKey.ts — it runs under plain Node — so the key
 * normalisation is mirrored in the .mjs. These cases pin the mirror to the original:
 * a rule that changes on one side and not the other would split one lane into two,
 * silently, and every history panel would go quiet.
 */
describe('backfillLaneSamples — the lane key mirrors src/lib/laneKey.ts', () => {
  const cases = [
    ['punctuation and case', stops('St. Louis, MO', 'Danville, IL')],
    ['already normalised', stops('ST LOUIS MO', 'DANVILLE IL')],
    ['no state on the pickup', stops('Springfield', 'Danville, IL')],
    ['no state on the delivery', stops('Chicago, IL', 'Springfield')],
    ['spelled-out state is not a state code', stops('Chicago, Illinois', 'Danville, IL')],
    ['address snapshot beats the city string', [
      { id: 'pu', type: 'pickup', city: 'Wrong, XX', address: { city: 'Chicago', state: 'IL', zip: '60601' }, sequence: 0 },
      { id: 'de', type: 'delivery', city: 'Also Wrong, XX', address: { city: 'Danville', state: 'il', zip: '61832' }, sequence: 1 },
    ]],
    ['middle stops are route, not lane', [
      { id: 'pu', type: 'pickup', city: 'Chicago, IL', sequence: 0, address: { zip: '60601' } },
      { id: 'mid', type: 'delivery', city: 'Joliet, IL', sequence: 1, address: { zip: '60431' } },
      { id: 'de', type: 'delivery', city: 'Danville, IL', sequence: 2, address: { zip: '61832' } },
    ]],
    ['out of sequence order', [
      { id: 'de', type: 'delivery', city: 'Danville, IL', sequence: 5, address: { zip: '61832' } },
      { id: 'pu', type: 'pickup', city: 'Chicago, IL', sequence: 1, address: { zip: '60601-0001' } },
    ]],
    ['no pickup type at all', [
      { id: 'a', city: 'Chicago, IL', sequence: 0, address: { zip: '60601' } },
      { id: 'b', city: 'Danville, IL', sequence: 1, address: { zip: '61832' } },
    ]],
    ['a single stop is not a lane', [{ id: 'pu', type: 'pickup', city: 'Chicago, IL', sequence: 0 }]],
    ['empty', []],
    ['zip+4 and a short zip', [
      { id: 'pu', type: 'pickup', city: 'Chicago, IL', sequence: 0, address: { zip: '60601-1234' } },
      { id: 'de', type: 'delivery', city: 'Danville, IL', sequence: 1, address: { zip: '6183' } },
    ]],
  ];

  for (const [name, table] of cases) {
    it(`agrees with the TypeScript on ${name}`, () => {
      expect(laneKeyFor(table)).toBe(tsLaneKeyFor(table));
      expect(laneKey3For(table)).toBe(tsLaneKey3For(table));
    });
  }

  it('is not trivially agreeing because both sides return null', () => {
    expect(laneKeyFor(stops('St. Louis, MO', 'Danville, IL'))).toBe('ST LOUIS|MO>DANVILLE|IL');
    expect(laneKey3For(stops('Chicago, IL', 'Danville, IL', { zips: ['60601', '61832-1234'] }))).toBe('606>618');
  });
});

describe('backfillLaneSamples — the Step I reporting fields', () => {
  it('stamps the month, both reps, the team and the invoice on a sample', () => {
    const planned = planLaneSamples(baseSource(), NOW);
    const { item } = actionFor(planned, 'tms-delivered');
    expect(item.sampleMonth).toBe(item.date.slice(0, 7));
    expect(item.customerRepId).toBe('rep@bcatcorp.com');
    expect(item.carrierRepId).toBe('carrier.rep@bcatcorp.com');
    expect(item.teamKey).toBe('EAST');
    expect(item.invoiceId).toBe('inv-1');
    expect(item.invoiceMonth).toBe('2026-04');
  });

  it('refreshes a Step H sample that predates those fields rather than calling it current', () => {
    const source = baseSource();
    const first = planLaneSamples(source, NOW);
    const { item } = actionFor(first, 'tms-delivered');
    // A Step H row: every field it knew about, none of the Step I ones.
    const stale = { ...item };
    for (const field of ['sampleMonth', 'customerRepId', 'carrierRepId', 'teamKey', 'invoiceId', 'invoiceMonth']) {
      delete stale[field];
    }
    const replanned = planLaneSamples({ ...source, LaneRateSample: [stale] }, NOW);
    expect(actionFor(replanned, 'tms-delivered')).toBeDefined();
    expect(replanned.alreadyCurrent).toBe(0);

    // …and once refreshed, a third pass has nothing left to do.
    const settled = planLaneSamples({ ...source, LaneRateSample: [item] }, NOW);
    expect(actionFor(settled, 'tms-delivered')).toBeUndefined();
    expect(settled.alreadyCurrent).toBe(1);
  });

  it('leaves the reporting fields absent rather than null when nobody is named', () => {
    const source = baseSource();
    source.Order = [{ id: 'ord-1', shipmentId: 'shp-1', customerId: 'cust-1', customerName: 'Acme Foods', mode: 'FTL' }];
    source.LoadCarrier = [{ id: 'lc-1', loadId: 'tms-delivered', kind: 'CARRIER', status: 'ACTIVE', carrierId: 'car-1' }];
    source.Customer = [];
    const { item } = actionFor(planLaneSamples(source, NOW), 'tms-delivered');
    expect(item.sampleMonth).toBeTruthy();
    expect('customerRepId' in item).toBe(false);
    expect('teamKey' in item).toBe(false);
    expect('invoiceMonth' in item).toBe(false);
  });
});

describe('backfillLaneSamples — the Step R dashboard facts', () => {
  it('stamps the division, the rep, the delivery, the tracking and the POD onto a sample', () => {
    const { item } = actionFor(planLaneSamples(baseSource(), NOW), 'tms-delivered');

    expect(item.revDivision).toBe('BROKERAGE');
    expect(item.salesRepId).toBe('rep-sub-1');
    expect(item.deliveredAt).toBe('2026-03-04T15:00:00.000Z');
    expect(item.trackingProvider).toBe('LINK');
    expect(item.datPostedAt).toBe('2026-03-01T09:00:00.000Z');
    // The first ping the truck sent, not the dispatch note before it.
    expect(item.firstPingAt).toBe('2026-03-02T14:10:00.000Z');
    // The earliest POD we actually have; the voided one and the BOL are not PODs.
    expect(item.podReceivedAt).toBe('2026-03-05T10:00:00.000Z');
    // A subsidiary nobody assigned stays absent rather than being written as null.
    expect('revSubdivision' in item).toBe(false);
  });

  it('derives the ping and the POD the way the live writer does, not the way it used to', () => {
    const { item } = actionFor(planLaneSamples(baseSource(), NOW), 'tms-delivered');

    // `cc-manual` is a TRACKING_PING carrying lat/lng that a dispatcher typed at
    // 09:30. The rule this script applied before — any TRACKING_PING, or any row
    // with a position — called it the first ping. `laneSamples.ts` counts
    // LINK/DRIVER_APP/MOTIVE only, so the LINK ping at 14:10 is the first one.
    expect(item.firstPingAt).toBe('2026-03-02T14:10:00.000Z');
    // The earliest ACTIVE POD on the shipment by `createdAt` — the old rule — is the
    // one filed against the other leg (03-03 10:00), and after it the portal upload
    // still waiting for review (03-04 19:00). The live rule scopes to this load and
    // drops unreviewed uploads, and times from `uploadedAt` rather than `createdAt`,
    // which is 10:00 on 03-05 and not 11:00.
    expect(item.podReceivedAt).toBe('2026-03-05T10:00:00.000Z');
  });

  it('counts a scheduled call as met only when a later call lands inside the grace', () => {
    const { item } = actionFor(planLaneSamples(baseSource(), NOW), 'tms-delivered');
    // Two calls scheduled a next one: 14:00 answered at 14:10 (grace 20), and
    // 02:00 answered an hour late.
    expect(item.checkCallsDue).toBe(2);
    expect(item.checkCallsMet).toBe(1);
  });

  it('falls back to the notifier default grace when the org never set one', () => {
    const calls = [
      { id: 'c1', at: '2026-03-02T08:00:00.000Z', nextCheckCallAt: '2026-03-02T14:00:00.000Z' },
      { id: 'c2', at: '2026-03-02T14:18:00.000Z' },
    ];
    // 18 minutes late is met at a 20-minute grace and missed at the 15-minute default.
    expect(laneSampleFacts({ load: { id: 'l' }, checkCalls: calls, graceMinutes: 20 })).toMatchObject({ checkCallsDue: 1, checkCallsMet: 1 });
    expect(laneSampleFacts({ load: { id: 'l' }, checkCalls: calls })).toMatchObject({ checkCallsDue: 1, checkCallsMet: 0 });
  });

  it('counts no dues on a load nobody ever scheduled a call for', () => {
    const facts = laneSampleFacts({
      load: { id: 'l' },
      checkCalls: [{ id: 'c1', at: '2026-03-02T08:00:00.000Z', type: 'NOTE' }],
    });
    expect(facts).toMatchObject({ checkCallsDue: 0, checkCallsMet: 0, firstPingAt: null });
  });

  it('re-plans a Step I sample that predates the facts, and settles on the next pass', () => {
    const source = baseSource();
    const { item } = actionFor(planLaneSamples(source, NOW), 'tms-delivered');
    const stale = { ...item };
    for (const field of ['revDivision', 'salesRepId', 'deliveredAt', 'podReceivedAt', 'checkCallsDue', 'checkCallsMet']) {
      delete stale[field];
    }

    const replanned = planLaneSamples({ ...source, LaneRateSample: [stale] }, NOW);
    expect(actionFor(replanned, 'tms-delivered')).toBeDefined();

    const settled = planLaneSamples({ ...source, LaneRateSample: [item] }, NOW);
    expect(actionFor(settled, 'tms-delivered')).toBeUndefined();
    expect(settled.alreadyCurrent).toBe(1);
  });

  it('--refresh carries the facts onto a live sample and leaves its money alone', () => {
    const source = baseSource();
    const { item } = actionFor(planLaneSamples(source, NOW), 'tms-delivered');
    // What the live Lambda wrote: its own price, none of the Step R facts.
    const live = { ...item, source: 'LOAD', revenueCents: 999_999, sampledAt: '2026-03-20T00:00:00.000Z' };
    for (const field of ['revDivision', 'salesRepId', 'deliveredAt', 'podReceivedAt', 'trackingProvider', 'firstPingAt', 'datPostedAt', 'checkCallsDue', 'checkCallsMet']) {
      delete live[field];
    }
    const withLive = { ...source, LaneRateSample: [live] };

    const left = planLaneSamples(withLive, NOW);
    expect(actionFor(left, 'tms-delivered')).toBeUndefined();
    expect(left.reviewables[0].reason).toMatch(/--refresh/);

    const refreshed = planLaneSamples(withLive, NOW, { refreshLive: true });
    const patch = refreshed.actions.find((a) => a.action === 'PATCH_LANE_SAMPLE_FACTS');
    expect(refreshed.factsPatched).toBe(1);
    expect(patch.sampledAt).toBe('2026-03-20T00:00:00.000Z');
    expect(patch.facts).toMatchObject({ revDivision: 'BROKERAGE', checkCallsDue: 2, checkCallsMet: 1 });
    expect(patch.facts).not.toHaveProperty('revenueCents');

    // Once the facts are on the live row, a second --refresh plan has nothing to do.
    const patched = { ...live, ...patch.facts };
    const second = planLaneSamples({ ...source, LaneRateSample: [patched] }, NOW, { refreshLive: true });
    expect(second.actions.some((a) => a.action === 'PATCH_LANE_SAMPLE_FACTS')).toBe(false);
    expect(second.factsPatched).toBe(0);
  });

  it('applies a facts patch as an update that touches only the fact columns', async () => {
    const source = baseSource();
    const { item } = actionFor(planLaneSamples(source, NOW), 'tms-delivered');
    const live = { ...item, source: 'LOAD', revenueCents: 999_999, sampledAt: '2026-03-20T00:00:00.000Z' };
    delete live.revDivision;
    delete live.checkCallsDue;

    const plan = buildLaneSamplePlan({
      source: { ...source, LaneRateSample: [live] },
      environment: 'dev',
      suffix: 'nc3jsnxdmjhkpequimypiatkma-NONE',
      nowIso: NOW,
      refreshLive: true,
    });

    const sent = [];
    const doc = { send: async (cmd) => { sent.push(cmd); return {}; } };
    const report = await applyLaneSamplePlan({ doc, plan, suffix: 'nc3jsnxdmjhkpequimypiatkma-NONE' });

    expect(report.factsPatched).toBe(1);
    // The live row is patched, never re-put: no PUT carries its id.
    expect(sent.some((c) => c.input.Item?.id === 'lrs:tms-delivered')).toBe(false);
    const update = sent.find((c) => c.input.UpdateExpression);
    expect(update.input.Key).toEqual({ id: 'lrs:tms-delivered' });
    expect(update.input.ConditionExpression).toContain('sampledAt = :sampledAt');
    expect(update.input.UpdateExpression).toMatch(/#revDivision = :revDivision/);
    expect(update.input.UpdateExpression).not.toMatch(/revenueCents/);
  });

  it('clears a fact that went null with a REMOVE, and then stops planning the row', async () => {
    const source = baseSource();
    const { item } = actionFor(planLaneSamples(source, NOW), 'tms-delivered');
    // The live row carries a subdivision nothing on the freight says any more: the
    // only difference between the two is a fact that has gone null.
    const live = { ...item, source: 'LOAD', sampledAt: '2026-03-20T00:00:00.000Z', revSubdivision: 'BOX_TRUCK' };

    const plan = buildLaneSamplePlan({
      source: { ...source, LaneRateSample: [live] },
      environment: 'dev',
      suffix: 'nc3jsnxdmjhkpequimypiatkma-NONE',
      nowIso: NOW,
      refreshLive: true,
    });
    const patch = plan.actions.find((a) => a.action === 'PATCH_LANE_SAMPLE_FACTS');
    expect(patch.clears).toEqual(['revSubdivision']);
    expect(patch.facts).not.toHaveProperty('revSubdivision');

    const sent = [];
    const doc = { send: async (cmd) => { sent.push(cmd); return {}; } };
    const report = await applyLaneSamplePlan({ doc, plan, suffix: 'nc3jsnxdmjhkpequimypiatkma-NONE' });

    expect(report.factsPatched).toBe(1);
    const update = sent.find((c) => c.input.UpdateExpression);
    // A REMOVE, not a NULL, and never a SET with nothing after it.
    expect(update.input.UpdateExpression).toMatch(/REMOVE #revSubdivision$/);
    expect(update.input.UpdateExpression).not.toMatch(/SET\s*(REMOVE|$)/);
    expect(update.input.ExpressionAttributeValues).not.toHaveProperty(':revSubdivision');

    // The row as the patch leaves it: facts set, the cleared column gone. A run
    // against it plans nothing — before, the null was never written and the row was
    // called stale on every pass forever.
    const applied = { ...live, ...patch.facts };
    delete applied.revSubdivision;
    const second = planLaneSamples({ ...source, LaneRateSample: [applied] }, NOW, { refreshLive: true });
    expect(second.actions.some((a) => a.action === 'PATCH_LANE_SAMPLE_FACTS')).toBe(false);
    expect(second.factsPatched).toBe(0);
  });

  it('fingerprints the rows the facts are read from, so a new check call invalidates the plan', () => {
    const source = baseSource();
    const before = sourceRowsOf(source);
    const after = sourceRowsOf({
      ...source,
      LoadCheckCall: [...source.LoadCheckCall, { id: 'cc-4', loadId: 'tms-delivered', at: '2026-03-03T09:00:00.000Z', type: 'NOTE' }],
    });
    expect(after.length).toBe(before.length + 1);
  });
});
