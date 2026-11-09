import { describe, expect, it } from 'vitest';
import { AUDIT_ACTION, applyOne, salesRepFillGate } from './awSalesRepFill.mjs';
import { ID_MAP, GROUP_IDS, countWrites, planSalesRepFill, verifyIdMap } from './lib/salesRepFillPlan.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';
import { resolveScripts } from './prodBackup.mjs';
import { ALLOW_ENV, PROD_SUFFIX } from './lib/prodGate.mjs';

// Runs before any gate passes: a passing gate authorises the production suffix for the rest of the process.
describe('production write guard', () => {
  it('refuses to write the production suffix without a gate that passed in this process', async () => {
    const entry = { shipment: { id: 's1' }, pro: '1', repId: '001', target: { name: 'RYNE BANDOLIK' }, writes: [{ table: 'Shipment', id: 's1', field: 'salesRepCode', value: 'X' }] };
    await expect(applyOne({ doc: { send: async () => ({}) }, suffix: PROD_SUFFIX, entry })).rejects.toThrow();
  });
});

const P = (id, email, o = {}) => ({ id, email, name: null, role: 'NONE', status: 'ACTIVE', ...o });
const profiles = [P('u-ryne', 'ryne@bcatcorp.com'), P('u-ruben', 'ruben@bcatcorp.com'), P(GROUP_IDS.IVAN_CARTAGE, 'ic@groups.invalid'), P(GROUP_IDS.OWNER_OPERATORS, 'oo@groups.invalid')];
const okVerdicts = new Map(Object.keys(ID_MAP).map((id) => [id, { status: 'OK' }]));
const ship = (o = {}) => ({ id: 's1', number: '100', ...o });
const run = ({ shipments = [ship()], orders = [], exp = {}, file = {}, verdicts = okVerdicts, profs = profiles } = {}) => planSalesRepFill({
  shipments, orders, proOf: (s) => s.number, verdicts, profiles: profs,
  exportByPro: new Map(Object.entries(exp)), fileRepByPro: new Map(Object.entries(file)),
});

