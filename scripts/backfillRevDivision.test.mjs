import { describe, it, expect } from 'vitest';
import {
  DEV_TABLE_SUFFIX,
  LEGACY_VOID_REASON,
  MIGRATION_USER,
  applyRevDivisionPlan,
  buildRevDivisionPlan,
  countTags,
  loadsWithoutShipment,
  planLegacyVoids,
  planSalesReps,
  resolveTarget,
  reviewText,
  sourceRowsOf,
} from './backfillRevDivision.mjs';
import { validatePlan } from './lib/tmsPlan.mjs';

/**
 * Isolated fixtures: one shipment per branch the migration can take. Nothing here
 * talks to AWS, and no fixture invents a rep, a division or a customer.
 */
function baseSource() {
  return {
    Shipment: [
      // Tagged already, rep named by e-mail on its order.
      { id: 'shp-1', number: 'BC1001', revDivision: 'BROKERAGE', revTagSource: 'RULE', version: 3 },
      // Hand-tagged: the retag never touches it, and it already names its rep.
      { id: 'shp-2', number: 'BC1002', revDivision: 'ASSETS', revSubdivision: 'BOX_TRUCK', revTagSource: 'HAND', salesRepId: 'user-ryne', version: 2 },
      // Order names a rep nobody can resolve.
      { id: 'shp-3', number: 'BC1003', revDivision: 'BROKERAGE', revTagSource: 'RULE', version: 1 },
      // Soft-deleted before Void existed.
      { id: 'shp-4', number: 'BC1004', deletedAt: '2026-05-01T10:00:00.000Z', deletedBy: 'dennis@bcatcorp.com', version: 5 },
      // Soft-deleted by nobody in particular.
      { id: 'shp-5', number: 'BC1005', deletedAt: '2026-05-02T10:00:00.000Z', version: 1 },
      // Already a real void: left exactly as it is.
      { id: 'shp-6', number: 'BC1006', deletedAt: '2026-05-03T10:00:00.000Z', voidedAt: '2026-05-04T10:00:00.000Z', voidedBy: 'ryne@bcatcorp.com', voidReason: 'Customer cancelled', version: 4 },
      // No order rep at all.
      { id: 'shp-7', number: 'BC1007', revDivision: 'ASSETS', revSubdivision: 'LOCAL', revTagSource: 'RULE', version: 1 },
    ],
    Order: [
      { id: 'ord-1', shipmentId: 'shp-1', customerRepId: 'Dennis@bcatcorp.com' },
      { id: 'ord-2', shipmentId: 'shp-2', customerRepId: 'user-ryne' },
      { id: 'ord-3', shipmentId: 'shp-3', customerRepId: 'gone@bcatcorp.com' },
      { id: 'ord-4', shipmentId: 'shp-4', customerRepId: 'user-ryne' },
      { id: 'ord-5', shipmentId: 'shp-5' },
      { id: 'ord-6', shipmentId: 'shp-6', customerRepId: 'user-ryne' },
      { id: 'ord-7', shipmentId: 'shp-7' },
    ],
    Load: [
      { id: 'lod-1', shipmentId: 'shp-1', loadNumber: '1001', status: 'DELIVERED' },
      // shp-4's mirrored load: soft-deleted a year ago and still on a driver's
      // calendar, still on a truck, still flagged ready to bill.
      {
        id: 'lod-4', shipmentId: 'shp-4', loadNumber: '1004', status: 'ASSIGNED',
        pickupDriverId: 'drv-1', deliveryDriverId: 'drv-1', truckId: 'trk-9', readyToInvoice: true,
        stops: JSON.stringify([
          { id: 's0', type: 'pickup', sequence: 0, appt: '2026-04-20T08:00:00.000Z', driverId: 'drv-1', truckId: 'trk-9' },
          { id: 's1', type: 'delivery', sequence: 1, appt: '2026-04-21T08:00:00.000Z', driverId: 'drv-1' },
        ]),
      },
      // shp-4's second leg: nobody on it and nothing to bill — nothing to clear.
      { id: 'lod-4b', shipmentId: 'shp-4', loadNumber: '1004-2', status: 'CANCELED', readyToInvoice: false },
      // shp-5's load was canceled already, but a driver is still named on it.
      { id: 'lod-5', shipmentId: 'shp-5', loadNumber: '1005', status: 'CANCELED', pickupDriverId: 'drv-2', readyToInvoice: false },
      // The two the Step B backfill left unlinked: no customer row carries the name.
      { id: 'lod-direct-1', loadNumber: '9001', customer: 'DIRECT DRIVE LOGISTICS' },
      { id: 'lod-direct-2', loadNumber: '9002', customer: 'DIRECT DRIVE LOGISTICS' },
    ],
    UserProfile: [
      { id: 'user-dennis', email: 'dennis@bcatcorp.com', name: 'Dennis' },
      { id: 'user-ryne', email: 'ryne@bcatcorp.com', name: 'Ryne' },
    ],
    OwnershipDivision: [{ id: 'BROKERAGE' }, { id: 'ASSETS' }],
    OwnershipRule: [{ id: 'rule-seed-1' }],
    ShipmentView: [{ id: 'dispatch' }],
  };
}

