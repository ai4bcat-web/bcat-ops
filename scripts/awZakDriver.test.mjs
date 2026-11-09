import { describe, expect, it } from 'vitest';
import { AUDIT_ACTION, applyOne, resolveZak, zakDriverGate } from './awZakDriver.mjs';
import { STATUS, ZAK_DRIVER_ID, planWrites, planZak, zakPros } from './lib/zakDriverPlan.mjs';
import { indexSources } from './lib/equipRepPlan.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';
import { resolveScripts } from './prodBackup.mjs';
import { ALLOW_ENV, PROD_SUFFIX } from './lib/prodGate.mjs';

const driver = { id: ZAK_DRIVER_ID, name: 'Zak Pace', phone: '555-0100' };
const exportByPro = new Map([['1001', { shipDate: '2026-03-01' }], ['1002', { shipDate: '2024-12-31' }], ['1003', { shipDate: '2026-03-01' }]]);
const world = (o = {}) => ({
  shipments: [{ id: 's1', number: '1001' }], loads: [{ id: 'l1', shipmentId: 's1', status: 'DELIVERED' }],
  legs: [{ id: 'c1', loadId: 'l1', kind: 'OWN_ASSET', status: 'ACTIVE' }], claims: [], zakProSet: new Set(['1001']), exportByPro, driver, ...o,
});
const only = (o) => planZak(world(o))[0];

describe('which PROs are Zak', () => {
  it('only an exact ZAK code; a PRO with ZAK and another code is a conflict and not ours', () => {
    const src = indexSources([{ pro: '10001', equipment: 'zak ' }, { pro: '10002', equipment: 'ZAK' }, { pro: '10002', equipment: 'V' }, { pro: '10003', equipment: 'V' }]).byPro;
    const { zak, conflicted } = zakPros(src);
    expect([...zak]).toEqual(['10001']);
    expect([...conflicted]).toEqual(['10002']);
  });
});

describe('planning (enrich only, never overwrite)', () => {
  it('a leg with no driver gets id, name and phone', () => {
    const r = only({});
    expect(r.status).toBe(STATUS.TO_SET);
    expect(r.writes.map((w) => `${w.table}.${w.field}`)).toEqual(['LoadCarrier.driverId', 'LoadCarrier.driverName', 'LoadCarrier.driverPhone']);
  });
  it('never writes a Load, stop or pay field', () => {
    expect(only({}).writes.every((w) => w.table === 'LoadCarrier')).toBe(true);
  });
  it('Zak already on the leg with a blank name only fills the name; with a name, nothing to do', () => {
    const named = { id: 'c1', loadId: 'l1', kind: 'OWN_ASSET', status: 'ACTIVE', driverId: ZAK_DRIVER_ID };
    expect(only({ legs: [named] }).writes.map((w) => w.field)).toEqual(['driverName']);
    expect(only({ legs: [{ ...named, driverName: 'Zak Pace' }] }).status).toBe(STATUS.ALREADY_ZAK);
  });
  it('a different driver on the leg, the load mirrors or a stop is listed and nothing is written', () => {
    const leg = { id: 'c1', loadId: 'l1', kind: 'OWN_ASSET', status: 'ACTIVE' };
    for (const [loads, legs] of [
      [undefined, [{ ...leg, driverId: 'other' }]],
      [[{ id: 'l1', shipmentId: 's1', deliveryDriverId: 'other' }], undefined],
      [[{ id: 'l1', shipmentId: 's1', stops: JSON.stringify([{ sequence: 0, driverId: 'other' }]) }], undefined],
    ]) {
      const r = only({ ...(loads && { loads }), ...(legs && { legs }) });
      expect(r.status).toBe(STATUS.DIFFERENT_DRIVER);
      expect(r.currentDriverId).toBe('other');
      expect(r.writes).toEqual([]);
    }
  });
  it('planWrites keeps a name and phone already on the leg', () => {
    const w = planWrites({ load: {}, leg: { id: 'c', driverName: 'X', driverPhone: '1' }, driver });
    expect(w.map((x) => x.field)).toEqual(['driverId']);
  });
  it('no own-asset leg, a carrier leg, unknown PRO, older than 2025 and voided are never written', () => {
    expect(only({ legs: [] }).status).toBe(STATUS.NO_LEG);
    const carrier = only({ legs: [{ id: 'c1', loadId: 'l1', kind: 'CARRIER', status: 'ACTIVE' }] });
    expect(carrier.status).toBe(STATUS.OTHER);
    expect(only({ zakProSet: new Set(['9999']) }).status).toBe(STATUS.NOT_FOUND);
    const older = only({ shipments: [{ id: 's1', number: '1002' }], zakProSet: new Set(['1002']) });
    expect(older.status).toBe(STATUS.OLDER);
    expect(older.writes).toEqual([]);
    expect(only({ shipments: [{ id: 's1', number: '1001', voidedAt: 'x' }] }).status).toBe(STATUS.VOIDED);
  });
  it('joins L<pro> numbers and a shipment with an unusable ship date is not written', () => {
    expect(only({ shipments: [{ id: 's1', number: 'L1001' }] }).status).toBe(STATUS.TO_SET);
    expect(only({ exportByPro: new Map([['1001', { shipDate: null }]]) }).status).toBe(STATUS.NO_SHIP_DATE);
  });
  it('two live shipments or loads for one PRO are ambiguous, not guessed', () => {
    expect(only({ shipments: [{ id: 's1', number: '1001' }, { id: 's2', number: '1001' }] }).status).toBe(STATUS.OTHER);
    expect(only({ loads: [{ id: 'l1', shipmentId: 's1' }, { id: 'l2', shipmentId: 's1' }] }).status).toBe(STATUS.OTHER);
  });
});