describe('planSalesRepFill', () => {
  it('maps every Aljex id to Ryne\'s person / group / BCAT text, profile ids only for Ryne, Ruben and the two groups', () => {
    const ids = ['001', '002', '003', '004', '005', '007', '008', '009', '010', '10'];
    const shipments = ids.map((id, i) => ship({ id: `s${id}`, number: String(100 + i) }));
    const exp = Object.fromEntries(ids.map((id, i) => [String(100 + i), { repId: id, shipDate: '2026-03-01' }]));
    const { entries, unresolved } = run({ shipments, exp });
    expect(unresolved).toEqual([]);
    const by = Object.fromEntries(entries.map((e) => [e.repId, e.writes.map((w) => `${w.field}=${w.value}`)]));
    expect(by['001']).toEqual(['salesRepCode=RYNE BANDOLIK', 'salesRepId=u-ryne']);
    expect(by['002']).toEqual(['salesRepCode=RUBEN VARGAS', 'salesRepId=u-ruben']);
    expect(by['003']).toEqual(['salesRepCode=BCAT']);
    expect(by['004']).toEqual(['salesRepCode=JESSY COFFEY']);
    expect(by['005']).toEqual([`salesRepId=${GROUP_IDS.IVAN_CARTAGE}`]);
    expect(by['10']).toEqual([`salesRepId=${GROUP_IDS.OWNER_OPERATORS}`]);
    for (const id of ['007', '008', '009', '010']) expect(by[id]).toHaveLength(1);
    expect(by['010']).toEqual(['salesRepCode=JAMEY CHILDS']);
  });
  it('mirrors the profile id onto the shipment\'s empty Orders only', () => {
    const { entries } = run({ exp: { 100: { repId: '001', shipDate: '2026-01-01' } }, orders: [{ id: 'o1', shipmentId: 's1' }, { id: 'o2', shipmentId: 's1', customerRepId: 'x' }] });
    expect(entries[0].writes.filter((w) => w.table === 'Order').map((w) => w.id)).toEqual(['o1']);
    expect(countWrites(entries)).toEqual({ 'Shipment.salesRepCode': 1, 'Shipment.salesRepId': 1, 'Order.customerRepId': 1 });
  });
  it('never touches a shipment that already has a code or an id, or a voided one', () => {
    const exp = { 100: { repId: '001', shipDate: '2026-01-01' } };
    expect(run({ shipments: [ship({ salesRepCode: 'PERLA LOPEZ' })], exp }).skipped.hasRep).toBe(1);
    expect(run({ shipments: [ship({ salesRepId: 'u-x' })], exp }).entries).toEqual([]);
    expect(run({ shipments: [ship({ voidedAt: '2026-01-01' })], exp }).skipped.voided).toBe(1);
  });
  it('002 is Ruben only from 2025: an older or undated PRO stays unassigned and listed', () => {
    for (const shipDate of ['2024-12-31', null]) {
      const r = run({ exp: { 100: { repId: '002', shipDate } } });
      expect(r.entries).toEqual([]);
      expect(r.unresolved[0].reason).toBe('ID_AMBIGUOUS_BEFORE_2025');
    }
    expect(run({ exp: { 100: { repId: '002', shipDate: '2025-01-01' } } }).entries).toHaveLength(1);
  });
  it('an id whose evidence is ambiguous or points at someone else is not applied', () => {
    for (const status of ['AMBIGUOUS', 'MISMATCH']) {
      const verdicts = new Map(okVerdicts).set('005', { status });
      const r = run({ exp: { 100: { repId: '005', shipDate: '2026-01-01' } }, verdicts });
      expect(r.entries).toEqual([]);
      expect(r.unresolved[0]).toMatchObject({ reason: `ID_${status}`, repId: '005' });
    }
  });
  it('unknown / blank ids and PROs missing from the export are listed, not guessed', () => {
    const r = run({ shipments: [ship({ id: 'a', number: '1' }), ship({ id: 'b', number: '2' }), ship({ id: 'c', number: '3' }), ship({ id: 'd', number: '4' })], exp: { 1: { repId: '006', shipDate: '2026-01-01' }, 2: { repId: '', shipDate: '2026-01-01' }, 3: { repId: '', shipDate: null } } });
    expect(r.unresolved.map((u) => u.reason)).toEqual(['ID_NOT_IN_MAP', 'EXPORT_ID_BLANK', 'EXPORT_ID_BLANK', 'NOT_IN_EXPORT']);
  });
  it('a profile that does not exist yet leaves that shipment unassigned (never a dangling id)', () => {
    const r = run({ exp: { 100: { repId: '005', shipDate: '2026-01-01' } }, profs: [profiles[0]] });
    expect(r.entries).toEqual([]);
    expect(r.unresolved[0].reason).toBe('NO_GROUP_PROFILE');
    expect(run({ exp: { 100: { repId: '001', shipDate: '2026-01-01' } }, profs: [] }).unresolved[0].reason).toBe('PROFILE_NONE');
  });
  it('the equipment-export name wins over the id, and a conflicting file name is not guessed', () => {
    const exp = { 100: { repId: '001', shipDate: '2026-01-01' } };
    const viaFile = run({ exp, file: { 100: { name: 'BCAT', conflict: false } } });
    expect(viaFile.entries[0]).toMatchObject({ source: 'FILE', target: { name: 'BCAT' } });
    expect(viaFile.entries[0].writes.map((w) => w.value)).toEqual(['BCAT']);
    expect(run({ exp, file: { 100: { name: null, conflict: true } } }).unresolved[0].reason).toBe('FILE_REP_CONFLICT');
  });
  it('is idempotent: once the rep is written nothing is planned again', () => {
    expect(run({ shipments: [ship({ salesRepCode: 'BCAT' })], exp: { 100: { repId: '003', shipDate: '2026-01-01' } } }).entries).toEqual([]);
  });
});

describe('verifyIdMap (since-2025 evidence, 95% purity)', () => {
  const row = (id, names) => { const total = Object.values(names).reduce((a, b) => a + b, 0); const ranked = Object.entries(names).sort((a, b) => b[1] - a[1]); return { id, total, dominant: ranked[0][0], purity: ranked[0][1] / total, ambiguous: ranked[0][1] / total < 0.95, names }; };
  it('classifies OK / AMBIGUOUS / MISMATCH / NO_EVIDENCE', () => {
    const v = verifyIdMap([row('001', { 'RYNE BANDOLIK': 99, 'RUBEN VARGAS': 1 }), row('002', { 'RUBEN VARGAS': 51, 'IVAN CARTAGE CO': 49 }), row('003', { 'IVAN CARTAGE CO': 10 })]);
    expect(v.get('001').status).toBe('OK');
    expect(v.get('002').status).toBe('AMBIGUOUS');
    expect(v.get('003').status).toBe('MISMATCH');
    expect(v.get('004').status).toBe('NO_EVIDENCE');
  });
});

