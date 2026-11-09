import { describe, expect, it } from 'vitest';
import {
  RENAMES, applyOne, countNameCopies, countReferences, locationRenameGate, looksLikeAddressName, normalizeAddress, normalizeName, planRenames,
} from './awLocationRename.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';
import { resolveScripts } from './prodBackup.mjs';
import { ALLOW_ENV, PROD_SUFFIX } from './lib/prodGate.mjs';
import { normalizeAddress as tsAddress, normalizeName as tsName } from '../amplify/functions/_shared/directoryKeys.ts';

const austell = { id: 'loc-fd3cce822772a242', name: '6000 DR. LUKE GLENN GA', street: 'NORFOLK SOUTHERN RAIL', city: 'AUSTELL', state: 'GA', zip: '30106', country: 'US', active: true };
const rochelle = { id: 'loc-7c0af6dc3158d390', name: '100 4TH AVE', city: 'ROCHELLE', state: 'IL', zip: '61068', country: 'US', active: true };
const other = { id: 'loc-other', name: 'ACME', street: '1 MAIN ST', city: 'X', state: 'IL', zip: '1', active: true };

describe('planRenames', () => {
  it('plans exactly the two approved rows, with normalized keys the app would store', () => {
    const plan = planRenames([austell, rochelle, other]);
    expect(plan.map((p) => p.status)).toEqual(['TO_RENAME', 'TO_RENAME']);
    expect(plan[0].after).toMatchObject({ name: 'Norfolk Southern Austell Intermodal', city: 'Austell', normalizedName: 'norfolk southern austell intermodal' });
    expect(plan[1].after).toMatchObject({ name: "Roy's Transfer, Inc.", street: '100 E 4th Ave', city: 'ROCHELLE', normalizedAddress: '100 e 4th ave rochelle il 61068 us' });
  });
  it('refuses a row whose name/city/street has changed since the approval, and a missing row', () => {
    const plan = planRenames([{ ...austell, name: 'SOMETHING ELSE' }, { ...rochelle, city: 'DIXON' }]);
    expect(plan.map((p) => p.status)).toEqual(['NO_MATCH', 'NO_MATCH']);
    expect(planRenames([other])[0].status).toBe('NO_MATCH');
  });
  it('is idempotent: an already renamed row plans nothing', () => {
    const done = { ...austell, ...RENAMES[0].next };
    expect(planRenames([done, rochelle])[0].status).toBe('ALREADY_DONE');
  });
  it('refuses a merged/archived row and a rename that would duplicate another active location', () => {
    expect(planRenames([{ ...austell, active: false }])[0].status).toBe('MERGED_OR_ARCHIVED');
    expect(planRenames([austell, { id: 'x', name: 'Norfolk Southern Austell Intermodal', city: 'Austell', active: true }])[0].status).toBe('COLLISION');
  });
});

describe('normalizers', () => {
  it('match the app (directoryKeys.ts) on the keys this script writes', () => {
    for (const n of ["Roy's Transfer, Inc.", 'Norfolk Southern Austell Intermodal', '100 4TH AVE', 'ACME LLC']) expect(normalizeName(n)).toBe(tsName(n));
    const a = { street: '6000 Dr Luke Glenn Garrett Jr Memorial Hwy', city: 'Austell', state: 'GA', zip: '30106', country: 'US' };
    expect(normalizeAddress(a)).toBe(tsAddress(a));
  });
});

describe('looksLikeAddressName', () => {
  it('flags street addresses, bare numbers that start the row street, and PO boxes', () => {
    for (const n of ['3200 FRUIT RIDGE AVE', '749 NORTH WALKER DRIVE', '100 E FAIR ST', '5 CO BAR RNCH RD', '12B ELM ST STE 4', 'PO BOX 123', '%09 1122 MILFORD AVE']) expect(looksLikeAddressName(n)).toBe(true);
    expect(looksLikeAddressName('1210', '1210 S WAUKEGAN RD')).toBe(true);
  });
  it('does not flag businesses that merely start with a number', () => {
    for (const n of ['1ST CHOICE LOGISTICS', '4C LOGISTICS', '1888 MILLS LLC', '59 & I-90 TRUCKS & PARTS', '7701-AFNA - RGL', 'COSTCO #267 DEPOT', 'ACME STEEL']) expect(looksLikeAddressName(n)).toBe(false);
    expect(looksLikeAddressName('1210', '99 OTHER RD')).toBe(false);
  });
});

