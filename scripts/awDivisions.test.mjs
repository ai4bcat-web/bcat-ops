import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SEED_DIVISIONS, SEED_RULES } from '../src/lib/ownership.ts';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';
import { ALLOW_ENV, PROD_SUFFIX } from './lib/prodGate.mjs';
import { countCompanyRefs, matchDrivers, planDriverTypes, planRetire, reviewDrivers } from './lib/divisionPlan.mjs';
import { SUB_MODELS, applyDriver, divisionsGate, exportDivision, readExport, retireCompany } from './awDivisions.mjs';

const d = (id, name, o = {}) => ({ id, name, type: 'driver', active: true, ...o });
const roster = () => [
  d('chad', 'Chad Salerno', { driverType: 'COMPANY', fleetGroup: 'AMAZON' }),
  d('mike', 'Michael Bodle', { fleetGroup: 'AMAZON' }),
  d('john', 'John Brittich', { driverType: 'COMPANY', fleetGroup: 'LOCAL' }),
  d('jason', 'Jason Smith', { driverType: 'COMPANY', fleetGroup: 'LOCAL' }),
  d('dan', 'Daniel Palmer', { fleetGroup: 'LOCAL' }),
  d('eul', 'Eulalio Cortez', { fleetGroup: 'LOCAL' }),
  d('josh', 'Joshua Kly', { fleetGroup: 'LOCAL' }),
  d('d8a330f5-d927-4ffc-b60f-53d71e9348b4', 'Zak Pace', { fleetGroup: 'BOX_TRUCK', assignedTruckId: 't1' }),
  d('arm', 'Armando Aranda', { driverType: 'COMPANY', fleetGroup: 'LOCAL', active: false }),
  d('charles', 'Charles Best', { fleetGroup: 'LOCAL' }),
  { id: 'b1', name: 'BROKER Chad Salerno', type: 'broker' },
];
const divisions = SEED_DIVISIONS.map((x) => ({ ...x }));
const rules = SEED_RULES.map((x) => ({ ...x }));

describe('driver type plan', () => {
  it('writes only the rows whose type differs, and never Charles Best', () => {
    const { entries, problems } = planDriverTypes(roster());
    expect(problems).toEqual([]);
    const writes = Object.fromEntries(entries.filter((e) => e.status === 'WRITE').map((e) => [e.id.slice(0, 4), `${e.prev}->${e.next}`]));
    expect(writes).toEqual({ chad: 'COMPANY->OWNER_OPERATOR', mike: 'null->OWNER_OPERATOR', dan: 'null->COMPANY', eul: 'null->COMPANY', josh: 'null->COMPANY', d8a3: 'null->COMPANY' });
    expect(entries.some((e) => e.id === 'charles')).toBe(false);
  });

  it('a broker row sharing a name is ignored; two real matches are ambiguous and not written', () => {
    expect(matchDrivers(roster()).matched.get('chad-salerno').id).toBe('chad');
    const dup = [...roster(), d('chad2', 'Chad Salerno')];
    const r = planDriverTypes(dup);
    expect(r.problems).toEqual([{ key: 'chad-salerno', reason: 'AMBIGUOUS_2' }]);
    expect(r.entries.some((e) => e.key === 'chad-salerno')).toBe(false);
  });

  it("Zak is matched by his id AND name: the id on a different name is refused", () => {
    const rows = roster().map((x) => (x.name === 'Zak Pace' ? { ...x, name: 'Someone Else' } : x));
    expect(planDriverTypes(rows).problems).toEqual([{ key: 'zak-pace', reason: 'id matches but name does not' }]);
  });
});

