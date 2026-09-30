import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryClient } from './lib/tmsClient.mjs';
import {
  extractCustomerSources,
  planCustomerActions,
  planLoadCustomerUpdates,
  buildCustomerPlan,
  applyCustomerPlan,
} from './backfillCustomers.mjs';
import { savePlan, loadPlan } from './lib/tmsPlan.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function planToPath(plan, tmpDir) {
  const path = join(tmpDir, `plan-${Date.now()}.json`);
  savePlan(plan, path);
  return path;
}

describe('backfillCustomers planning', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tms-customers-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exact unique match links loads and does not create customer', async () => {
    const client = createMemoryClient({
      customers: [{ id: 'cust-1', name: 'Acme LLC', normalizedName: 'acme', active: true }],
      loads: [
        { id: 'l1', customer: 'ACME LLC', updatedAt: 't1' },
        { id: 'l2', customer: 'Acme', updatedAt: 't2' },
      ],
    });
    const plan = await buildCustomerPlan({ client, env: 'test', endpoint: 'memory://' });
    expect(plan.summary.newCustomers).toBe(0);
    expect(plan.summary.loadsToUpdate).toBe(2);
    const updates = plan.actions.filter((a) => a.action === 'updateLoad');
    expect(updates.every((u) => u.input.customerId === 'cust-1')).toBe(true);
    expect(updates[0].condition.updatedAt.eq).toBeDefined();
  });

  it('no existing customer proposes a new customer and a deferred load update', async () => {
    const client = createMemoryClient({
      loads: [{ id: 'l1', customer: 'New Customer Inc.', updatedAt: 't1' }],
    });
    const plan = await buildCustomerPlan({ client, env: 'test', endpoint: 'memory://' });
    expect(plan.summary.newCustomers).toBe(1);
    const create = plan.actions.find((a) => a.action === 'UPSERT_CUSTOMER');
    expect(create.input.name).toBe('New Customer Inc.');
    const update = plan.actions.find((a) => a.action === 'updateLoad');
    expect(update.input.customerId).toBeNull();
    expect(update.customerKey).toBe('new customer');
  });

  it('flags ambiguous customer matches for review', async () => {
    const client = createMemoryClient({
      customers: [
        { id: 'c1', name: 'Acme', normalizedName: 'acme', active: true },
        { id: 'c2', name: 'Acme Corp', normalizedName: 'acme', active: true },
      ],
      loads: [{ id: 'l1', customer: 'ACME', updatedAt: 't1' }],
    });
    const plan = await buildCustomerPlan({ client, env: 'test', endpoint: 'memory://' });
    expect(plan.reviewables).toHaveLength(1);
    expect(plan.reviewables[0].kind).toBe('AMBIGUOUS_CUSTOMER');
    expect(plan.summary.loadsToUpdate).toBe(0);
  });

  it('flags Batory mappings for reviewer approval without auto-apptWorkflow', async () => {
    const client = createMemoryClient({
      loads: [{ id: 'l1', customer: 'BATORY FOODS', updatedAt: 't1' }],
    });
    const plan = await buildCustomerPlan({ client, env: 'test', endpoint: 'memory://' });
    const create = plan.actions.find((a) => a.action === 'UPSERT_CUSTOMER');
    expect(create.input.apptWorkflow).toBeUndefined();
    expect(plan.reviewables.some((r) => r.kind === 'BATORY_WORKFLOW_REVIEW')).toBe(true);
  });

  it('preserves the raw Load.customer text and only writes customerId', async () => {
    const client = createMemoryClient({
      customers: [{ id: 'c1', name: 'Acme', normalizedName: 'acme', active: true }],
      loads: [{ id: 'l1', customer: 'ACME', updatedAt: 't1' }],
    });
    await applyCustomerPlan({
      client,
      planPath: planToPath(await buildCustomerPlan({ client, env: 'test', endpoint: 'memory://' }), tmpDir),
      env: 'test',
      endpoint: 'memory://',
    });
    const load = client._data.loads.get('l1');
    expect(load.customer).toBe('ACME');
    expect(load.customerId).toBe('c1');
  });
});

describe('backfillCustomers apply boundary', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tms-customers-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('blocks production environment application', async () => {
    const { detectMode } = await import('./lib/tmsConfig.mjs');
    expect(() => detectMode(true, 'prod')).toThrow('blocked');
  });

  it('reports fingerprint mismatch when source changed after dry-run', async () => {
    const client = createMemoryClient({
      loads: [{ id: 'l1', customer: 'Only', updatedAt: 't1' }],
    });
    const plan = await buildCustomerPlan({ client, env: 'test', endpoint: 'memory://' });
    const path = planToPath(plan, tmpDir);
    client._data.loads.set('l2', { id: 'l2', customer: 'Extra', updatedAt: 't2' });
    await expect(applyCustomerPlan({ client, planPath: path, env: 'test', endpoint: 'memory://' })).rejects.toThrow('fingerprint mismatch');
  });

  it('reports CAS conflicts without crashing', async () => {
    const client = createMemoryClient({
      customers: [{ id: 'c1', name: 'Acme', normalizedName: 'acme', active: true }],
      loads: [{ id: 'l1', customer: 'Acme', updatedAt: 't1' }],
    });
    const plan = await buildCustomerPlan({ client, env: 'test', endpoint: 'memory://' });
    const path = planToPath(plan, tmpDir);
    client._data.loads.get('l1').updatedAt = 'changed';
    const report = await applyCustomerPlan({ client, planPath: path, env: 'test', endpoint: 'memory://' });
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0].error).toContain('CAS conflict');
  });
});
