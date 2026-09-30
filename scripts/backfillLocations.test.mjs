import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryClient } from './lib/tmsClient.mjs';
import {
  extractLocationSources,
  planLocationActions,
  buildLocationPlan,
  applyLocationPlan,
} from './backfillLocations.mjs';
import { savePlan } from './lib/tmsPlan.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('backfillLocations planning', () => {
  it('exact unique match links stops to existing location', async () => {
    const client = createMemoryClient({
      locations: [
        { id: 'loc-1', name: 'Oakley Chicago', city: 'Chicago, IL', normalizedName: 'oakley chicago', active: true },
      ],
      loads: [{
        id: 'l1',
        customer: 'C',
        originName: 'Oakley Chicago',
        originCity: 'Chicago, IL',
        pickupAppt: '2026-01-10T10:00:00Z',
        deliveryAppt: '2026-01-10T18:00:00Z',
        destinationName: 'Drop',
        destinationCity: 'Detroit, MI',
        updatedAt: 't1',
      }],
    });
    const plan = await buildLocationPlan({ client, env: 'test', endpoint: 'memory://' });
    expect(plan.summary.loadsToUpdate).toBe(1);
    const update = plan.actions.find((a) => a.action === 'updateLoad');
    expect(update.input.stops[0].locationId).toBe('loc-1');
    expect(update.input.stops[0].address.name).toBe('Oakley Chicago');
    expect(update.condition.updatedAt.eq).toBe('t1');
  });

  it('unmatched stops are unresolved and not modified', async () => {
    const client = createMemoryClient({
      loads: [{
        id: 'l1',
        originName: 'Unknown Plant',
        originCity: 'Nowhere, XX',
        pickupAppt: 'a',
        deliveryAppt: 'b',
        destinationName: '',
        destinationCity: '',
        updatedAt: 't1',
      }],
    });
    const plan = await buildLocationPlan({ client, env: 'test', endpoint: 'memory://' });
    expect(plan.unresolved).toHaveLength(1);
    expect(plan.actions).toHaveLength(0);
  });

  it('an already-linked stop is never a source — even if its target was since merged', async () => {
    // Repointing after a merge belongs to MERGE_LOCATIONS/RESUME_MERGE; the backfill
    // must neither re-match a linked stop nor report it as unresolved.
    const client = createMemoryClient({
      locations: [
        { id: 'loc-a', name: 'Oakley Chicago', city: 'Chicago, IL', normalizedName: 'oakley chicago', active: true },
        { id: 'loc-old', name: 'Oakley Chicago', city: 'Chicago, IL', normalizedName: 'oakley chicago', active: false, mergedIntoId: 'loc-a' },
      ],
      loads: [{
        id: 'l1',
        pickupAppt: 'a',
        deliveryAppt: 'b',
        updatedAt: 't1',
        stops: [
          { id: 's1', type: 'pickup', name: 'Oakley Chicago', city: 'Chicago, IL', locationId: 'loc-old' },
          { id: 's2', type: 'delivery', name: 'Oakley Chicago', city: 'Chicago, IL' },
        ],
      }],
    });
    const plan = await buildLocationPlan({ client, env: 'test', endpoint: 'memory://' });
    expect(plan.summary.linkedStopsSkipped).toBe(1);
    expect(plan.unresolved).toHaveLength(0);
    expect(plan.summary.loadsToUpdate).toBe(1);
    const stops = plan.actions[0].input.stops;
    expect(stops.find((s) => s.id === 's1').locationId).toBe('loc-old'); // untouched
    expect(stops.find((s) => s.id === 's2').locationId).toBe('loc-a');
  });

  it('ambiguous locations are reviewable', async () => {
    const client = createMemoryClient({
      locations: [
        { id: 'loc-a', name: 'Oakley', city: 'Chicago, IL', normalizedName: 'oakley', active: true },
        { id: 'loc-b', name: 'Oakley', city: 'Chicago, IL', normalizedName: 'oakley', active: true },
      ],
      loads: [{
        id: 'l1',
        originName: 'Oakley',
        originCity: 'Chicago, IL',
        pickupAppt: 'a',
        deliveryAppt: 'b',
        destinationName: 'D',
        destinationCity: 'D',
        updatedAt: 't1',
      }],
    });
    const plan = await buildLocationPlan({ client, env: 'test', endpoint: 'memory://' });
    expect(plan.reviewables).toHaveLength(1);
    expect(plan.reviewables[0].kind).toBe('AMBIGUOUS_LOCATION');
    expect(plan.actions).toHaveLength(0);
  });

  it('preserves full stop JSON including proofs', async () => {
    const client = createMemoryClient({
      locations: [{ id: 'loc-1', name: 'Oakley', city: 'Chicago, IL', normalizedName: 'oakley', active: true }],
      loads: [{
        id: 'l1',
        stops: [{
          id: 's1',
          type: 'pickup',
          name: 'Oakley',
          city: 'Chicago, IL',
          appt: 'a',
          apptType: 'exact',
          sequence: 0,
          driverId: null,
          apptProofs: { request: 'req-key', email: 'email-key' },
          apptStatus: 'confirmed',
        }],
        updatedAt: 't1',
      }],
    });
    const plan = await buildLocationPlan({ client, env: 'test', endpoint: 'memory://' });
    const stop = plan.actions[0].input.stops[0];
    expect(stop.apptProofs.request).toBe('req-key');
    expect(stop.apptStatus).toBe('confirmed');
    expect(stop.locationId).toBe('loc-1');
  });
});

