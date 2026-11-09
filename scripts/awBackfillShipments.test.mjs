import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRODUCTION } from './lib/stackConfig.mjs';
import { assertOutputsMatch, buildLinkReport, parseExportKeys, partitionByWindow, resolveCutoff, resolveTarget, run, stopReason, summaryOf } from './awBackfillShipments.mjs';
import { backfillShipmentNumber } from '../src/lib/legacyShipmentNumber.ts';

const STACK = { name: 'rehearsal', tableSuffix: 'abc123-NONE', apiUrl: 'https://api.example/graphql' };

/** In-memory tables + a BACKFILL_SHIPMENT stand-in linked by Load id. */
function world(loads, shipments = [], claims = [], settings = null) {
  const t = { Load: loads.map((l) => ({ ...l })), Shipment: shipments.map((s) => ({ ...s })), ProClaim: claims.map((c) => ({ ...c })), settings };
  const calls = [];
  const client = {
    async tmsShipmentActions(action, { loadIds, dryRun }) {
      calls.push({ action, loadIds, dryRun });
      const r = { applied: 0, skipped: [], missing: [] };
      for (const id of loadIds) {
        const l = t.Load.find((x) => x.id === id);
        if (!l) { r.missing.push(id); continue; }
        if (l.shipmentId) { r.skipped.push({ loadId: id, reason: 'ALREADY_LINKED' }); continue; }
        if (l.voidedTarget) { r.skipped.push({ loadId: id, reason: 'SHIPMENT_VOIDED' }); continue; }
        if (dryRun) continue;
        l.shipmentId = `shp-${id}`;
        t.Shipment.push({ id: `shp-${id}`, number: backfillShipmentNumber(l.aljexId, id, false), loadIds: [id] });
        r.applied += 1;
      }
      return r;
    },
  };
  return { t, client, calls, read: async () => structuredClone(t) };
}

const L = (id, aljexId, extra = {}) => ({ id, aljexId, pickupAppt: '2026-06-01T08:00', ...extra });

describe('target', () => {
  it('refuses production and an unnamed target', () => {
    expect(() => resolveTarget({ suffix: `${PRODUCTION.apiId}-NONE`, stack: STACK, env: {} })).toThrow(/production/);
    expect(() => resolveTarget({ stack: STACK, env: {} })).toThrow(/Name the target/);
  });
  it('takes the selected stack when BCAT_STACK names it', () => {
    expect(resolveTarget({ stack: STACK, env: { BCAT_STACK: 'rehearsal' } })).toMatchObject({ suffix: 'abc123-NONE', environment: 'rehearsal', apiUrl: STACK.apiUrl });
  });
  it('apply is refused for another stack\'s API and for a suffix that is not the selected stack', () => {
    const t = resolveTarget({ stack: STACK, env: { BCAT_STACK: 'rehearsal' } });
    expect(() => assertOutputsMatch(t, { data: { url: 'https://other/graphql' } })).toThrow(/not the API/);
    expect(() => assertOutputsMatch(t, { data: { url: STACK.apiUrl } })).not.toThrow();
    expect(() => assertOutputsMatch(resolveTarget({ suffix: 'zzz-NONE', stack: STACK, env: {} }), { data: { url: STACK.apiUrl } })).toThrow(/read-only/);
  });
});

