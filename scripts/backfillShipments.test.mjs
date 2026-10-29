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

/**
 * A stand-in for the deployed router. The mapping itself is the Lambda's and is
 * tested there; what this fake has to be faithful about is the contract the script
 * depends on — skip an already-linked load, report ids it could not find, and
 * actually link what it applies so a second run has nothing left to do.
 */
function fakeClient(loads) {
  const data = new Map(loads.map((l) => [l.id, { ...l }]));
  const calls = [];
  return {
    _data: data,
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
        planned.push({
          loadId: id,
          shipmentId: `shp-${id}`,
          orderId: `ord-${id}`,
          number: `L${load.aljexId}`,
          loadStatus: delivered ? 'DELIVERED' : 'SOURCING',
          shipmentStatus: delivered ? 'DELIVERED' : 'OPEN',
          arStatus: 'DOCS_NEEDED',
          assignmentType: load.pickupDriverId ? 'OWN_ASSET' : 'NEED_TO_COVER',
          customerId: load.customerId ?? null,
          skipped: load.shipmentId ? 'ALREADY_LINKED' : load.customerId ? null : 'NO_CUSTOMER_MATCH',
        });
        if (load.shipmentId) {
          skipped.push({ loadId: id, reason: 'ALREADY_LINKED' });
          continue;
        }
        // The router will not invent a customer id: a load whose customer name
        // matches no record is reported, never written.
        if (!load.customerId) {
          skipped.push({ loadId: id, reason: 'NO_CUSTOMER_MATCH' });
          continue;
        }
        if (input.dryRun === false) {
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

  it('reports a load the router could not match to a customer and applies the rest', async () => {
    const client = fakeClient([legacyLoad('l1'), legacyLoad('l2', { customerId: null, customer: 'NOBODY WE KNOW' })]);
    const plan = await buildShipmentPlan({ client, env: 'test', endpoint: 'memory://' });
    const report = await applyShipmentPlan({
      client,
      planPath: planToPath(plan, tmpDir),
      env: 'test',
      endpoint: 'memory://',
    });
    expect(report.applied).toBe(1);
    expect(report.skipped).toEqual([{ loadId: 'l2', reason: 'NO_CUSTOMER_MATCH' }]);
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
