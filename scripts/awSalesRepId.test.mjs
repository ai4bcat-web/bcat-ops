import { describe, expect, it } from 'vitest';
import { AUDIT_ACTION, applyOne, salesRepIdGate } from './awSalesRepId.mjs';
import { countWrites, localPartKeys, mapRepNames, matchRep, normName, planSalesRepIds, profilesFromPlan } from './lib/salesRepPlan.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';
import { resolveScripts } from './prodBackup.mjs';
import { ALLOW_ENV, PROD_SUFFIX } from './lib/prodGate.mjs';

const P = (id, email, o = {}) => ({ id, email, name: null, role: 'NONE', status: 'ACTIVE', ...o });
const ryne = P('u-ryne', 'ryne@bcatcorp.com', { role: 'ADMIN' });
const ruben = P('u-ruben', 'ruben@bcatcorp.com');

// Runs before any gate passes: a passing gate authorises the production suffix for the rest of the process.
describe('production write guard', () => {
  it('refuses to write the production suffix without a gate that passed in this process', async () => {
    const entry = planSalesRepIds({ shipments: [{ id: 's1', salesRepCode: 'RYNE BANDOLIK' }], orders: [], mapping: mapRepNames(['RYNE BANDOLIK'], [{ id: 'u', email: 'ryne@x.com', status: 'ACTIVE' }]) }).entries[0];
    await expect(applyOne({ doc: { send: async () => ({}) }, suffix: PROD_SUFFIX, entry })).rejects.toThrow();
  });
});

describe('name matching', () => {
  it('folds case, accents and punctuation', () => {
    expect(normName("  O'Brien,  JO-Ann ")).toBe('o brien jo ann');
    expect(localPartKeys('Jane Q Doe')).toEqual(expect.arrayContaining(['jane', 'janedoe', 'jdoe', 'doejane']));
  });
  it('matches by e-mail local part: first name alone, first.last, initial+last', () => {
    expect(matchRep('RYNE BANDOLIK', [ryne]).profile.id).toBe('u-ryne');
    expect(matchRep('RUBEN VARGAS', [P('x', 'ruben.vargas@bcatcorp.com')]).status).toBe('MAPPED');
    expect(matchRep('RUBEN VARGAS', [P('x', 'rvargas@bcatcorp.com')]).status).toBe('MAPPED');
  });
  it('does not match a different person who merely shares a letter prefix', () => {
    expect(matchRep('JESSY COFFEY', [P('x', 'jenny@bcatcorp.com'), P('y', 'jess@bcatcorp.com')]).status).toBe('NONE');
    expect(matchRep('PERLA LOPEZ', [ryne, ruben]).status).toBe('NONE');
  });
  it('a profile name beats an e-mail local part', () => {
    const named = P('n', 'someone.else@bcatcorp.com', { name: 'Ryne Bandolik' });
    const bylocal = P('l', 'ryne@bcatcorp.com');
    expect(matchRep('RYNE BANDOLIK', [bylocal, named]).profile.id).toBe('n');
  });
  it('two profiles at the best tier are AMBIGUOUS, never guessed', () => {
    const r = matchRep('RYNE BANDOLIK', [P('a', 'ryne@a.com'), P('b', 'ryne@b.com')]);
    expect(r.status).toBe('AMBIGUOUS');
    expect(r.profile).toBeUndefined();
  });
  it('an INACTIVE match is left unmapped, and a live one in the same tier wins over it', () => {
    expect(matchRep('RYNE BANDOLIK', [P('a', 'ryne@a.com', { status: 'INACTIVE' })]).status).toBe('INACTIVE');
    expect(matchRep('RYNE BANDOLIK', [P('a', 'ryne@a.com', { status: 'INACTIVE' }), P('b', 'ryne@b.com')]).profile.id).toBe('b');
  });
  it('blank names and Aljex numeric codes map to nobody', () => {
    expect(matchRep('', [ryne]).status).toBe('NONE');
    expect(matchRep('001', [ryne]).status).toBe('NONE');
  });
});

const ship = (o = {}) => ({ id: 's1', salesRepCode: 'RYNE BANDOLIK', salesRepId: undefined, voidedAt: undefined, ...o });
const order = (o = {}) => ({ id: 'o1', shipmentId: 's1', customerRepId: undefined, ...o });
const plan = (shipments, orders, profiles = [ryne]) => planSalesRepIds({ shipments, orders, mapping: mapRepNames(shipments.map((s) => s.salesRepCode), profiles) });

