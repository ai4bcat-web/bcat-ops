import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { savePlan } from './lib/tmsPlan.mjs';
import {
  DEFAULT_BATCH_SIZE,
  MAX_BATCH_SIZE,
  applyShipmentPlan,
  buildShipmentPlan,
  chunk,
  resolveBatchSize,
  selectLoadsToBackfill,
  tallyPlanned,
} from './backfillShipments.mjs';
import { normalizePro } from '../src/lib/proNumber.ts';

/**
 * A stand-in for the deployed router. The mapping itself is the Lambda's and is
 * tested there; what this fake has to be faithful about is the contract the script
 * depends on — skip an already-linked load, report ids it could not find, and
 * actually link what it applies so a second run has nothing left to do.
 *
 * Since the Step R cutover a load whose customer text matches no record is no longer
 * skipped: it becomes a real shipment carrying that text with no `customerId` at all.
 * The fake writes the Shipment and Order rows it would write, because "nothing is
 * invented and nothing is lost" is a claim about those two rows and about nothing else.
 */
function fakeClient(loads, customers = []) {
  const data = new Map(loads.map((l) => [l.id, { ...l }]));
  const shipments = new Map();
  const orders = new Map();
  const proClaims = new Map();
  const calls = [];
  /**
   * The router matches the load's typed customer text against the directory. Exactly
   * one match resolves; none and more-than-one both resolve to NOTHING, and neither
   * picks a candidate — an ambiguous name is two customers' credit, not one.
   */
  const resolveCustomer = (load) => {
    if (load.customerId) return load.customerId;
    const typed = String(load.customer ?? '').trim().toUpperCase();
    if (!typed) return null;
    const hits = customers.filter((c) => c.name.trim().toUpperCase() === typed);
    return hits.length === 1 ? hits[0].id : null;
  };
  return {
    _data: data,
    _shipments: shipments,
    _orders: orders,
    calls,
    listLoads: async () => [...data.values()].map((l) => ({ ...l })),
    tmsShipmentActions: async (action, input) => {
      calls.push({ action, input });
      if (action !== 'BACKFILL_SHIPMENT') throw new Error(`unexpected action ${action}`);
      if (input.loadIds.length > MAX_BATCH_SIZE) throw new Error('loadIds must have at most 50 entries');
      const planned = [];
      const skipped = [];
      const missing = [];
      let applied = 0;
      for (const id of input.loadIds) {
        const load = data.get(id);
        if (!load) {
          missing.push(id);
          continue;
        }
        const delivered = load.readyToInvoice === true;
        const customerId = resolveCustomer(load);
        const customerName = String(load.customer ?? '').trim() || null;
        const pro = normalizePro(load.aljexId);
        // A PRO is claimed forever, so an import may not take one another load holds.
        const claimedElsewhere = pro != null && proClaims.has(pro) && proClaims.get(pro) !== id;
        const reason = load.shipmentId
          ? 'ALREADY_LINKED'
          : claimedElsewhere ? 'PRO_CLAIMED_BY_OTHER_LOAD' : null;
        planned.push({
          loadId: id,
          shipmentId: `shp-${id}`,
          orderId: `ord-${id}`,
          number: `L${load.aljexId}`,
          loadStatus: delivered ? 'DELIVERED' : 'SOURCING',
          shipmentStatus: delivered ? 'DELIVERED' : 'OPEN',
          arStatus: 'DOCS_NEEDED',
          assignmentType: load.pickupDriverId ? 'OWN_ASSET' : 'NEED_TO_COVER',
          customerId,
          customerName,
          pro,
          skipped: reason,
        });
        if (reason) {
          skipped.push({ loadId: id, reason });
          continue;
        }
        if (input.dryRun === false) {
          // Unresolved is a first-class state: the typed text is kept verbatim and the
          // attribute is OMITTED rather than written null, which is what keeps the row
          // out of the customerId index it does not belong in.
          const linked = customerId ? { customerId } : {};
          shipments.set(`shp-${id}`, { id: `shp-${id}`, customerName, ...linked });
          orders.set(`ord-${id}`, { id: `ord-${id}`, shipmentId: `shp-${id}`, customerName, ...linked });
          if (pro) proClaims.set(pro, id);
          data.set(id, { ...load, shipmentId: `shp-${id}`, orderId: `ord-${id}` });
          applied++;
        }
      }
      return { dryRun: input.dryRun !== false, requested: input.loadIds.length, applied, skipped, missing, planned };
    },
  };
}