describe('denormalized copy counts', () => {
  const loads = [
    { id: 'l1', shipmentId: 's1', stops: JSON.stringify([{ locationId: austell.id, name: austell.name }, { locationId: 'z', name: 'Z' }]) },
    { id: 'l2', shipmentId: 's2', stops: [], originName: austell.name, originCity: 'Austell' },
    { id: 'l3', stops: 'not json' },
  ];
  it('counts stop rows by locationId (stops may be a JSON string) and origin/destination mirrors', () => {
    expect(countNameCopies(austell, austell.name, loads)).toMatchObject({ stopsByLocationId: 1, originMirror: 1, loadsTouched: 2 });
    const r = countReferences([austell], loads).get(austell.id);
    expect([r.stopLoads.size, r.nameLoads.size, r.shipments.size]).toEqual([1, 1, 2]);
  });
});

describe('applyOne guard', () => {
  const item = () => planRenames([austell, rochelle])[0];
  const mk = (err) => { const sent = []; return { sent, doc: { send: async (c) => { sent.push(c.constructor.name); if (err && c.constructor.name === 'UpdateCommand') throw Object.assign(new Error('x'), { name: err }); return {}; } } }; };
  it('writes the row then one AuditLog; a lost condition writes no audit', async () => {
    const ok = mk();
    expect(await applyOne({ doc: ok.doc, suffix: 'dev-x-NONE', item: item() })).toBe('written');
    expect(ok.sent).toEqual(['UpdateCommand', 'PutCommand']);
    const lost = mk('ConditionalCheckFailedException');
    expect(await applyOne({ doc: lost.doc, suffix: 'dev-x-NONE', item: item() })).toBe('lost');
    expect(lost.sent).toEqual(['UpdateCommand']);
  });
  it('refuses a row that is not in the rename table, and the production suffix without the gate', async () => {
    const bad = { entry: { idPrefix: 'loc-zzz', old: {}, next: {} }, row: { id: 'loc-zzz1' }, after: {} };
    await expect(applyOne({ doc: mk().doc, suffix: 'dev-x-NONE', item: bad })).rejects.toThrow(/not in the rename table/);
    await expect(applyOne({ doc: mk().doc, suffix: PROD_SUFFIX, item: item() })).rejects.toThrow();
  });
});

describe('write set and gate', () => {
  it('backs up exactly Location + AuditLog and prodBackup knows the script', () => {
    expect([...PROD_WRITE_SETS.awLocationRename.models].sort()).toEqual(['AuditLog', 'Location']);
    expect(resolveScripts('awLocationRename')).toEqual(['awLocationRename']);
  });
  const prodValues = { target: 'prod', 'i-mean-production': true, apply: true, 'confirm-prod': `273354631837:${PROD_SUFFIX}` };
  const deps = (env, backups = true) => ({
    env, now: new Date(2026, 10, 9, 12), out: () => {}, accountId: async () => '273354631837',
    dynamo: { send: async () => ({ BackupSummaries: backups ? PROD_WRITE_SETS.awLocationRename.models.map((m) => ({ TableName: `${m}-${PROD_SUFFIX}`, BackupName: 'prodpre-awLocationRename-x', BackupStatus: 'AVAILABLE', BackupCreationDateTime: new Date(2026, 10, 9, 11) })) : [] }) },
  });
  it('an apply needs today, a fresh backup and AW_PROD_CONFIRM = <date>-locationrename', async () => {
    await expect(locationRenameGate(prodValues, deps({ [ALLOW_ENV]: '2026-11-09' }))).rejects.toThrow(/AW_PROD_CONFIRM must equal 2026-11-09-locationrename/);
    await expect(locationRenameGate(prodValues, deps({ [ALLOW_ENV]: '2026-11-09', AW_PROD_CONFIRM: '2026-11-09-locationrename' }, false))).rejects.toThrow(/Production gate closed/);
    await expect(locationRenameGate(prodValues, deps({ AW_PROD_CONFIRM: '2026-11-09-locationrename' }))).rejects.toThrow(/Production gate closed/);
    const g = await locationRenameGate(prodValues, deps({ [ALLOW_ENV]: '2026-11-09', AW_PROD_CONFIRM: '2026-11-09-locationrename' }));
    expect(g.apply).toBe(true);
  });
});