const RETAG = {
  dryRun: true,
  scanned: 7,
  changed: 2,
  handTagged: 1,
  byDivision: { BROKERAGE: 4, ASSETS: 2 },
  bySubdivision: { BOX_TRUCK: 1, LOCAL: 1 },
};

describe('backfillRevDivision — the production guard', () => {
  it('refuses the production suffix before a single read', () => {
    expect(() => resolveTarget('Shipment-5ucwdyvwivelbo4k4jomvrwel4-NONE')).toThrow(/Refusing to run against production/);
  });

  it('calls the dev suffix dev, and anything else by its own name', () => {
    expect(resolveTarget(DEV_TABLE_SUFFIX)).toEqual({ suffix: DEV_TABLE_SUFFIX, environment: 'dev' });
    expect(resolveTarget('sandbox-abc-NONE').environment).toBe('sandbox-abc-NONE');
  });
});

describe('backfillRevDivision — the sales rep', () => {
  it('resolves a legacy e-mail through the profile that carries it', () => {
    const source = baseSource();
    const planned = planSalesReps({ shipments: source.Shipment, orders: source.Order, profiles: source.UserProfile });
    const action = planned.actions.find((a) => a.shipmentId === 'shp-1');

    // The order names "Dennis@bcatcorp.com"; the pool keys him by username.
    expect(action).toMatchObject({ action: 'SET_SALES_REP', repId: 'user-dennis', from: 'Dennis@bcatcorp.com' });
  });

  it('takes a username straight across when the pool knows it', () => {
    const planned = planSalesReps({
      shipments: [{ id: 'shp-x', number: 'BC9', salesRepId: null }],
      orders: [{ id: 'ord-x', shipmentId: 'shp-x', customerRepId: 'user-ryne' }],
      profiles: [{ id: 'user-ryne', email: 'ryne@bcatcorp.com' }],
    });
    expect(planned.actions[0].repId).toBe('user-ryne');
  });

  it('reports a rep nobody can resolve instead of guessing one', () => {
    const source = baseSource();
    const planned = planSalesReps({ shipments: source.Shipment, orders: source.Order, profiles: source.UserProfile });

    expect(planned.actions.some((a) => a.shipmentId === 'shp-3')).toBe(false);
    expect(planned.unresolved).toEqual([
      { shipmentId: 'shp-3', shipmentNumber: 'BC1003', reason: 'NO_PROFILE_FOR_EMAIL', value: 'gone@bcatcorp.com' },
    ]);
    expect(planned.byValue).toEqual({ 'gone@bcatcorp.com': 1 });
  });

  it('leaves a shipment that already names a rep, and one whose order names none', () => {
    const source = baseSource();
    const planned = planSalesReps({ shipments: source.Shipment, orders: source.Order, profiles: source.UserProfile });

    expect(planned.actions.some((a) => a.shipmentId === 'shp-2')).toBe(false);
    expect(planned.alreadySet).toBe(1);
    // Only shp-7's order names nobody; shp-4/5/6 are leaving the board entirely.
    expect(planned.noRepOnOrder).toBe(1);
    expect(planned.leavingTheBoard).toBe(3);
  });

  it('writes nothing on a second pass once the reps are on the shipments', () => {
    const source = baseSource();
    const first = planSalesReps({ shipments: source.Shipment, orders: source.Order, profiles: source.UserProfile });
    const applied = source.Shipment.map((s) => {
      const action = first.actions.find((a) => a.shipmentId === s.id);
      return action ? { ...s, salesRepId: action.repId } : s;
    });

    const second = planSalesReps({ shipments: applied, orders: source.Order, profiles: source.UserProfile });
    expect(second.actions).toHaveLength(0);
    // The unresolvable one is still reported — it is a fact, not a failure to retry.
    expect(second.unresolved).toHaveLength(1);
  });
});