function legacyLoad(id, extra = {}) {
  return {
    id,
    aljexId: id.replace(/\D/g, '') || '1',
    customer: 'BATORY FOODS',
    customerId: 'cus-1',
    rate: 185_000,
    readyToInvoice: false,
    pickupDriverId: 'drv-1',
    updatedAt: `t-${id}`,
    ...extra,
  };
}

function planToPath(plan, dir) {
  const path = join(dir, `plan-${Math.random().toString(36).slice(2)}.json`);
  savePlan(plan, path);
  return path;
}

describe('selection and batching', () => {
  it('leaves a load that is already linked out of the candidates', () => {
    const candidates = selectLoadsToBackfill([
      legacyLoad('l1'),
      legacyLoad('l2', { shipmentId: 'shp-existing' }),
      legacyLoad('l3'),
    ]);
    expect(candidates.map((l) => l.id)).toEqual(['l1', 'l3']);
  });

  it('splits into batches the Lambda will accept', () => {
    const ids = Array.from({ length: 57 }, (_, i) => `l${i}`);
    const batches = chunk(ids, DEFAULT_BATCH_SIZE);
    expect(batches.map((b) => b.length)).toEqual([25, 25, 7]);
  });

  it('refuses a batch size the Lambda would reject', () => {
    expect(resolveBatchSize(undefined)).toBe(DEFAULT_BATCH_SIZE);
    expect(resolveBatchSize('10')).toBe(10);
    expect(() => resolveBatchSize('0')).toThrow(/between 1 and 50/);
    expect(() => resolveBatchSize('51')).toThrow(/between 1 and 50/);
  });

  it('tallies the proposed mapping by every axis a reviewer checks', () => {
    const tally = tallyPlanned([
      { loadStatus: 'DELIVERED', shipmentStatus: 'DELIVERED', arStatus: 'UNBILLED', assignmentType: 'OWN_ASSET' },
      { loadStatus: 'DELIVERED', shipmentStatus: 'DELIVERED', arStatus: 'DOCS_NEEDED', assignmentType: 'OWN_ASSET' },
      { loadStatus: 'SOURCING', shipmentStatus: 'OPEN', arStatus: 'DOCS_NEEDED', assignmentType: 'NEED_TO_COVER' },
    ]);
    expect(tally.byLoadStatus).toEqual({ DELIVERED: 2, SOURCING: 1 });
    expect(tally.byShipmentStatus).toEqual({ DELIVERED: 2, OPEN: 1 });
    expect(tally.byArStatus).toEqual({ UNBILLED: 1, DOCS_NEEDED: 2 });
    expect(tally.byAssignment).toEqual({ OWN_ASSET: 2, NEED_TO_COVER: 1 });
  });
});

