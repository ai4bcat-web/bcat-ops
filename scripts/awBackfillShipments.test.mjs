import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRODUCTION } from './lib/stackConfig.mjs';
import { assertOutputsMatch, buildLinkReport, parseExportKeys, partitionByWindow, resolveCutoff, resolveTarget, run, summaryOf } from './awBackfillShipments.mjs';

const STACK = { name: 'rehearsal', tableSuffix: 'abc123-NONE', apiUrl: 'https://api.example/graphql' };

/** In-memory tables + a BACKFILL_SHIPMENT stand-in that links by Load id and mints `L<pro>` shipments. */
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
        t.Shipment.push({ id: `shp-${id}`, number: `L${l.aljexId ?? id}`, loadIds: [id] });
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
  it('keeps [cutoff - 24 months, cutoff) and the undated, drops the rest', () => {
    const p = partitionByWindow([L('a', '1', { pickupAppt: '2024-11-06' }), L('b', '2', { pickupAppt: '2024-11-07' }), L('c', '3', { pickupAppt: '2026-11-06' }), L('d', '4', { pickupAppt: '2026-11-07' }), { id: 'e' }], '2026-11-07');
    expect(p.beforeWindow.map((l) => l.id)).toEqual(['a']);
    expect(p.afterCutoff.map((l) => l.id)).toEqual(['d']);
    expect(p.inWindow.map((l) => l.id)).toEqual(['b', 'c', 'e']);
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
