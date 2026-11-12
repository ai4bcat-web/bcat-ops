import { describe, expect, it } from 'vitest';
import {
  AUDIT_ACTION, AUDIT_USER, applyArchive, applyEnrich, applyFreeze, applyRepoint, locationCleanupGate, planResume, renderReport, repointedStops, rollbackAll,
} from './awLocationCleanup.mjs';
import { cityState, nameRelated, planCleanup, planEnrichment, streetKey } from './lib/locationCleanupPlan.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';
import { resolveScripts } from './prodBackup.mjs';
import { ALLOW_ENV, PROD_SUFFIX } from './lib/prodGate.mjs';

const loc = (id, name, o = {}) => ({ id, name, street: '', city: '', state: '', zip: '', active: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', ...o });
const stops = (...ids) => JSON.stringify(ids.map((id) => ({ locationId: id, name: 'N', address: { city: 'X' } })));
const load = (id, ...ids) => ({ id, shipmentId: `s-${id}`, stops: stops(...ids), updatedAt: '2026-02-01T00:00:00Z' });

const royalAddison = loc('r-add', 'THE ROYAL GROUP', { street: '654 FACTORY RD', city: 'ADDISON', state: 'IL', zip: '60101', lat: 1, lng: 2, facilityType: 'SHIPPER' });
const royalAddisoTrunc = loc('r-add2', 'THE ROYAL GROUP ADDISO', { street: '654 W FACTORY RD', city: 'ADDISON', state: 'IL', zip: '60101', facilityType: 'BOTH', apptContactEmail: 'dock@royal.example' });
const royalCicero = loc('r-cic', 'THE ROYAL GROUP', { street: '1301 S 47TH AVE', city: 'CICERO', state: 'IL', zip: '60804' });
const royalCiceroBare = loc('r-cic0', 'THE ROYAL GROUP', { city: 'CICERO, IL', notes: 'seeded from 3 historical load stop(s)' });
const royalHanover = loc('r-han', 'THE ROYAL GROUP', { street: '654 FACTORY ROAD', city: 'HANOVER PARK', state: 'IL', zip: '60133' });
const empty = loc('empty', 'NO PLACE');
const emptyUsed = loc('empty-used', 'SOME DOCK');

describe('helpers', () => {
  it('streetKey ignores directions, punctuation and suffix spelling', () => {
    expect(streetKey('654 W FACTORY RD')).toBe(streetKey('654 FACTORY ROAD'));
    expect(streetKey('2075 SOUTH 114TH STREET')).toBe(streetKey('2075 S 114TH ST.'));
    expect(streetKey('1301 S 47TH AVE')).not.toBe(streetKey('1301 S 47TH ST'));
  });
  it('cityState splits "CITY, ST" only', () => {
    expect(cityState({ city: 'CICERO, IL' })).toEqual({ city: 'CICERO', state: 'IL' });
    expect(cityState({ city: 'CICERO', state: 'IL' })).toEqual({ city: 'CICERO', state: 'IL' });
  });
  it('nameRelated: equal, or a truncation prefix of 8+ characters', () => {
    expect(nameRelated('THE ROYAL GROUP', 'THE ROYAL GROUP ADDISO')).toBe(true);
    expect(nameRelated('ACME', 'ACMEX')).toBe(false);
    expect(nameRelated('THE ROYAL GROUP', 'KLM ROYAL DUTCH')).toBe(false);
  });
});

describe('planCleanup', () => {
  const locations = [royalAddison, royalAddisoTrunc, royalCicero, royalCiceroBare, royalHanover, empty, emptyUsed];
  const loads = [load('l1', 'r-add'), load('l2', 'r-add'), load('l3', 'r-add2'), load('l4', 'r-cic'), load('l5', 'empty-used')];
  const plan = planCleanup(locations, loads);
  it('archives an unused street-less row, never one a load uses', () => {
    expect(plan.archive.map((a) => a.id)).toEqual(['empty']);
    expect(plan.review.noAddressReferenced.map((r) => r.id)).toEqual(['empty-used']);
  });
  it('merges the spelling/truncation variant into the survivor holding most loads', () => {
    const m = plan.merges.find((x) => x.sourceId === 'r-add2');
    expect(m).toMatchObject({ survivorId: 'r-add', kind: 'SAME_PLACE', loadIds: ['l3'] });
  });
  it('folds the city-only twin into the one Cicero address', () => {
    expect(plan.merges.find((x) => x.sourceId === 'r-cic0')).toMatchObject({ survivorId: 'r-cic', kind: 'FOLD' });
  });
  it('leaves a different zip alone', () => {
    expect(plan.merges.some((m) => m.sourceId === 'r-han' || m.survivorId === 'r-han')).toBe(false);
  });
  it('fills blanks on the survivor, unions aliases, reports (never overwrites) differing values', () => {
    const s = plan.survivors.find((x) => x.id === 'r-add');
    expect(s.set).toMatchObject({ apptContactEmail: 'dock@royal.example', aliases: ['THE ROYAL GROUP ADDISO'] });
    expect(s.set.facilityType).toBeUndefined();
    expect(s.conflicts).toEqual([{ field: 'facilityType', survivor: 'SHIPPER', source: 'BOTH', sourceId: 'r-add2' }]);
  });
  it('system notes are not copied', () => {
    const e = planEnrichment(royalCicero, [royalCiceroBare]);
    expect(e.set.notes).toBeUndefined();
  });
  it('a clean directory plans nothing, and archived/merged rows are ignored', () => {
    expect(planCleanup([royalAddison, royalCicero], []).merges).toEqual([]);
    expect(planCleanup([royalAddison, { ...royalAddisoTrunc, active: false }], []).merges).toEqual([]);
    expect(planCleanup([royalAddison, { ...royalAddisoTrunc, mergedIntoId: 'x' }], []).merges).toEqual([]);
  });
  it('is deterministic (the survivor does not depend on input order)', () => {
    const a = planCleanup([royalAddison, royalAddisoTrunc], []).merges[0].survivorId;
    const b = planCleanup([royalAddisoTrunc, royalAddison], []).merges[0].survivorId;
    expect(a).toBe(b);
  });
  it('renders a report that names the Royal Group rows', () => {
    const md = renderReport({ plan, resume: [], today: '2026-11-12', suffix: 'x', royal: [{ id: 'r-add', name: 'THE ROYAL GROUP', street: '654', city: 'ADDISON', state: 'IL', zip: '60101', loads: 2, plan: 'KEEP' }] });
    expect(md).toMatch(/THE ROYAL GROUP \(the autocomplete/);
    expect(md).toMatch(/Read-only/);
  });
});

const mk = (err, getItem) => {
  const sent = [];
  return {
    sent,
    doc: {
      send: async (c) => {
        sent.push(c);
        const n = c.constructor.name;
        if (err && n === 'UpdateCommand') throw Object.assign(new Error('x'), { name: err });
        if (n === 'GetCommand') return { Item: getItem };
        return {};
      },
    },
  };
};
const SFX = 'dev-x-NONE';

describe('writers', () => {
  it('archive: conditional on updatedAt and not-merged, one audit row; a lost condition writes no audit', async () => {
    const ok = mk();
    expect(await applyArchive({ doc: ok.doc, suffix: SFX, row: empty })).toBe('written');
    expect(ok.sent.map((c) => c.constructor.name)).toEqual(['UpdateCommand', 'PutCommand']);
    expect(ok.sent[0].input.ConditionExpression).toMatch(/#ou = :ou/);
    expect(ok.sent[0].input.UpdateExpression).toBe('SET #act = :f, #ua = :ua, #ub = :ub');
    const lost = mk('ConditionalCheckFailedException');
    expect(await applyArchive({ doc: lost.doc, suffix: SFX, row: empty })).toBe('lost');
    expect(lost.sent).toHaveLength(1);
  });
  it('freeze: sets mergedIntoId/mergeJobId/active=false the way MERGE_LOCATIONS does, refuses self-merge', async () => {
    const m = mk();
    expect(await applyFreeze({ doc: m.doc, suffix: SFX, row: royalAddisoTrunc, targetId: 'r-add', jobId: 'job-1' })).toBe('written');
    const u = m.sent[0].input;
    expect(u.UpdateExpression).toBe('SET #mi = :t, #mj = :j, #act = :f, #ua = :ua, #ub = :ub');
    expect(u.ExpressionAttributeValues).toMatchObject({ ':t': 'r-add', ':j': 'job-1', ':f': false });
    await expect(applyFreeze({ doc: m.doc, suffix: SFX, row: royalAddison, targetId: 'r-add', jobId: 'j' })).rejects.toThrow(/itself/);
  });
  it('enrich writes only the planned fields; nothing planned is a noop with no write', async () => {
    const m = mk();
    expect(await applyEnrich({ doc: m.doc, suffix: SFX, row: royalAddison, set: { apptContactEmail: 'a@b.c' }, sourceIds: ['x'] })).toBe('written');
    expect(m.sent[0].input.UpdateExpression).toMatch(/^SET #ua = :ua, #ub = :ub, #f0 = :v0$/);
    const n = mk();
    expect(await applyEnrich({ doc: n.doc, suffix: SFX, row: royalAddison, set: {}, sourceIds: [] })).toBe('noop');
    expect(n.sent).toHaveLength(0);
  });
  it('repointedStops keeps the stored representation and records the old id the way the app does', () => {
    const next = repointedStops(load('l', 'a', 'b'), 'a', 'z');
    expect(typeof next).toBe('string');
    expect(JSON.parse(next)[0]).toMatchObject({ locationId: 'z', address: { city: 'X', mergedFromLocationId: 'a' } });
    expect(JSON.parse(next)[1].locationId).toBe('b');
    const asList = repointedStops({ ...load('l', 'a'), stops: JSON.parse(stops('a')) }, 'a', 'z');
    expect(Array.isArray(asList)).toBe(true);
    expect(repointedStops(load('l', 'b'), 'a', 'z')).toBeNull();
  });
  it('repoint: conditional on updatedAt and the stops it read; retries a concurrent edit, gives up cleanly', async () => {
    const ok = mk();
    expect(await applyRepoint({ doc: ok.doc, suffix: SFX, load: load('l1', 'a'), sourceId: 'a', targetId: 'z' })).toBe('written');
    expect(ok.sent[0].input.ConditionExpression).toMatch(/#st = :os/);
    const lost = mk('ConditionalCheckFailedException', load('l1', 'a'));
    expect(await applyRepoint({ doc: lost.doc, suffix: SFX, load: load('l1', 'a'), sourceId: 'a', targetId: 'z', attempts: 2 })).toBe('lost');
    const gone = mk('ConditionalCheckFailedException', load('l1', 'q'));
    expect(await applyRepoint({ doc: gone.doc, suffix: SFX, load: load('l1', 'a'), sourceId: 'a', targetId: 'z' })).toBe('gone');
  });
  it('never writes production tables from a dev helper', async () => {
    await expect(applyArchive({ doc: mk().doc, suffix: PROD_SUFFIX, row: empty })).rejects.toThrow();
  });
});

describe('resume and rollback', () => {
  it('finishes the repoints of duplicates this script already froze', () => {
    const frozen = { ...royalAddisoTrunc, active: false, mergedIntoId: 'r-add', mergeJobId: 'awLocationCleanup-2026-11-12' };
    const r = planResume([royalAddison, frozen], [load('l3', 'r-add2'), load('l9', 'r-add')]);
    expect(r).toEqual([{ sourceId: 'r-add2', targetId: 'r-add', loadIds: ['l3'] }]);
    expect(planResume([royalAddison, { ...frozen, mergeJobId: 'someone-else' }], [load('l3', 'r-add2')])).toEqual([]);
  });
  it('rollback reverses loads, then survivors, then frozen/archived rows, from the audit rows', async () => {
    const rows = [
      { user: AUDIT_USER, action: AUDIT_ACTION, entityId: 'empty', createdAt: '1', changes: JSON.stringify({ kind: 'ARCHIVE', previous: { active: true }, next: { active: false } }) },
      { user: AUDIT_USER, action: AUDIT_ACTION, entityId: 'r-add2', createdAt: '2', changes: JSON.stringify({ kind: 'MERGE_SOURCE', previous: { active: true }, next: { mergedIntoId: 'r-add' } }) },
      { user: AUDIT_USER, action: AUDIT_ACTION, entityId: 'r-add', createdAt: '3', changes: JSON.stringify({ kind: 'ENRICH_SURVIVOR', previous: { apptContactEmail: null }, next: { apptContactEmail: 'a@b.c' } }) },
      { user: AUDIT_USER, action: AUDIT_ACTION, entityId: 'l3', createdAt: '4', changes: JSON.stringify({ kind: 'REPOINT_LOAD', previous: { stops: 'old' }, next: { stops: 'new' } }) },
      { user: 'someone', action: AUDIT_ACTION, entityId: 'other', createdAt: '5', changes: JSON.stringify({ kind: 'ARCHIVE', previous: {}, next: {} }) },
    ];
    const m = mk();
    expect(await rollbackAll({ doc: m.doc, suffix: SFX, auditRows: rows })).toEqual({ restored: 4, skipped: 0 });
    expect(m.sent.map((c) => c.input.TableName.split('-')[0] + ':' + c.input.Key.id)).toEqual(['Load:l3', 'Location:r-add', 'Location:r-add2', 'Location:empty']);
    expect(m.sent[1].input.UpdateExpression).toMatch(/REMOVE #f0/);
    const lost = mk('ConditionalCheckFailedException');
    expect(await rollbackAll({ doc: lost.doc, suffix: SFX, auditRows: rows })).toEqual({ restored: 0, skipped: 4 });
  });
});

describe('write set and gate', () => {
  it('backs up exactly Location + Load + AuditLog and prodBackup knows the script', () => {
    expect([...PROD_WRITE_SETS.awLocationCleanup.models].sort()).toEqual(['AuditLog', 'Load', 'Location']);
    expect(resolveScripts('awLocationCleanup')).toEqual(['awLocationCleanup']);
  });
  const prodValues = { target: 'prod', 'i-mean-production': true, apply: true, 'confirm-prod': `273354631837:${PROD_SUFFIX}` };
  const deps = (env, backups = true) => ({
    env, now: new Date(2026, 10, 12, 12), out: () => {}, accountId: async () => '273354631837',
    dynamo: { send: async () => ({ BackupSummaries: backups ? PROD_WRITE_SETS.awLocationCleanup.models.map((m) => ({ TableName: `${m}-${PROD_SUFFIX}`, BackupName: 'prodpre-awLocationCleanup-x', BackupStatus: 'AVAILABLE', BackupCreationDateTime: new Date(2026, 10, 12, 11) })) : [] }) },
  });
  it('an apply needs today, a fresh backup and AW_PROD_CONFIRM = <date>-locationcleanup', async () => {
    await expect(locationCleanupGate(prodValues, deps({ [ALLOW_ENV]: '2026-11-12' }))).rejects.toThrow(/AW_PROD_CONFIRM must equal 2026-11-12-locationcleanup/);
    await expect(locationCleanupGate(prodValues, deps({ [ALLOW_ENV]: '2026-11-12', AW_PROD_CONFIRM: '2026-11-12-locationcleanup' }, false))).rejects.toThrow(/Production gate closed/);
    const g = await locationCleanupGate(prodValues, deps({ [ALLOW_ENV]: '2026-11-12', AW_PROD_CONFIRM: '2026-11-12-locationcleanup' }));
    expect(g.apply).toBe(true);
  });
});
