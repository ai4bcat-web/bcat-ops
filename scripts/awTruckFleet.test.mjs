import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';
import { ALLOW_ENV, PROD_SUFFIX } from './lib/prodGate.mjs';
import { applyRefusal, enumHasValue, planRollback, planStep } from './lib/truckFleetPlan.mjs';
import { SUB_MODELS, applyStep, readExport, rollbackFrom, truckFleetGate } from './awTruckFleet.mjs';

const ZAK = 'd8a330f5-d927-4ffc-b60f-53d71e9348b4';
const drivers = () => [
  { id: ZAK, name: 'Zak Pace', type: 'driver', fleetGroup: 'BOX_TRUCK', assignedTruckId: 't3890' },
  { id: 'chad', name: 'Chad Salerno', type: 'driver', fleetGroup: 'OWNER_OPERATOR', assignedTruckId: 't423166' },
  { id: 'lee', name: 'Lee Lara', type: 'driver', fleetGroup: 'OWNER_OPERATOR', assignedTruckId: 't009' },
  { id: 'mike', name: 'Michael Bodle', type: 'driver', fleetGroup: 'OWNER_OPERATOR', assignedTruckId: 't0012' },
  { id: 'b1', name: 'BROKER Chad Salerno', type: 'broker' },
];
const eq = () => [
  { id: 't3890', type: 'truck', unitNumber: '3890', fleetGroup: 'LOCAL', assignedDriverId: ZAK },
  { id: 't423166', type: 'truck', unitNumber: '423166', fleetGroup: 'AMAZON', assignedDriverId: 'chad' },
  { id: 't009', type: 'truck', unitNumber: '009', fleetGroup: 'AMAZON', assignedDriverId: 'lee' },
  { id: 't0012', type: 'truck', unitNumber: '0012', fleetGroup: 'AMAZON', assignedDriverId: 'mike' },
  { id: 'tr1', type: 'trailer', unitNumber: 'T-1', fleetGroup: null, assignedDriverId: 'lee' },
];

describe('plan', () => {
  it('box-truck writes only Zak truck 3890 LOCAL->BOX_TRUCK; owner-operator writes the three AMAZON trucks; trailers are reported not planned', () => {
    const box = planStep('box-truck', { drivers: drivers(), equipment: eq() });
    expect(box.toWrite.map((e) => `${e.unit}:${e.current}->${e.to}`)).toEqual(['3890:LOCAL->BOX_TRUCK']);
    const oo = planStep('owner-operator', { drivers: drivers(), equipment: eq() });
    expect(oo.toWrite.map((e) => `${e.unit}:${e.current}->${e.to}`)).toEqual(['423166:AMAZON->OWNER_OPERATOR', '009:AMAZON->OWNER_OPERATOR', '0012:AMAZON->OWNER_OPERATOR']);
    expect(oo.entries.find((e) => e.key === 'lee-lara').trailers).toEqual([{ unit: 'T-1', fleetGroup: null }]);
  });

  it('is idempotent and refuses to guess: done rows are skipped; wrong unit, other fleet value, ambiguous or missing driver are PROBLEM', () => {
    const done = eq().map((e) => (e.id === 't3890' ? { ...e, fleetGroup: 'BOX_TRUCK' } : e));
    expect(planStep('box-truck', { drivers: drivers(), equipment: done }).entries[0].status).toBe('DONE');
    const moved = eq().map((e) => (e.id === 't009' ? { ...e, fleetGroup: 'LOCAL' } : e));
    expect(planStep('owner-operator', { drivers: drivers(), equipment: moved }).entries.find((e) => e.key === 'lee-lara').problem).toBe('FLEET_IS_LOCAL_NOT_AMAZON');
    const wrongUnit = eq().map((e) => (e.id === 't3890' ? { ...e, unitNumber: '3891' } : e));
    expect(planStep('box-truck', { drivers: drivers(), equipment: wrongUnit }).entries[0].problem).toBe('UNIT_3891_NOT_3890');
    expect(planStep('owner-operator', { drivers: [...drivers(), { id: 'c2', name: 'Chad Salerno', type: 'driver' }], equipment: eq() }).entries[0].problem).toBe('DRIVER_AMBIGUOUS_2');
    expect(planStep('owner-operator', { drivers: drivers().filter((d) => d.id !== 'lee'), equipment: eq() }).entries[1].problem).toBe('DRIVER_NOT_FOUND');
  });

  it('Zak is matched by id AND name', () => {
    const d = drivers().map((x) => (x.id === ZAK ? { ...x, name: 'Someone Else' } : x));
    expect(planStep('box-truck', { drivers: d, equipment: eq() }).entries[0].problem).toBe('ID_MATCHES_BUT_NAME_DOES_NOT');
  });

  it('owner-operator is refused until the live schema has the enum value; box-truck needs no schema; a PROBLEM refuses both', () => {
    expect(applyRefusal('owner-operator', { problems: [], enumHasTarget: false })).toMatch(/no OWNER_OPERATOR yet/);
    expect(applyRefusal('owner-operator', { problems: [], enumHasTarget: true })).toBeNull();
    expect(applyRefusal('box-truck', { problems: [], enumHasTarget: true })).toBeNull();
    expect(applyRefusal('box-truck', { problems: [{ key: 'zak-pace', problem: 'X' }], enumHasTarget: true })).toMatch(/PROBLEM/);
    const sdl = 'enum EquipmentFleetGroup {\n  AMAZON\n  BOX_TRUCK\n  LOCAL\n}\n';
    expect(enumHasValue(sdl, 'EquipmentFleetGroup', 'OWNER_OPERATOR')).toBe(false);
    expect(enumHasValue(sdl.replace('LOCAL', 'LOCAL\n  OWNER_OPERATOR'), 'EquipmentFleetGroup', 'OWNER_OPERATOR')).toBe(true);
  });
});