describe('planSalesRepIds: enrich only', () => {
  it('fills the empty Shipment.salesRepId and Order.customerRepId with the profile id', () => {
    const { entries } = plan([ship()], [order()]);
    expect(entries[0].writes).toEqual([
      { table: 'Shipment', id: 's1', field: 'salesRepId', value: 'u-ryne' },
      { table: 'Order', id: 'o1', field: 'customerRepId', value: 'u-ryne' },
    ]);
    expect(countWrites(entries)).toEqual({ Shipment: 1, Order: 1 });
  });
  it('never touches a target that already holds a value; completes a half-filled shipment', () => {
    const half = plan([ship({ salesRepId: 'u-ryne' })], [order()]).entries[0].writes;
    expect(half).toEqual([{ table: 'Order', id: 'o1', field: 'customerRepId', value: 'u-ryne' }]);
    const full = plan([ship({ salesRepId: 'u-ryne' })], [order({ customerRepId: 'u-ryne' })]);
    expect(full.entries).toEqual([]);
    expect(full.skipped.alreadyComplete).toBe(1);
  });
  it('a shipment already on a DIFFERENT rep is a conflict: no write to it or its orders', () => {
    const r = plan([ship({ salesRepId: 'someone-else' })], [order()]);
    expect(r.entries).toEqual([]);
    expect(r.skipped.conflict).toBe(1);
  });
  it('skips voided shipments, unmapped names and shipments without a code', () => {
    const r = plan([ship({ id: 'v', voidedAt: '2026-01-01' }), ship({ id: 'n', salesRepCode: 'PERLA LOPEZ' }), ship({ id: 'b', salesRepCode: undefined })], []);
    expect(r.entries).toEqual([]);
    expect(r.skipped).toMatchObject({ voided: 1, unmapped: 1, noCode: 1 });
  });
  it('is idempotent: planning again after the writes land plans nothing', () => {
    const first = plan([ship()], [order()]);
    const after = plan([ship({ salesRepId: 'u-ryne' })], [order({ customerRepId: 'u-ryne' })]);
    expect(first.entries).toHaveLength(1);
    expect(after.entries).toHaveLength(0);
  });
  it('only ever plans salesRepId / customerRepId', () => {
    const { entries } = plan([ship()], [order(), order({ id: 'o2' })]);
    expect(new Set(entries.flatMap((e) => e.writes.map((w) => `${w.table}.${w.field}`)))).toEqual(new Set(['Shipment.salesRepId', 'Order.customerRepId']));
  });
});

describe('preview vs apply ids', () => {
  const backfillPlan = { actions: [
    { action: 'PUT_USER_PROFILE', id: 'u-ruben', item: { id: 'u-ruben', email: 'ruben@bcatcorp.com', role: 'NONE', status: 'ACTIVE' } },
    { action: 'PUT_USER_PROFILE', id: 'u-ryne', item: { id: 'u-ryne', email: 'ryne@bcatcorp.com', role: 'NONE', status: 'ACTIVE' } },
  ] };
  it('adds the would-be profiles, labelled planned, and the table row wins an id clash', () => {
    const merged = profilesFromPlan(backfillPlan, [ryne]);
    expect(merged.map((p) => [p.id, Boolean(p.planned)])).toEqual([['u-ryne', false], ['u-ruben', true]]);
    expect(merged[0].role).toBe('ADMIN');
  });
  it('a name maps only in the preview until the profile is in the table', () => {
    const shipments = [ship({ id: 's2', salesRepCode: 'RUBEN VARGAS' })];
    expect(plan(shipments, [], [ryne]).entries).toHaveLength(0);
    expect(plan(shipments, [], profilesFromPlan(backfillPlan, [ryne])).entries[0].repId).toBe('u-ruben');
  });
  it('rejects a file that is not a backfill plan', () => {
    expect(() => profilesFromPlan({ foo: 1 }, [])).toThrow(/not a backfillUserProfiles plan/);
  });
});