describe('backfillRevDivision — legacy soft deletes become voids', () => {
  it('keeps who and when the delete said, and says why in one voice', () => {
    const actions = planLegacyVoids(baseSource().Shipment);

    expect(actions.map((a) => a.shipmentId)).toEqual(['shp-4', 'shp-5']);
    expect(actions[0]).toMatchObject({
      voidedAt: '2026-05-01T10:00:00.000Z',
      voidedBy: 'dennis@bcatcorp.com',
      voidReason: LEGACY_VOID_REASON,
    });
    // Nobody recorded who deleted it, so the migration signs it.
    expect(actions[1].voidedBy).toBe(MIGRATION_USER);
  });

  it('never touches a shipment somebody has already voided', () => {
    const actions = planLegacyVoids(baseSource().Shipment);
    expect(actions.some((a) => a.shipmentId === 'shp-6')).toBe(false);
  });

  it('writes nothing on a second pass', () => {
    const shipments = baseSource().Shipment.map((s) =>
      s.deletedAt && !s.voidedAt ? { ...s, voidedAt: s.deletedAt } : s
    );
    expect(planLegacyVoids(shipments)).toHaveLength(0);
  });

  it('plans the mirrored loads a void has to take our fleet off, and only those', () => {
    const source = baseSource();
    const [forShp4, forShp5] = planLegacyVoids(source.Shipment, source.Load);

    // lod-4b carries no driver and nothing to bill, so there is nothing to write.
    expect(forShp4.loads.map((l) => l.loadId)).toEqual(['lod-4']);
    expect(forShp4.loads[0]).toMatchObject({
      loadNumber: '1004',
      driverMarks: [
        'pickupDriverId', 'deliveryDriverId', 'truckId',
        'stops[0].driverId', 'stops[0].truckId', 'stops[1].driverId',
      ],
      readyToInvoice: true,
      canceling: true,
    });
    // The stops lose our fleet and keep everything else they said.
    expect(forShp4.loads[0].stops).toEqual([
      { id: 's0', type: 'pickup', sequence: 0, appt: '2026-04-20T08:00:00.000Z', driverId: null },
      { id: 's1', type: 'delivery', sequence: 1, appt: '2026-04-21T08:00:00.000Z', driverId: null },
    ]);

    // Canceled already, but still naming a driver: cleared without re-canceling.
    expect(forShp5.loads[0]).toMatchObject({
      loadId: 'lod-5', driverMarks: ['pickupDriverId'], readyToInvoice: false, canceling: false,
    });
    expect(forShp5.loads[0].stops).toBeNull();
  });
});