function fakeDoc(tables) {
  return {
    async send(cmd) {
      const n = cmd.constructor.name;
      const i = cmd.input;
      if (n === 'ScanCommand') return { Items: (tables[i.TableName] ?? []).map((r) => ({ ...r })) };
      const rows = (tables[i.TableName] ??= []);
      if (n === 'UpdateCommand') {
        const r = rows.find((x) => x.id === i.Key.id);
        if (!r || r.fleetGroup !== i.ExpressionAttributeValues[':from']) throw Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' });
        r.fleetGroup = i.ExpressionAttributeValues[':to'];
        return {};
      }
      if (n === 'PutCommand') { rows.push(i.Item); return {}; }
      throw new Error(n);
    },
  };
}
const S = 'x-NONE';

describe('apply + rollback', () => {
  it('writes Equipment.fleetGroup only, audits the previous value, exports first, is idempotent, and rolls back', async () => {
    const tables = { [`Equipment-${S}`]: eq(), [`AuditLog-${S}`]: [] };
    const before = JSON.parse(JSON.stringify(tables[`Equipment-${S}`]));
    const doc = fakeDoc(tables);
    const dir = mkdtempSync(join(tmpdir(), 'tf-'));
    const rowsById = new Map(tables[`Equipment-${S}`].map((e) => [e.id, e]));
    const snap = JSON.parse(JSON.stringify([...rowsById.values()]));
    const rowsSnap = new Map(snap.map((e) => [e.id, e]));
    const plan = planStep('box-truck', { drivers: drivers(), equipment: snap });
    const r = await applyStep({ doc, suffix: S, step: 'box-truck', plan, rowsById: rowsSnap, exportDir: dir });
    expect(r).toMatchObject({ written: 1, lost: 0 });
    const after = tables[`Equipment-${S}`];
    expect(after.find((e) => e.id === 't3890').fleetGroup).toBe('BOX_TRUCK');
    // nothing else changed: other trucks and the trailer keep their values, Zak's assignment is untouched
    expect(after.filter((e) => e.id !== 't3890').map((e) => e.fleetGroup)).toEqual(before.filter((e) => e.id !== 't3890').map((e) => e.fleetGroup));
    expect(after.find((e) => e.id === 't3890').assignedDriverId).toBe(ZAK);
    const audit = tables[`AuditLog-${S}`];
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0].changes)).toMatchObject({ field: 'fleetGroup', previous: 'LOCAL', next: 'BOX_TRUCK', unit: '3890' });
    // export holds the before row, 0600, checkpointed, tamper-evident
    const { manifest, rows } = readExport(r.exportDir);
    expect(rows[0]).toMatchObject({ id: 't3890', fleetGroup: 'LOCAL' });
    expect(manifest.entries[0]).toMatchObject({ from: 'LOCAL', to: 'BOX_TRUCK' });
    expect(statSync(join(r.exportDir, 'Equipment.jsonl')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(r.exportDir, 'checkpoint.jsonl'), 'utf8')).toContain('"written"');
    // a re-plan against the new state has nothing to write (idempotent)
    expect(planStep('box-truck', { drivers: drivers(), equipment: after }).toWrite).toEqual([]);
    // rollback restores LOCAL, and a second rollback does nothing
    expect(await rollbackFrom({ doc, suffix: S, from: r.exportDir })).toMatchObject({ restored: 1, skipped: 0 });
    expect(after.find((e) => e.id === 't3890').fleetGroup).toBe('LOCAL');
    expect(await rollbackFrom({ doc, suffix: S, from: r.exportDir })).toMatchObject({ restored: 0, skipped: 1 });
    expect(tables[`AuditLog-${S}`]).toHaveLength(2);
    writeFileSync(join(r.exportDir, 'Equipment.jsonl'), '{}\n');
    expect(() => readExport(r.exportDir)).toThrow(/sha256/);
  });

  it('a row changed by someone else between plan and write is lost, not overwritten', async () => {
    const tables = { [`Equipment-${S}`]: eq().map((e) => (e.id === 't3890' ? { ...e, fleetGroup: 'AMAZON' } : e)), [`AuditLog-${S}`]: [] };
    const plan = planStep('box-truck', { drivers: drivers(), equipment: eq() });
    const r = await applyStep({ doc: fakeDoc(tables), suffix: S, step: 'box-truck', plan, rowsById: new Map(eq().map((e) => [e.id, e])), exportDir: mkdtempSync(join(tmpdir(), 'tf-')) });
    expect(r).toMatchObject({ written: 0, lost: 1 });
    expect(tables[`Equipment-${S}`].find((e) => e.id === 't3890').fleetGroup).toBe('AMAZON');
    expect(tables[`AuditLog-${S}`]).toEqual([]);
  });

  it('rollback leaves rows changed since (not at the value this script wrote)', () => {
    const manifest = { entries: [{ equipmentId: 'a', from: 'LOCAL', to: 'BOX_TRUCK' }, { equipmentId: 'b', from: 'LOCAL', to: 'BOX_TRUCK' }, { equipmentId: 'c', from: 'LOCAL', to: 'BOX_TRUCK' }] };
    const cur = new Map([['a', { fleetGroup: 'AMAZON' }], ['b', { fleetGroup: 'BOX_TRUCK' }]]);
    expect(planRollback(manifest, cur).map((p) => p.status)).toEqual(['CHANGED_SINCE', 'RESTORE', 'MISSING']);
  });
});