describe('derived division with the real resolver', () => {
  const rows = reviewDrivers({ drivers: roster(), paySettings: [], equipment: [{ id: 't1', unitNumber: '3890', fleetGroup: 'LOCAL' }], divisions, rules });
  const by = Object.fromEntries(rows.map((r) => [r.id.slice(0, 4), r]));
  it('Ryne\'s types land under Ivan Cartage: owner operators in OWNER_OPERATOR, Zak in BOX_TRUCK, the rest in LOCAL', () => {
    expect(by.chad.after).toBe('ASSETS/OWNER_OPERATOR');
    expect(by.mike.after).toBe('ASSETS/OWNER_OPERATOR');
    expect(by.d8a3.after).toBe('ASSETS/BOX_TRUCK');
    for (const k of ['john', 'jaso', 'dan', 'eul', 'josh', 'arm']) expect(by[k].after).toBe('ASSETS/LOCAL');
  });
  it('a type label alone never moves a division here', () => {
    expect(rows.every((r) => r.topUnchanged)).toBe(true);
  });
  it('flags Zak\'s truck sitting in the LOCAL fleet group and Chad staying on the Amazon pay group', () => {
    expect(by.d8a3.flags).toContain('BOX_TRUCK_DRIVER_TRUCK_NOT_BOX_TRUCK_GROUP');
    expect(by.chad.flags.some((f) => f.startsWith('OWNER_OP_ON_AMAZON'))).toBe(true);
  });
});

describe('retiring COMPANY', () => {
  const company = { id: 'COMPANY', code: 'COMPANY', name: 'Company', parentId: null, active: false };
  const divs = [...divisions, company];
  it('is a plain delete when nothing references it', () => {
    const p = planRetire({ divisions: divs, rowsByModel: { Shipment: [{ id: 's', revDivision: 'ASSETS' }] } });
    expect(p).toMatchObject({ status: 'DELETE', blocking: 0, assetsActive: true });
  });
  it('is blocked by a rule, a shipment tag, a profile scope, a saved view or a settings key', () => {
    const rowsByModel = {
      OwnershipRule: [{ id: 'r', divisionCode: 'COMPANY' }],
      Shipment: [{ id: 's', revSubdivision: 'COMPANY' }],
      UserProfile: [{ id: 'u', divisions: ['BROKERAGE', 'COMPANY'] }],
      ShipmentView: [{ id: 'v', filters: JSON.stringify({ divisions: ['COMPANY'] }) }],
      TmsSettings: [{ id: 't', divisionSalesReps: { COMPANY: 'x' } }],
    };
    const refs = countCompanyRefs(rowsByModel);
    expect(Object.keys(refs).sort()).toEqual(['OwnershipRule.divisionCode', 'Shipment.revSubdivision', 'ShipmentView.filters', 'TmsSettings.divisionSalesReps', 'UserProfile.divisions']);
    expect(planRetire({ divisions: divs, rowsByModel }).status).toBe('BLOCKED_BY_REFERENCES');
  });
  it('the division row itself is not a reference; an absent row is ALREADY_GONE', () => {
    expect(planRetire({ divisions: divs, rowsByModel: { OwnershipDivision: [company] } }).blocking).toBe(0);
    expect(planRetire({ divisions, rowsByModel: {} }).status).toBe('ALREADY_GONE');
  });
});

// A DynamoDB document client stand-in: rows per table, honours the conditions these commands use.
function fakeDoc(tables) {
  const sent = [];
  return {
    sent,
    async send(cmd) {
      const n = cmd.constructor.name;
      const i = cmd.input;
      sent.push({ n, i });
      if (n === 'ScanCommand') return { Items: (tables[i.TableName] ?? []).map((r) => ({ ...r })) };
      const rows = (tables[i.TableName] ??= []);
      const fail = () => Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' });
      if (n === 'UpdateCommand') {
        const r = rows.find((x) => x.id === i.Key.id);
        if (!r) throw fail();
        if (':prev' in i.ExpressionAttributeValues ? r.driverType !== i.ExpressionAttributeValues[':prev'] : r.driverType != null && r.driverType !== '') throw fail();
        r.driverType = i.ExpressionAttributeValues[':v'];
        return {};
      }
      if (n === 'DeleteCommand') { tables[i.TableName] = rows.filter((x) => x.id !== i.Key.id); return {}; }
      if (n === 'PutCommand') { rows.push(i.Item); return {}; }
      throw new Error(n);
    },
  };
}
const S = 'x-NONE';