describe('roster check', () => {
  const roster = [{ id: ZAK_DRIVER_ID, name: 'Zak Pace', active: true }, { id: 'b', name: 'Bob' }];
  it('accepts the one Zak and refuses a missing id, a second Zak or an inactive one', () => {
    expect(resolveZak(roster).id).toBe(ZAK_DRIVER_ID);
    expect(() => resolveZak([roster[1]])).toThrow(/does not exist/);
    expect(() => resolveZak([...roster, { id: 'z2', name: 'Zak Other' }])).toThrow(/only Zak/);
    expect(() => resolveZak([{ ...roster[0], active: false }])).toThrow(/not a usable/);
  });
});

describe('applyOne', () => {
  const entry = {
    pro: '1001', shipDate: '2026-03-01', loadId: 'l1', shipmentId: 's1', legId: 'c1',
    writes: [{ table: 'LoadCarrier', id: 'c1', field: 'driverId', value: ZAK_DRIVER_ID }, { table: 'LoadCarrier', id: 'c1', field: 'driverName', value: 'Zak Pace' }],
  };
  const fakeDoc = (fail = []) => {
    const sent = [];
    return { sent, send: async (cmd) => {
      sent.push(cmd);
      if (cmd.constructor.name === 'UpdateCommand' && fail.includes(cmd.input.ExpressionAttributeNames['#f'])) { const e = new Error('c'); e.name = 'ConditionalCheckFailedException'; throw e; }
    } };
  };
  it('writes conditionally on an empty target, the name only beside Zak, plus one audit row with the previous blank', async () => {
    const doc = fakeDoc();
    expect(await applyOne({ doc, suffix: 'dev-x', entry })).toEqual({ written: 2, lost: 0 });
    const [id, name] = doc.sent.filter((c) => c.constructor.name === 'UpdateCommand');
    expect(id.input.ConditionExpression).toMatch(/attribute_not_exists\(#f\).*#f = :blank/);
    expect(id.input.ConditionExpression).not.toMatch(/:zak/);
    expect(name.input.ConditionExpression).toMatch(/#d = :zak/);
    const audits = doc.sent.filter((c) => c.constructor.name === 'PutCommand');
    expect(audits).toHaveLength(1);
    expect(audits[0].input.Item.action).toBe(AUDIT_ACTION);
    expect(JSON.parse(audits[0].input.Item.changes).previous.every((p) => p.value === null)).toBe(true);
  });
  it('a leg someone filled meanwhile is skipped and leaves no audit row', async () => {
    const doc = fakeDoc(['driverId', 'driverName']);
    expect(await applyOne({ doc, suffix: 'dev-x', entry })).toEqual({ written: 0, lost: 2 });
    expect(doc.sent.filter((c) => c.constructor.name === 'PutCommand')).toHaveLength(0);
  });
  it('refuses any field outside the leg driver fields, and production without the gate', async () => {
    for (const bad of [{ table: 'Load', id: 'l1', field: 'deliveryDriverId', value: 'x' }, { table: 'LoadCarrier', id: 'c1', field: 'carrierRateCents', value: 1 }]) {
      await expect(applyOne({ doc: fakeDoc(), suffix: 'dev-x', entry: { ...entry, writes: [bad] } })).rejects.toThrow(/refusing to write/);
    }
    await expect(applyOne({ doc: fakeDoc(), suffix: PROD_SUFFIX, entry })).rejects.toThrow();
  });
});

describe('gate', () => {
  it('is registered for backups of exactly the tables it writes', () => {
    expect([...PROD_WRITE_SETS.awZakDriver.models].sort()).toEqual(['AuditLog', 'LoadCarrier']);
    expect(resolveScripts('awZakDriver')).toEqual(['awZakDriver']);
  });
  it('an apply refuses without BCAT_ALLOW_PROD, with a stale backup, or without the typed AW_PROD_CONFIRM', async () => {
    const now = new Date('2026-11-09T12:00:00');
    const values = { target: 'prod', 'i-mean-production': true, apply: true, 'confirm-prod': `111:${PROD_SUFFIX}` };
    const fresh = { send: async () => ({ BackupSummaries: ['LoadCarrier', 'AuditLog'].map((t) => ({ TableName: `${t}-${PROD_SUFFIX}`, BackupName: `prodpre-awZakDriver-${t}`, BackupStatus: 'AVAILABLE', BackupCreationDateTime: new Date('2026-11-09T11:00:00') })) }) };
    const base = { now, dynamo: fresh, accountId: async () => '111', out: () => {} };
    const ok = { [ALLOW_ENV]: '2026-11-09', AW_PROD_CONFIRM: '2026-11-09-zakdriver' };
    await expect(zakDriverGate(values, { ...base, env: {} })).rejects.toThrow(/closed/);
    await expect(zakDriverGate(values, { ...base, env: { [ALLOW_ENV]: '2026-11-09' } })).rejects.toThrow(/AW_PROD_CONFIRM must equal 2026-11-09-zakdriver/);
    await expect(zakDriverGate(values, { ...base, env: { ...ok, AW_PROD_CONFIRM: '2026-11-09-equiprep' } })).rejects.toThrow(/AW_PROD_CONFIRM/);
    await expect(zakDriverGate(values, { ...base, dynamo: { send: async () => ({ BackupSummaries: [] }) }, env: ok })).rejects.toThrow(/closed/);
    await expect(zakDriverGate(values, { ...base, env: ok })).resolves.toMatchObject({ apply: true });
  });
});