describe('backfillLocations apply boundary', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tms-locations-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('applies stop updates and re-derives mirrors', async () => {
    const client = createMemoryClient({
      locations: [{ id: 'loc-1', name: 'Oakley', city: 'Chicago, IL', normalizedName: 'oakley', active: true }],
      loads: [{
        id: 'l1',
        originName: 'Oakley',
        originCity: 'Chicago, IL',
        pickupAppt: 'a',
        deliveryAppt: 'b',
        destinationName: 'D',
        destinationCity: 'D',
        updatedAt: 't1',
      }],
    });
    const plan = await buildLocationPlan({ client, env: 'test', endpoint: 'memory://' });
    const report = await applyLocationPlan({
      client,
      planPath: planToPath(plan),
      env: 'test',
      endpoint: 'memory://',
    });
    expect(report.applied).toBe(1);
    const load = client._data.loads.get('l1');
    expect(load.stops[0].locationId).toBe('loc-1');
    expect(load.originName).toBe('Oakley');
  });

  it('reports fingerprint mismatch when source changed', async () => {
    const client = createMemoryClient({
      locations: [{ id: 'loc-1', name: 'Oakley', city: 'Chicago, IL', normalizedName: 'oakley', active: true }],
      loads: [{
        id: 'l1',
        originName: 'Oakley',
        originCity: 'Chicago, IL',
        pickupAppt: 'a',
        deliveryAppt: 'b',
        destinationName: 'D',
        destinationCity: 'D',
        updatedAt: 't1',
      }],
    });
    const plan = await buildLocationPlan({ client, env: 'test', endpoint: 'memory://' });
    const path = planToPath(plan);
    client._data.loads.get('l1').originName = 'Changed';
    await expect(applyLocationPlan({ client, planPath: path, env: 'test', endpoint: 'memory://' })).rejects.toThrow('fingerprint mismatch');
  });

  it('reports CAS conflicts without crashing', async () => {
    const client = createMemoryClient({
      locations: [{ id: 'loc-1', name: 'Oakley', city: 'Chicago, IL', normalizedName: 'oakley', active: true }],
      loads: [{
        id: 'l1',
        originName: 'Oakley',
        originCity: 'Chicago, IL',
        pickupAppt: 'a',
        deliveryAppt: 'b',
        destinationName: 'D',
        destinationCity: 'D',
        updatedAt: 't1',
      }],
    });
    const plan = await buildLocationPlan({ client, env: 'test', endpoint: 'memory://' });
    const path = planToPath(plan);
    client._data.loads.get('l1').updatedAt = 'changed';
    const report = await applyLocationPlan({ client, planPath: path, env: 'test', endpoint: 'memory://' });
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0].error).toContain('CAS conflict');
  });

  function planToPath(plan) {
    const path = join(tmpDir, `plan-${Date.now()}.json`);
    savePlan(plan, path);
    return path;
  }
});