describe('applying', () => {
  it('writes the type once with an audit row holding the previous value; a changed row is left alone', async () => {
    const tables = { [`Driver-${S}`]: [{ id: 'chad', driverType: 'COMPANY' }, { id: 'dan', driverType: 'OWNER_OPERATOR' }] };
    const doc = fakeDoc(tables);
    expect(await applyDriver({ doc, suffix: S, entry: { id: 'chad', key: 'chad-salerno', prev: 'COMPANY', next: 'OWNER_OPERATOR' } })).toBe('written');
    expect(await applyDriver({ doc, suffix: S, entry: { id: 'dan', key: 'daniel-palmer', prev: null, next: 'COMPANY' } })).toBe('lost');
    expect(tables[`Driver-${S}`].map((r) => r.driverType)).toEqual(['OWNER_OPERATOR', 'OWNER_OPERATOR']);
    const audit = tables[`AuditLog-${S}`];
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0].changes)).toMatchObject({ field: 'driverType', previous: 'COMPANY', next: 'OWNER_OPERATOR' });
  });

  it('refuses to apply to the production suffix without the gate', async () => {
    await expect(applyDriver({ doc: fakeDoc({}), suffix: PROD_SUFFIX, entry: { id: 'x', prev: null, next: 'COMPANY' } })).rejects.toThrow(/Refusing to write/);
  });

  it('retire exports the row (0600, sha256 manifest) before deleting; a live reference stops it with nothing deleted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dv-'));
    const company = { id: 'COMPANY', code: 'COMPANY', name: 'Company', parentId: null, active: false };
    const tables = { [`OwnershipDivision-${S}`]: [...divisions, company] };
    const blocked = fakeDoc({ ...tables, [`Shipment-${S}`]: [{ id: 's', revDivision: 'COMPANY' }] });
    expect(await retireCompany({ doc: blocked, suffix: S, exportDir: dir })).toMatchObject({ status: 'BLOCKED_BY_REFERENCES' });
    expect(blocked.sent.some((c) => c.n === 'DeleteCommand')).toBe(false);

    const doc = fakeDoc(tables);
    const r = await retireCompany({ doc, suffix: S, exportDir: dir });
    expect(r.status).toBe('DELETED');
    expect(tables[`OwnershipDivision-${S}`].some((x) => x.id === 'COMPANY')).toBe(false);
    expect(readExport(r.exportDir)).toEqual([company]);
    expect(statSync(join(r.exportDir, 'OwnershipDivision.jsonl')).mode & 0o777).toBe(0o600);
    // a tampered export is refused on restore
    writeFileSync(join(r.exportDir, 'OwnershipDivision.jsonl'), '{}\n');
    expect(() => readExport(r.exportDir)).toThrow(/sha256/);
    expect(readFileSync(join(r.exportDir, 'manifest.json'), 'utf8')).toContain('sha256');
  });

  it('export is written before any delete can happen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dv-'));
    const out = exportDivision({ id: 'COMPANY', code: 'COMPANY' }, { dir });
    expect(statSync(out).mode & 0o777).toBe(0o700);
  });
});

describe('gate', () => {
  const values = { target: 'prod', 'i-mean-production': true, apply: true, 'confirm-prod': `111:${PROD_SUFFIX}` };
  const now = new Date('2026-11-09T12:00:00');
  const backups = (models) => ({ send: async () => ({ BackupSummaries: models.map((m) => ({ TableName: `${m}-${PROD_SUFFIX}`, BackupName: 'prodpre-awDivisions-x', BackupStatus: 'AVAILABLE', BackupCreationDateTime: new Date(now.getTime() - 3600e3) })) }) });
  const base = { now, accountId: async () => '111', out: () => {} };
  it('apply needs the typed token <date>-divisions and a fresh backup of the subcommand tables', async () => {
    const env = { [ALLOW_ENV]: '2026-11-09' };
    await expect(divisionsGate('drivers', values, { ...base, dynamo: backups(SUB_MODELS.drivers), env })).rejects.toThrow(/AW_PROD_CONFIRM must equal 2026-11-09-divisions/);
    await expect(divisionsGate('drivers', values, { ...base, dynamo: backups(['Driver']), env: { ...env, AW_PROD_CONFIRM: '2026-11-09-divisions' } })).rejects.toThrow(/backup/);
    await expect(divisionsGate('drivers', values, { ...base, dynamo: backups(SUB_MODELS.drivers), env: { ...env, AW_PROD_CONFIRM: '2026-11-09-divisions' } })).resolves.toMatchObject({ apply: true });
  });
  it('the prodBackup set covers every subcommand', () => {
    const all = PROD_WRITE_SETS.awDivisions.models;
    for (const m of Object.values(SUB_MODELS).flat()) expect(all).toContain(m);
  });
});