describe('history window', () => {
  it('cutoff precedence: --cutoff, then TmsSettings (Chicago day), then 2026-11-07', () => {
    expect(resolveCutoff({ cutoff: '2026-01-02', settings: { aljexCutoffAt: '2031-11-07T06:00:00.000Z' } })).toBe('2026-01-02');
    expect(resolveCutoff({ settings: { aljexCutoffAt: '2031-11-07T06:00:00.000Z' } })).toBe('2031-11-07');
    expect(resolveCutoff({})).toBe('2026-11-07');
    expect(() => resolveCutoff({ cutoff: '11/07/2026' })).toThrow();
  });
  it('lower bound only: ship date on/after cutoff - 24 months is kept, the undated is kept, older is out', () => {
    const early = { createdAt: '2026-06-01T00:00:00.000Z' };
    const p = partitionByWindow([L('a', '1', { pickupAppt: '2024-11-06', ...early }), L('b', '2', { pickupAppt: '2024-11-07', ...early }), L('c', '3', { pickupAppt: '2026-11-06', ...early }), L('d', '4', { pickupAppt: '2026-11-07', ...early }), { id: 'e' }], '2026-11-07');
    expect(p.beforeWindow.map((l) => l.id)).toEqual(['a']);
    expect(p.afterCutoff).toEqual([]);
    expect(p.inWindow.map((l) => l.id)).toEqual(['b', 'c', 'd', 'e']);
  });
  it('the cutoff means BOOKED: 17 Loads created before it and shipping 11-07..11-16 are carried over, not afterCutoff', async () => {
    const carried = Array.from({ length: 17 }, (_, i) => L(`c${i}`, String(900 + i), { pickupAppt: `2026-11-${String(7 + (i % 10)).padStart(2, '0')}T08:00`, createdAt: '2026-11-06T22:00:00.000Z' }));
    const loads = [L('l1', '100', { createdAt: '2026-06-01T00:00:00.000Z' }), L('old', '600', { pickupAppt: '2024-11-06', createdAt: '2024-11-01T00:00:00.000Z' }), ...carried];
    const r = await run({ read: world(loads).read, cutoff: '2026-11-07' });
    expect(r.before.window.carriedOver).toBe(17);
    expect(r.before.window.outOfWindow).toEqual({ beforeWindow: 1, afterCutoff: 0 });
    expect(r.before.report.counts.loads).toBe(18);
    expect(summaryOf(r).carriedOver).toBe(17);
    expect(stopReason(r)).toBeNull();
  });
  it('a Load created on or after the cutoff is afterCutoff: not classified, and STOP', async () => {
    const loads = [L('l1', '100', { createdAt: '2026-06-01T00:00:00.000Z' }), L('late', '200', { pickupAppt: '2026-11-09T08:00', createdAt: '2026-11-07T01:00:00.000Z' })];
    const r = await run({ read: world(loads).read, cutoff: '2026-11-07' });
    expect(r.before.window.outOfWindow.afterCutoff).toBe(1);
    expect(r.before.window.carriedOver).toBe(0);
    expect(r.before.report.counts.loads).toBe(1);
    expect(stopReason(r)).toMatch(/^STOP: 1 Load/);
  });
  it('without createdAt the ship date decides: on/after the cutoff is afterCutoff', () => {
    const p = partitionByWindow([{ id: 'x', pickupAppt: '2026-11-08' }], '2026-11-07');
    expect(p.afterCutoff.map((l) => l.id)).toEqual(['x']);
  });
});

describe('export keys', () => {
  it('normalises padded / Pro#-labelled / quoted CSV first-column PROs', () => {
    expect([...parseExportKeys('Pro# 123\n"0456",x\n\n')].sort()).toEqual(['0456', '123']);
  });
});

describe('report', () => {
  const loads = [L('l1', '100'), L('l2', '200'), L('l3', null), L('l4', '400', { shipmentId: 'shp-4' }), L('l5', '500'), L('old', '600', { pickupAppt: '2020-01-01' })];
  const claims = [{ id: '500', loadId: 'someone-else' }];

  it('buckets by PRO then ID and reconciles to the Load count; out-of-window Loads are counted apart', () => {
    const { report, window } = buildLinkReport({ source: { Load: loads, Shipment: [], ProClaim: claims }, cutoff: '2026-11-07', exportKeys: new Set(['100']) });
    expect(report.matchedByPro.map((e) => e.loadId)).toEqual(['l1']);
    expect(report.linkedById.map((e) => e.loadId)).toEqual(['l2', 'l3']);
    expect(report.alreadyLinked.map((e) => e.loadId)).toEqual(['l4']);
    expect(report.ambiguous.map((e) => [e.loadId, e.reason])).toEqual([['l5', 'PRO_CLAIMED_BY_OTHER_LOAD']]);
    expect(report.counts.loads).toBe(5);
    expect(window.outOfWindow.beforeWindow).toBe(1);
    expect(window.totalLoads).toBe(6);
  });

  it('a Shipment already carrying the PRO but not linked needs Ryne', () => {
    const { report } = buildLinkReport({ source: { Load: [L('l1', '100')], Shipment: [{ id: 's', number: 'L100', loadIds: [] }], ProClaim: [] }, cutoff: '2026-11-07' });
    expect(report.ambiguous.map((e) => e.reason)).toEqual(['SHIPMENT_NOT_LINKED']);
  });
});