describe('gate', () => {
  const values = { target: 'prod', 'i-mean-production': true, apply: true, 'confirm-prod': `111:${PROD_SUFFIX}` };
  const now = new Date('2026-11-09T12:00:00');
  const backups = (models) => ({ send: async () => ({ BackupSummaries: models.map((m) => ({ TableName: `${m}-${PROD_SUFFIX}`, BackupName: 'prodpre-awTruckFleet-x', BackupStatus: 'AVAILABLE', BackupCreationDateTime: new Date(now.getTime() - 3600e3) })) }) });
  const base = { now, accountId: async () => '111', out: () => {} };
  it('apply needs the typed token <date>-truckfleet and a fresh backup of Equipment + AuditLog', async () => {
    const env = { [ALLOW_ENV]: '2026-11-09' };
    await expect(truckFleetGate('box-truck', values, { ...base, dynamo: backups(SUB_MODELS['box-truck']), env })).rejects.toThrow(/AW_PROD_CONFIRM must equal 2026-11-09-truckfleet/);
    await expect(truckFleetGate('box-truck', values, { ...base, dynamo: backups(['Equipment']), env: { ...env, AW_PROD_CONFIRM: '2026-11-09-truckfleet' } })).rejects.toThrow(/backup/);
    await expect(truckFleetGate('box-truck', values, { ...base, dynamo: backups(SUB_MODELS['box-truck']), env: { ...env, AW_PROD_CONFIRM: '2026-11-09-truckfleet' } })).resolves.toMatchObject({ apply: true });
  });
  it('the prodBackup set covers every subcommand', () => {
    for (const m of Object.values(SUB_MODELS).flat()) expect(PROD_WRITE_SETS.awTruckFleet.models).toContain(m);
  });
});