describe('write set and gate', () => {
  it('backs up exactly the tables written', () => {
    expect([...PROD_WRITE_SETS.awSalesRepFill.models].sort()).toEqual(['AuditLog', 'Order', 'Shipment']);
    expect(resolveScripts('awSalesRepFill')).toEqual(['awSalesRepFill']);
  });
  const prodValues = { target: 'prod', 'i-mean-production': true };
  const deps = (env) => ({
    env, now: new Date(2026, 10, 9, 12), out: () => {}, accountId: async () => '273354631837',
    dynamo: { send: async () => ({ BackupSummaries: PROD_WRITE_SETS.awSalesRepFill.models.map((m) => ({ TableName: `${m}-${PROD_SUFFIX}`, BackupName: 'prodpre-awSalesRepFill-x', BackupStatus: 'AVAILABLE', BackupCreationDateTime: new Date(2026, 10, 9, 11) })) }) },
  });
  it('refuses --apply with --assume-profiles; an apply needs AW_PROD_CONFIRM=<date>-salesrepfill', async () => {
    await expect(salesRepFillGate({ apply: true, 'assume-profiles': 'p.json', ...prodValues }, deps({ [ALLOW_ENV]: '2026-11-09' }))).rejects.toThrow(/PREVIEW/);
    const v = { apply: true, ...prodValues, 'confirm-prod': `273354631837:${PROD_SUFFIX}` };
    await expect(salesRepFillGate(v, deps({ [ALLOW_ENV]: '2026-11-09', AW_PROD_CONFIRM: '2026-11-09-salesrepid' }))).rejects.toThrow(/must equal 2026-11-09-salesrepfill/);
    expect(await salesRepFillGate(v, deps({ [ALLOW_ENV]: '2026-11-09', AW_PROD_CONFIRM: '2026-11-09-salesrepfill' }))).toMatchObject({ apply: true });
  });
});

describe('applyOne', () => {
  const DEV = 'nc3jsnxdmjhkpequimypiatkma-NONE';
  const entry = () => run({ exp: { 100: { repId: '001', shipDate: '2026-01-01' } }, orders: [{ id: 'o1', shipmentId: 's1' }] }).entries[0];
  const fakeDoc = (lose = []) => {
    const sent = [];
    return { sent, send: async (cmd) => {
      sent.push(cmd);
      if (cmd.constructor.name === 'UpdateCommand' && lose.includes(cmd.input.TableName.split('-')[0])) { const e = new Error('x'); e.name = 'ConditionalCheckFailedException'; throw e; }
      return {};
    } };
  };
  it('one Shipment update guarded on BOTH rep fields empty and not voided, then the Order, then an audit row with null previous values', async () => {
    const doc = fakeDoc();
    expect(await applyOne({ doc, suffix: DEV, entry: entry() })).toEqual({ written: 3, lost: 0 });
    const upd = doc.sent.filter((c) => c.constructor.name === 'UpdateCommand');
    expect(upd).toHaveLength(2);
    expect(upd[0].input.UpdateExpression).toBe('SET #salesRepCode = :salesRepCode, #salesRepId = :salesRepId');
    expect(upd[0].input.ConditionExpression).toMatch(/attribute_not_exists\(voidedAt\)/);
    expect(upd[0].input.ConditionExpression).toMatch(/salesRepCode = :blank/);
    expect(upd[0].input.ConditionExpression).toMatch(/salesRepId = :blank/);
    const audit = doc.sent.find((c) => c.constructor.name === 'PutCommand').input.Item;
    expect(audit.action).toBe(AUDIT_ACTION);
    expect(JSON.parse(audit.changes).previous.every((p) => p.value === null)).toBe(true);
  });
  it('a lost race on the Shipment writes nothing else: no Order write, no audit row', async () => {
    const doc = fakeDoc(['Shipment']);
    expect(await applyOne({ doc, suffix: DEV, entry: entry() })).toEqual({ written: 0, lost: 2 });
    expect(doc.sent).toHaveLength(1);
  });
  it('refuses a field outside the enrich set', async () => {
    const bad = { ...entry(), writes: [{ table: 'Shipment', id: 's1', field: 'status', value: 'X' }] };
    await expect(applyOne({ doc: fakeDoc(), suffix: DEV, entry: bad })).rejects.toThrow(/refusing to write/);
  });
});