describe('backfillRevDivision — what it reports', () => {
  it('counts the tags over every shipment and leaves voided rows out of them', () => {
    const counts = countTags(baseSource().Shipment);

    expect(counts.byDivision).toEqual({ BROKERAGE: 2, ASSETS: 2 });
    expect(counts.bySubdivision).toEqual({ BOX_TRUCK: 1, LOCAL: 1 });
    expect(counts.handTagged).toBe(1);
    // shp-4 and shp-5 carry no tag; shp-6 is voided and counted on its own.
    expect(counts.untagged).toBe(2);
    expect(counts.voided).toBe(1);
  });

  it('reports the loads with no shipment and invents nothing for them', () => {
    const orphans = loadsWithoutShipment(baseSource().Load);
    expect(orphans).toEqual([
      { loadId: 'lod-direct-1', loadNumber: '9001', customer: 'DIRECT DRIVE LOGISTICS', status: null },
      { loadId: 'lod-direct-2', loadNumber: '9002', customer: 'DIRECT DRIVE LOGISTICS', status: null },
    ]);
  });

  it('prints the retag counts, the unresolved reps and the orphan loads', () => {
    const plan = buildRevDivisionPlan({ source: baseSource(), retag: RETAG, environment: 'dev', suffix: DEV_TABLE_SUFFIX });
    const printed = reviewText(plan);

    expect(printed).toContain('RETAG_SHIPMENTS (dry run):');
    expect(printed).toContain('changed:     2');
    expect(printed).toContain('handTagged:  1 (never re-tagged)');
    expect(printed).toContain('BROKERAGE: 4');
    expect(printed).toContain('BOX_TRUCK: 1');
    expect(printed).toContain('gone@bcatcorp.com: 1 shipment(s) — no UserProfile carries it');
    expect(printed).toContain('Legacy soft deletes to void: 2');
    expect(printed).toContain('DIRECT DRIVE LOGISTICS');
    // The loads a person has to know about: a driver's calendar and a settlement move.
    expect(printed).toContain('Mirrored loads cleared with them: 2');
    expect(printed).toContain('lod-4 (1004) on BC1004 — pickupDriverId, deliveryDriverId, truckId, stops[0].driverId, stops[0].truckId, stops[1].driverId, readyToInvoice');
    expect(printed).toContain('lod-5 (1005) on BC1005 — pickupDriverId (already CANCELED)');
  });
});

describe('backfillRevDivision — the plan protocol', () => {
  it('orders the actions seed, retag, reps, voids', () => {
    const plan = buildRevDivisionPlan({ source: baseSource(), retag: RETAG, environment: 'dev', suffix: DEV_TABLE_SUFFIX });
    const kinds = plan.actions.map((a) => a.action);

    expect(kinds[0]).toBe('ENSURE_OWNERSHIP_SEED');
    expect(kinds[1]).toBe('RETAG_SHIPMENTS');
    expect(plan.actions[1].input).toEqual({ dryRun: false });
    expect(kinds.filter((k) => k === 'SET_SALES_REP')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'VOID_LEGACY_SOFT_DELETE')).toHaveLength(2);
    expect(kinds.lastIndexOf('SET_SALES_REP')).toBeLessThan(kinds.indexOf('VOID_LEGACY_SOFT_DELETE'));
  });

  it('refuses to apply against rows that moved after the plan was built', () => {
    const source = baseSource();
    const plan = buildRevDivisionPlan({ source, retag: RETAG, environment: 'dev', suffix: DEV_TABLE_SUFFIX });
    const target = { environment: 'dev', endpoint: plan.endpoint, sourceRows: sourceRowsOf(source) };

    expect(() => validatePlan(plan, target)).not.toThrow();

    const moved = { ...source, Shipment: source.Shipment.map((s) => (s.id === 'shp-1' ? { ...s, salesRepId: 'user-dennis' } : s)) };
    expect(() => validatePlan(plan, { ...target, sourceRows: sourceRowsOf(moved) })).toThrow(/fingerprint mismatch/);
  });

  it('plans nothing but the seed and the retag once everything has been applied', () => {
    const source = baseSource();
    const first = buildRevDivisionPlan({ source, retag: RETAG, environment: 'dev', suffix: DEV_TABLE_SUFFIX });

    const applied = source.Shipment.map((s) => {
      const rep = first.actions.find((a) => a.action === 'SET_SALES_REP' && a.shipmentId === s.id);
      const voided = first.actions.find((a) => a.action === 'VOID_LEGACY_SOFT_DELETE' && a.shipmentId === s.id);
      return {
        ...s,
        ...(rep ? { salesRepId: rep.repId } : {}),
        ...(voided ? { voidedAt: voided.voidedAt, voidedBy: voided.voidedBy, voidReason: voided.voidReason } : {}),
      };
    });

    const second = buildRevDivisionPlan({
      source: { ...source, Shipment: applied },
      retag: { ...RETAG, changed: 0 },
      environment: 'dev',
      suffix: DEV_TABLE_SUFFIX,
    });

    expect(second.actions.map((a) => a.action)).toEqual(['ENSURE_OWNERSHIP_SEED', 'RETAG_SHIPMENTS']);
    expect(second.summary.salesReps.toWrite).toBe(0);
    expect(second.summary.legacyVoids).toBe(0);
    expect(second.summary.retag.changed).toBe(0);
  });
});