describe('dry run', () => {
  it('plans every un-backfilled load and writes nothing', async () => {
    const client = fakeClient([
      legacyLoad('l1'),
      legacyLoad('l2', { readyToInvoice: true }),
      legacyLoad('l3', { shipmentId: 'shp-existing' }),
    ]);
    const plan = await buildShipmentPlan({ client, env: 'test', endpoint: 'memory://', batchSize: 2 });

    expect(plan.summary.totalLoads).toBe(3);
    expect(plan.summary.toBackfill).toBe(2);
    expect(plan.summary.alreadyLinked).toBe(1);
    expect(plan.summary.byArStatus).toEqual({ DOCS_NEEDED: 2 });
    expect(client.calls.every((c) => c.input.dryRun === true)).toBe(true);
    expect([...client._data.values()].filter((l) => l.shipmentId)).toHaveLength(1);
  });

  it('batches by the requested size', async () => {
    const client = fakeClient(Array.from({ length: 5 }, (_, i) => legacyLoad(`l${i}`)));
    const plan = await buildShipmentPlan({ client, env: 'test', endpoint: 'memory://', batchSize: 2 });
    expect(plan.summary.batches).toBe(3);
    expect(client.calls.map((c) => c.input.loadIds.length)).toEqual([2, 2, 1]);
  });

  it('records a load the router could not find as unresolved', async () => {
    const client = fakeClient([legacyLoad('l1')]);
    // The load disappears between the list and the plan call.
    const realAction = client.tmsShipmentActions;
    client.tmsShipmentActions = async (action, input) => {
      client._data.delete('l1');
      return realAction(action, input);
    };
    const plan = await buildShipmentPlan({ client, env: 'test', endpoint: 'memory://' });
    expect(plan.unresolved).toEqual([{ loadId: 'l1', reason: 'LOAD_NOT_FOUND' }]);
  });
});

