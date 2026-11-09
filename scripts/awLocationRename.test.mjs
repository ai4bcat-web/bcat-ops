import { describe, expect, it } from 'vitest';
import {
  RENAMES, applyOne, applyStopCopies, countNameCopies, countReferences, locationRenameGate, looksLikeAddressName, normalizeAddress, normalizeName, planRenames, planStopCopies,
} from './awLocationRename.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';
import { resolveScripts } from './prodBackup.mjs';
import { ALLOW_ENV, PROD_SUFFIX } from './lib/prodGate.mjs';
import { normalizeAddress as tsAddress, normalizeName as tsName } from '../amplify/functions/_shared/directoryKeys.ts';

const austell = { id: 'loc-fd3cce822772a242', name: '6000 DR. LUKE GLENN GA', street: 'NORFOLK SOUTHERN RAIL', city: 'AUSTELL', state: 'GA', zip: '30106', country: 'US', active: true };
const rochelle = { id: 'loc-7c0af6dc3158d390', name: '100 4TH AVE', city: 'ROCHELLE', state: 'IL', zip: '61068', country: 'US', active: true };
const fixture = (key) => {
  const e = RENAMES.find((x) => x.key === key);
  return { id: e.idPrefix.length > 12 ? e.idPrefix : `${e.idPrefix}0000`, ...e.old, country: 'US', active: true };
};
const other = { id: 'loc-other', name: 'ACME', street: '1 MAIN ST', city: 'X', state: 'IL', zip: '1', active: true };