describe('write set and gate', () => {
  it('backs up exactly the tables written, and prodBackup knows the script', () => {
    expect([...PROD_WRITE_SETS.awSalesRepId.models].sort()).toEqual(['AuditLog', 'Order', 'Shipment']);
    expect(resolveScripts('awSalesRepId')).toEqual(['awSalesRepId']);
  });
  const prodValues = { target: 'prod', 'i-mean-production': true };
  const deps = (env, backups = true) => ({
    env, now: new Date(2026, 10, 9, 12), out: () => {}, accountId: async () => '273354631837',
    dynamo: { send: async () => ({ BackupSummaries: backups ? PROD_WRITE_SETS.awSalesRepId.models.map((m) => ({ TableName: `${m}-${PROD_SUFFIX}`, BackupName: `prodpre-awSalesRepId-x`, BackupStatus: 'AVAILABLE', BackupCreationDateTime: new Date(2026, 10, 9, 11) })) : [] }) },
  });
  it('refuses --apply together with --assume-profiles before any gate runs', async () => {
    await expect(salesRepIdGate({ apply: true, 'assume-profiles': 'p.json', ...prodValues }, deps({ [ALLOW_ENV]: '2026-11-09' }))).rejects.toThrow(/PREVIEW/);
  });
  it('an apply needs the typed AW_PROD_CONFIRM = <date>-salesrepid', async () => {
    const v = { apply: true, ...prodValues, 'confirm-prod': `273354631837:${PROD_SUFFIX}` };
    await expect(salesRepIdGate(v, deps({ [ALLOW_ENV]: '2026-11-09' }))).rejects.toThrow(/AW_PROD_CONFIRM must equal 2026-11-09-salesrepid/);
    await expect(salesRepIdGate(v, deps({ [ALLOW_ENV]: '2026-11-09', AW_PROD_CONFIRM: '2026-11-09-equiprep' }))).rejects.toThrow(/AW_PROD_CONFIRM/);
  });
  it('an apply without a fresh backup, or without BCAT_ALLOW_PROD for today, is refused', async () => {
    const v = { apply: true, ...prodValues, 'confirm-prod': `273354631837:${PROD_SUFFIX}` };
    await expect(salesRepIdGate(v, deps({ [ALLOW_ENV]: '2026-11-09', AW_PROD_CONFIRM: '2026-11-09-salesrepid' }, false))).rejects.toThrow(/Production gate closed/);
    await expect(salesRepIdGate(v, deps({ AW_PROD_CONFIRM: '2026-11-09-salesrepid' }))).rejects.toThrow(/Production gate closed/);
  });
  it('a fully gated apply passes', async () => {
    const v = { apply: true, ...prodValues, 'confirm-prod': `273354631837:${PROD_SUFFIX}` };
    const g = await salesRepIdGate(v, deps({ [ALLOW_ENV]: '2026-11-09', AW_PROD_CONFIRM: '2026-11-09-salesrepid' }));
    expect(g).toMatchObject({ apply: true, suffix: PROD_SUFFIX });
  });
  it('a dry run needs no typed token', async () => {
    const g = await salesRepIdGate(prodValues, deps({ [ALLOW_ENV]: '2026-11-09' }, false));
    expect(g.apply).toBe(false);
  });
});

describe('applyOne', () => {
  const entry = () => plan([ship()], [order()]).entries[0];
  const fakeDoc = (lose = []) => {
    const sent = [];
    return { sent, send: async (cmd) => {
      sent.push(cmd);
      const name = cmd.constructor.name;
      if (name === 'UpdateCommand' && lose.includes(cmd.input.TableName.split('-')[0])) { const e = new Error('x'); e.name = 'ConditionalCheckFailedException'; throw e; }
      return {};
    } };
  };
  it('writes conditionally (empty target, planned code, not voided) and audits with the previous values', async () => {
    const doc = fakeDoc();
    const r = await applyOne({ doc, suffix: PROD_SUFFIX.replace('5ucwdyvwivelbo4k4jomvrwel4', 'nc3jsnxdmjhkpequimypiatkma'), entry: entry() });
    expect(r).toEqual({ written: 2, lost: 0 });
    const upd = doc.sent.filter((c) => c.constructor.name === 'UpdateCommand');
    expect(upd[0].input.ConditionExpression).toMatch(/attribute_not_exists\(#f\)/);
    expect(upd[0].input.ConditionExpression).toMatch(/salesRepCode = :code/);
    expect(upd[0].input.ExpressionAttributeValues[':code']).toBe('RYNE BANDOLIK');
    const audit = doc.sent.find((c) => c.constructor.name === 'PutCommand').input.Item;
    expect(audit.action).toBe(AUDIT_ACTION);
    expect(JSON.parse(audit.changes).previous.every((p) => p.value === null)).toBe(true);
  });
  it('a lost race counts as already filled and writes no audit row', async () => {
    const doc = fakeDoc(['Shipment', 'Order']);
    const r = await applyOne({ doc, suffix: 'nc3jsnxdmjhkpequimypiatkma-NONE', entry: entry() });
    expect(r).toEqual({ written: 0, lost: 2 });
    expect(doc.sent.some((c) => c.constructor.name === 'PutCommand')).toBe(false);
  });
  it('refuses a field outside the enrich set', async () => {
    const bad = { shipment: ship(), code: 'X', repId: 'u', writes: [{ table: 'Order', id: 'o1', field: 'totalCents', value: 1 }] };
    await expect(applyOne({ doc: fakeDoc(), suffix: 'nc3jsnxdmjhkpequimypiatkma-NONE', entry: bad })).rejects.toThrow(/refusing to write/);
  });
});