describe('run', () => {
  const loads = [L('l1', '100'), L('l2', '200'), L('l3', null), L('l4', '400', { shipmentId: 'shp-4' }), L('l5', '500', { voidedTarget: true }), L('old', '600', { pickupAppt: '2020-01-01' })];

  it('dry run writes nothing, still asks the planner only in dry-run mode, and the CSV carries no names', async () => {
    const w = world(loads);
    const before = JSON.stringify(w.t);
    const r = await run({ read: w.read, client: w.client, exportKeys: new Set(['100']) });
    expect(JSON.stringify(w.t)).toBe(before);
    expect(w.calls.every((c) => c.dryRun === true)).toBe(true);
    expect(summaryOf(r).before).toEqual({ matchedByPro: 1, linkedById: 2, ambiguous: 0, unmappable: 1, alreadyLinked: 1, loads: 5 });
    expect(r.before.report.unmappable[0]).toMatchObject({ loadId: 'l5', detail: 'SHIPMENT_VOIDED' });
  });

  it('without a client the refusals are not evaluated and nothing is called', async () => {
    const r = await run({ read: world(loads).read });
    expect(r.skipsEvaluated).toBe(false);
    expect(r.before.report.counts.unmappable).toBe(0);
  });

  it('apply links only the ID bucket (incl. a Load with no PRO), never the PRO-matched, and a re-run changes nothing', async () => {
    const w = world(loads);
    const keys = new Set(['100']);
    const first = await run({ read: w.read, client: w.client, apply: true, exportKeys: keys });
    expect(first.applied).toMatchObject({ applied: 2, conflicts: [] });
    const applyIds = w.calls.filter((c) => !c.dryRun).flatMap((c) => c.loadIds);
    expect(applyIds).toEqual(['l2', 'l3']);
    expect(w.t.Load.find((l) => l.id === 'l1').shipmentId).toBeUndefined();
    expect(w.t.Load.find((l) => l.id === 'old').shipmentId).toBeUndefined();
    expect(first.after.report.counts).toMatchObject({ linkedById: 0, matchedByPro: 1, alreadyLinked: 3 });

    const snapshot = JSON.stringify(w.t);
    const callsBefore = w.calls.length;
    const second = await run({ read: w.read, client: w.client, apply: true, exportKeys: keys });
    expect(JSON.stringify(w.t)).toBe(snapshot);
    expect(second.applied.applied).toBe(0);
    expect(w.calls.slice(callsBefore).filter((c) => !c.dryRun)).toEqual([]);
  });

  it('applying needs a client', async () => {
    await expect(run({ read: world(loads).read, apply: true })).rejects.toThrow(/--outputs/);
  });

  it('a failed batch is a conflict, not a crash, and other batches still run', async () => {
    const w = world([L('a', '1'), L('b', '2')]);
    const real = w.client.tmsShipmentActions;
    w.client.tmsShipmentActions = async (action, input) => {
      if (!input.dryRun && input.loadIds.includes('a')) throw new Error('boom');
      return real(action, input);
    };
    const r = await run({ read: w.read, client: w.client, apply: true, batchSize: 1 });
    expect(r.applied.conflicts).toEqual([{ loadIds: ['a'], error: 'boom' }]);
    expect(r.applied.applied).toBe(1);
  });
});