describe('backfillRevDivision — apply', () => {
  function harness({ conditionFails = false } = {}) {
    const calls = { directory: [], shipment: [], dynamo: [] };
    const client = {
      tmsDirectoryActions: async (action, input) => {
        calls.directory.push({ action, input });
        return { divisionsCreated: 7, rulesCreated: 7, viewsCreated: 10 };
      },
      tmsShipmentActions: async (action, input) => {
        calls.shipment.push({ action, input });
        return action === 'RETAG_SHIPMENTS' ? { ...RETAG, dryRun: false, changed: 2 } : { shipment: { id: input.shipmentId } };
      },
    };
    const doc = {
      send: async (cmd) => {
        calls.dynamo.push(cmd);
        if (conditionFails && cmd.input.ConditionExpression?.includes('attribute_not_exists(voidedAt)')) {
          const err = new Error('The conditional request failed');
          err.name = 'ConditionalCheckFailedException';
          throw err;
        }
        return {};
      },
    };
    return { calls, client, doc };
  }

  it('seeds, retags for real, writes each rep and voids each soft delete', async () => {
    const plan = buildRevDivisionPlan({ source: baseSource(), retag: RETAG, environment: 'dev', suffix: DEV_TABLE_SUFFIX });
    const { calls, client, doc } = harness();

    const report = await applyRevDivisionPlan({ client, doc, plan, suffix: DEV_TABLE_SUFFIX });

    expect(calls.directory).toEqual([{ action: 'ENSURE_OWNERSHIP_SEED', input: {} }]);
    expect(calls.shipment[0]).toEqual({ action: 'RETAG_SHIPMENTS', input: { dryRun: false } });
    expect(report.seed).toMatchObject({ divisionsCreated: 7 });
    expect(report.retag).toMatchObject({ changed: 2 });
    expect(report.salesRepsWritten).toBe(1);
    expect(report.voidsWritten).toBe(2);
    expect(report.failures).toHaveLength(0);

    const update = calls.dynamo.find((c) => c.input.Key?.id === 'shp-4');
    expect(update.input.TableName).toBe(`Shipment-${DEV_TABLE_SUFFIX}`);
    expect(update.input.ConditionExpression).toBe('attribute_not_exists(voidedAt)');
    expect(update.input.ExpressionAttributeValues).toMatchObject({
      ':voidedAt': '2026-05-01T10:00:00.000Z',
      ':voidedBy': 'dennis@bcatcorp.com',
      ':voidReason': LEGACY_VOID_REASON,
      ':version': 6,
    });
    // The PRO goes nowhere: nothing in the update removes a thing.
    expect(update.input.UpdateExpression).not.toMatch(/REMOVE|DELETE/);
    expect(calls.dynamo.some((c) => c.input.Item?.action === 'VOID_SHIPMENT')).toBe(true);
  });

  it('takes our fleet off the mirrored loads in the same step as the void', async () => {
    const plan = buildRevDivisionPlan({ source: baseSource(), retag: RETAG, environment: 'dev', suffix: DEV_TABLE_SUFFIX });
    const { calls, client, doc } = harness();

    const report = await applyRevDivisionPlan({ client, doc, plan, suffix: DEV_TABLE_SUFFIX });

    expect(report.loadsCleared).toBe(2);
    expect(report.failures).toHaveLength(0);

    const cleared = calls.dynamo.find((c) => c.input.Key?.id === 'lod-4');
    expect(cleared.input.TableName).toBe(`Load-${DEV_TABLE_SUFFIX}`);
    for (const clause of [
      'pickupDriverId = :null', 'deliveryDriverId = :null', 'truckId = :null',
      'trailerNumber = :null', 'readyToInvoice = :false', 'stops = :stops',
      '#status = :canceled', 'statusSource = :system',
    ]) {
      expect(cleared.input.UpdateExpression).toContain(clause);
    }
    expect(cleared.input.ExpressionAttributeValues).toMatchObject({ ':null': null, ':false': false, ':canceled': 'CANCELED', ':system': 'SYSTEM' });
    // The stops go back as the AWSJSON string the column holds, our fleet off them.
    expect(JSON.parse(cleared.input.ExpressionAttributeValues[':stops'])).toEqual([
      { id: 's0', type: 'pickup', sequence: 0, appt: '2026-04-20T08:00:00.000Z', driverId: null },
      { id: 's1', type: 'delivery', sequence: 1, appt: '2026-04-21T08:00:00.000Z', driverId: null },
    ]);

    // Already CANCELED, and nothing re-cancels it; its driver still comes off.
    const already = calls.dynamo.find((c) => c.input.Key?.id === 'lod-5');
    expect(already.input.UpdateExpression).toContain('pickupDriverId = :null');
    expect(already.input.UpdateExpression).not.toContain('#status');
    // Nothing is written for the leg that carried no driver and nothing to bill.
    expect(calls.dynamo.some((c) => c.input.Key?.id === 'lod-4b')).toBe(false);

    // The audit names the loads, so a person can check those drivers' calendars.
    const audit = calls.dynamo.find((c) => c.input.Item?.action === 'VOID_SHIPMENT' && c.input.Item.entityId === 'shp-4');
    expect(JSON.parse(audit.input.Item.changes).loadsCleared).toEqual(['lod-4']);
  });

  it('counts a shipment voided since the plan as already done, not as a failure', async () => {
    const plan = buildRevDivisionPlan({ source: baseSource(), retag: RETAG, environment: 'dev', suffix: DEV_TABLE_SUFFIX });
    const { client, doc } = harness({ conditionFails: true });

    const report = await applyRevDivisionPlan({ client, doc, plan, suffix: DEV_TABLE_SUFFIX });

    expect(report.voidsWritten).toBe(0);
    expect(report.voidsAlready).toBe(2);
    expect(report.failures).toHaveLength(0);
    // The real void cleared its own loads; this run must not write over them.
    expect(report.loadsCleared).toBe(0);
  });

  it('refuses to write to production even with a plan in hand', async () => {
    const plan = buildRevDivisionPlan({ source: baseSource(), retag: RETAG, environment: 'dev', suffix: DEV_TABLE_SUFFIX });
    const { client, doc } = harness();

    await expect(
      applyRevDivisionPlan({ client, doc, plan, suffix: 'Shipment-5ucwdyvwivelbo4k4jomvrwel4-NONE' }),
    ).rejects.toThrow(/Refusing to write/);
  });
});