describe('planRenames', () => {
  it('plans the approved rows, with normalized keys the app would store', () => {
    const plan = planRenames([austell, rochelle, other]);
    expect(plan.map((p) => p.status).slice(0, 2)).toEqual(['TO_RENAME', 'TO_RENAME']);
    expect(plan.slice(2).every((p) => p.status === 'NO_MATCH')).toBe(true);
    expect(plan[0].after).toMatchObject({ name: 'Norfolk Southern Austell Intermodal', city: 'Austell', normalizedName: 'norfolk southern austell intermodal' });
    expect(plan[1].after).toMatchObject({ name: "Roy's Transfer, Inc.", street: '100 E 4th Ave', city: 'ROCHELLE', normalizedAddress: '100 e 4th ave rochelle il 61068 us' });
  });
  it('refuses a row whose name/city/street has changed since the approval, and a missing row', () => {
    const plan = planRenames([{ ...austell, name: 'SOMETHING ELSE' }, { ...rochelle, city: 'DIXON' }]);
    expect(plan.slice(0, 2).map((p) => p.status)).toEqual(['NO_MATCH', 'NO_MATCH']);
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

describe('the 5 added renames', () => {
  const keys = ['romulus', 'walker', 'hartford', 'lapeer', 'stcharles'];
  const rows = keys.map(fixture);
  it('plans each against its stored old values, fixing Wacker and filling an empty street with the address', () => {
    const plan = planRenames(rows);
    const byKey = Object.fromEntries(plan.map((p) => [p.entry.key, p]));
    for (const k of keys) expect(byKey[k].status).toBe('TO_RENAME');
    expect(byKey.hartford.after).toMatchObject({ name: 'CDM Tool & Mfg. Co., LLC', street: '749 N Wacker Dr', normalizedName: 'cdm tool mfg', normalizedAddress: '749 n wacker dr hartford wi 53027 us' });
    expect(byKey.lapeer.after).toMatchObject({ name: 'Gestamp North America - Lapeer Plant', street: '100 E Fair St' });
    expect(byKey.walker.after.street).toBe('3200 FRUIT RIDGE AVE NW');
    expect(byKey.romulus.after).toMatchObject({ name: 'Forward Air, Inc.', street: '11651 Hannan Rd' });
    expect(byKey.stcharles.entry.note).toMatch(/LOWER CONFIDENCE/);
  });
  it('refuses when the street was edited meanwhile, and a row that would duplicate another active location', () => {
    expect(planRenames([{ ...fixture('hartford'), street: '749 N WACKER DR' }]).find((p) => p.entry.key === 'hartford').status).toBe('NO_MATCH');
    const clash = { id: 'x', name: 'Challenge Manufacturing', city: 'GRAND RAPIDS', active: true };
    expect(planRenames([fixture('walker'), clash]).find((p) => p.entry.key === 'walker').status).toBe('COLLISION');
  });
  it('writes no field that does not change, and still guards on the old value of an empty field', async () => {
    const sent = [];
    const doc = { send: async (c) => { sent.push(c); return {}; } };
    const item = planRenames([fixture('lapeer')]).find((p) => p.entry.key === 'lapeer');
    await applyOne({ doc, suffix: 'dev-x-NONE', item });
    const u = sent[0].input;
    expect(u.UpdateExpression).not.toMatch(/#f[234] =/);
    expect(Object.values(u.ExpressionAttributeValues)).toContain('100 E Fair St');
    expect(u.ConditionExpression).toMatch(/attribute_not_exists\(#f1\)/);
    expect(u.ExpressionAttributeValues[':n3']).toBeUndefined();
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

describe('stop-name copies (phase 2)', () => {
  const plan = planRenames([austell, rochelle]);
  const loads = [
    { id: 'l1', updatedAt: 't1', stops: JSON.stringify([{ locationId: austell.id, name: austell.name, city: 'Austell' }, { locationId: 'z', name: 'Z' }]), originName: austell.name, originCity: 'Austell' },
    { id: 'l2', updatedAt: 't2', stops: [{ locationId: rochelle.id, name: rochelle.name }, { locationId: rochelle.id, name: 'MANUALLY EDITED' }] },
    { id: 'l3', stops: [{ locationId: 'other', name: austell.name }], originName: austell.name, originCity: 'Austell' },
    { id: 'l4', stops: [{ locationId: austell.id, name: 'Already edited by hand' }] },
    { id: 'l5', stops: 'not json' },
  ];
  const items = planStopCopies(plan, loads);
  it('plans only stops with the renamed locationId AND the old name; mirrors only when the load holds that location', () => {
    expect(items.map((i) => i.loadId)).toEqual(['l1', 'l2']);
    const l1 = items[0];
    expect(JSON.parse(l1.newStops)).toEqual([{ locationId: austell.id, name: 'Norfolk Southern Austell Intermodal', city: 'Austell' }, { locationId: 'z', name: 'Z' }]);
    expect(l1.next.originName).toBe('Norfolk Southern Austell Intermodal');
    expect(items[1].newStops).toEqual([{ locationId: rochelle.id, name: "Roy's Transfer, Inc." }, { locationId: rochelle.id, name: 'MANUALLY EDITED' }]);
    expect(items[1].next.originName).toBeUndefined();
  });
  it('also covers a rename that phase 1 already applied, and is idempotent once the copies are rewritten', () => {
    const done = planRenames([{ ...austell, ...RENAMES[0].next }]);
    expect(planStopCopies(done, loads).map((i) => i.loadId)).toEqual(['l1']);
    const after = loads.map((l, i) => (i === 0 ? { ...l, stops: items[0].newStops, originName: items[0].next.originName } : l));
    expect(planStopCopies(plan.slice(0, 1), after)).toEqual([]);
  });
  it('writes one conditional Load update + one AuditLog with the previous values; a lost condition writes no audit', async () => {
    const sent = [];
    const mk = (err) => ({ send: async (c) => { sent.push(c); if (err && c.constructor.name === 'UpdateCommand') throw Object.assign(new Error('x'), { name: err }); return {}; } });
    expect(await applyStopCopies({ doc: mk(), suffix: 'dev-x-NONE', item: items[0] })).toBe('written');
    const [u, a] = sent;
    expect(u.input.TableName).toBe('Load-dev-x-NONE');
    expect(u.input.ConditionExpression).toContain('#ou = :ou');
    expect(u.input.ExpressionAttributeValues[':ou']).toBe('t1');
    expect(u.input.ExpressionAttributeValues[':os']).toBe(loads[0].stops);
    expect(Object.keys(u.input.ExpressionAttributeNames).sort()).toEqual(['#on', '#ou', '#st', '#ua', '#ub']);
    expect(JSON.parse(a.input.Item.changes).previous.stops[0].name).toBe(austell.name);
    expect(a.input.Item).toMatchObject({ entityType: 'LOAD', entityId: 'l1' });
    sent.length = 0;
    expect(await applyStopCopies({ doc: mk('ConditionalCheckFailedException'), suffix: 'dev-x-NONE', item: items[0] })).toBe('lost');
    expect(sent.map((c) => c.constructor.name)).toEqual(['UpdateCommand']);
  });
  it('refuses a stop that is not a renamed location and the production suffix without the gate', async () => {
    const bad = { load: { id: 'l' }, previous: { stops: [{ locationId: 'zzz' }] }, next: {} };
    await expect(applyStopCopies({ doc: { send: async () => ({}) }, suffix: 'dev-x-NONE', item: bad })).rejects.toThrow(/not a renamed location/);
    await expect(applyStopCopies({ doc: { send: async () => ({}) }, suffix: PROD_SUFFIX, item: items[0] })).rejects.toThrow();
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
  it('backs up exactly Location + Load + AuditLog and prodBackup knows the script', () => {
    expect([...PROD_WRITE_SETS.awLocationRename.models].sort()).toEqual(['AuditLog', 'Load', 'Location']);
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