describe('apply', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tms-shipments-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('links every candidate and is a no-op on a second run', async () => {
    const client = fakeClient([legacyLoad('l1'), legacyLoad('l2')]);
    const plan = await buildShipmentPlan({ client, env: 'test', endpoint: 'memory://' });
    const path = planToPath(plan, tmpDir);

    const first = await applyShipmentPlan({ client, planPath: path, env: 'test', endpoint: 'memory://' });
    expect(first.applied).toBe(2);
    expect(first.conflicts).toEqual([]);
    expect([...client._data.values()].every((l) => l.shipmentId)).toBe(true);

    // Re-planning now finds nothing to do, and replaying the old plan changes nothing.
    const second = await buildShipmentPlan({ client, env: 'test', endpoint: 'memory://' });
    expect(second.summary.toBackfill).toBe(0);

    const replay = await applyShipmentPlan({
      client,
      planPath: planToPath(second, tmpDir),
      env: 'test',
      endpoint: 'memory://',
    });
    expect(replay.applied).toBe(0);
  });

  it('gives a load whose customer text matches nothing a real shipment, carrying that text', async () => {
    const client = fakeClient([legacyLoad('l1'), legacyLoad('l2', { customerId: null, customer: 'NOBODY WE KNOW' })]);
    const plan = await buildShipmentPlan({ client, env: 'test', endpoint: 'memory://' });
    const report = await applyShipmentPlan({
      client,
      planPath: planToPath(plan, tmpDir),
      env: 'test',
      endpoint: 'memory://',
    });
    // No match is no longer a skip: the orphan is migrated, not labelled.
    expect(report.applied).toBe(2);
    expect(report.skipped).toEqual([]);
    expect(client._data.get('l2').shipmentId).toBe('shp-l2');
    // Nothing invented, nothing lost: the typed text verbatim and NO customerId, on
    // the Order as well as the Shipment — the AR worklist and credit math read both.
    expect(client._shipments.get('shp-l2')).toEqual({ id: 'shp-l2', customerName: 'NOBODY WE KNOW' });
    expect(client._orders.get('ord-l2')).toEqual({ id: 'ord-l2', shipmentId: 'shp-l2', customerName: 'NOBODY WE KNOW' });
  });

  it('writes neither candidate id when the customer name is ambiguous', async () => {
    const client = fakeClient(
      [legacyLoad('l1', { customerId: null, customer: 'ACME LOGISTICS' })],
      [{ id: 'cus-acme-east', name: 'ACME LOGISTICS' }, { id: 'cus-acme-west', name: 'Acme Logistics' }],
    );
    const plan = await buildShipmentPlan({ client, env: 'test', endpoint: 'memory://' });
    const report = await applyShipmentPlan({
      client,
      planPath: planToPath(plan, tmpDir),
      env: 'test',
      endpoint: 'memory://',
    });
    expect(report.applied).toBe(1);
    // Two customers' credit is not one customer's: picking either would be a guess.
    expect(client._shipments.get('shp-l1')).toEqual({ id: 'shp-l1', customerName: 'ACME LOGISTICS' });
    expect(client._orders.get('ord-l1')).toEqual({ id: 'ord-l1', shipmentId: 'shp-l1', customerName: 'ACME LOGISTICS' });
  });

  it('reports a load whose PRO another load already claimed and applies the rest', async () => {
    // A PRO is claimed forever, so the second load carrying it cannot be imported under
    // it. The import says so and keeps going rather than abandoning the batch.
    const client = fakeClient([legacyLoad('l1', { aljexId: '14547  ' }), legacyLoad('l2', { aljexId: 'pro #14547' })]);
    const plan = await buildShipmentPlan({ client, env: 'test', endpoint: 'memory://', batchSize: 1 });
    const report = await applyShipmentPlan({
      client,
      planPath: planToPath(plan, tmpDir),
      env: 'test',
      endpoint: 'memory://',
    });
    expect(report.applied).toBe(1);
    expect(report.skipped).toEqual([{ loadId: 'l2', reason: 'PRO_CLAIMED_BY_OTHER_LOAD' }]);
    expect(report.conflicts).toEqual([]);
    expect(client._data.get('l2').shipmentId).toBeUndefined();
  });

  it('refuses a plan whose candidate set changed underneath it', async () => {
    const client = fakeClient([legacyLoad('l1'), legacyLoad('l2')]);
    const plan = await buildShipmentPlan({ client, env: 'test', endpoint: 'memory://' });
    const path = planToPath(plan, tmpDir);
    // The fingerprint covers the candidate set, so a load leaving it must invalidate
    // the plan rather than be silently skipped.
    client._data.set('l1', { ...client._data.get('l1'), shipmentId: 'shp-elsewhere' });
    await expect(
      applyShipmentPlan({ client, planPath: path, env: 'test', endpoint: 'memory://' }),
    ).rejects.toThrow(/fingerprint mismatch/);
  });

  it('refuses a plan built against another endpoint', async () => {
    const client = fakeClient([legacyLoad('l1')]);
    const plan = await buildShipmentPlan({ client, env: 'test', endpoint: 'memory://' });
    await expect(
      applyShipmentPlan({ client, planPath: planToPath(plan, tmpDir), env: 'test', endpoint: 'https://other/graphql' }),
    ).rejects.toThrow(/endpoint mismatch/);
  });

  it('refuses a plan built for another environment', async () => {
    const client = fakeClient([legacyLoad('l1')]);
    const plan = await buildShipmentPlan({ client, env: 'sandbox', endpoint: 'memory://' });
    await expect(
      applyShipmentPlan({ client, planPath: planToPath(plan, tmpDir), env: 'test', endpoint: 'memory://' }),
    ).rejects.toThrow(/environment mismatch/);
  });

  it('reports a batch that failed without abandoning the rest', async () => {
    const client = fakeClient([legacyLoad('l1'), legacyLoad('l2')]);
    const plan = await buildShipmentPlan({ client, env: 'test', endpoint: 'memory://', batchSize: 1 });
    const path = planToPath(plan, tmpDir);
    const realAction = client.tmsShipmentActions;
    client.tmsShipmentActions = async (action, input) => {
      if (input.dryRun === false && input.loadIds.includes('l1')) throw new Error('Forbidden: requires owner or ADMIN');
      return realAction(action, input);
    };
    const report = await applyShipmentPlan({ client, planPath: path, env: 'test', endpoint: 'memory://' });
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0].error).toMatch(/ADMIN/);
    expect(report.applied).toBe(1);
  });

  it('blocks production outright', async () => {
    const { detectMode } = await import('./lib/tmsConfig.mjs');
    expect(() => detectMode(true, 'prod')).toThrow('blocked');
  });
});
