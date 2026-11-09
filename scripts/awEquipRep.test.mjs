import { describe, expect, it } from 'vitest';
import { AUDIT_ACTION, applyOne, equipRepGate, sourcePaths } from './awEquipRep.mjs';
import {
  EQUIPMENT_MAP, buildIdMapping, classifyEquipmentCode, indexExport, indexSources, missingFromSources, parseAlsoMap, parseShipDate, planShipment, proKey,
} from './lib/equipRepPlan.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';
import { resolveScripts } from './prodBackup.mjs';
import { ALLOW_ENV, PROD_SUFFIX } from './lib/prodGate.mjs';
import { normalizeEquipment } from '../src/lib/laneMatch.ts';

const src = (rows) => indexSources(rows.map(([pro, equipment, rep]) => ({ pro, equipment, rep }))).byPro;
const ship = (o = {}) => ({ id: 's1', number: '12345', revDivision: 'ASSETS', ...o });
const plan = (o = {}) => planShipment({
  shipment: ship(), loads: [{ id: 'l1' }], orders: [{ id: 'o1' }], src: src([['12345', 'V', 'RYNE BANDOLIK']]).get('12345'), repId: '001', idMap: [], ...o,
});

describe('joins and dates', () => {
  it('L<pro> originals, padded and labelled PROs share one key; non-numeric PROs never join', () => {
    expect(proKey('L14727')).toBe('14727');
    expect(proKey('14440  ')).toBe('14440');
    expect(proKey('PRO# 9471')).toBe('9471');
    expect(proKey('S000123-1')).toBeNull();
  });
  it('parses mm/dd/yy, rejects junk', () => {
    expect(parseShipDate('01/02/24')).toBe('2024-01-02');
    expect(parseShipDate('')).toBeNull();
    expect(parseShipDate('13/40/24')).toBeNull();
  });
  it('an implausible ship date (yy=70) counts as no ship date, not as in scope', () => {
    const m = indexExport([{ pro: '1111', shipDate: '01/01/70', repId: '' }, { pro: '2222', shipDate: '03/04/25', repId: '' }]);
    expect(m.get('1111').shipDate).toBeNull();
    expect(m.get('2222').shipDate).toBe('2025-03-04');
  });
});

describe('equipment mapping', () => {
  it('maps only codes the app has a value for, using values the app normalizes to its own vocabulary', () => {
    expect(classifyEquipmentCode('v')).toMatchObject({ kind: 'EQUIPMENT', value: 'Dry Van' });
    expect(normalizeEquipment(EQUIPMENT_MAP.V)).toBe('VAN');
    expect(normalizeEquipment(EQUIPMENT_MAP.R)).toBe('REEFER');
    expect(normalizeEquipment(EQUIPMENT_MAP.F)).toBe('FLATBED');
  });
  it('ZAK is a driver, never equipment, even through --also-map', () => {
    expect(classifyEquipmentCode('ZAK').kind).toBe('DRIVER');
    expect(() => parseAlsoMap('ZAK=Van')).toThrow(/driver/);
    expect(() => parseAlsoMap('V=Van')).toThrow(/already/);
  });
  it('FTL/OCN have no app value and unknown codes stay blank; --also-map opts a code in', () => {
    expect(classifyEquipmentCode('FTL').kind).toBe('NO_APP_VALUE');
    expect(classifyEquipmentCode('PO').kind).toBe('UNKNOWN');
    expect(classifyEquipmentCode('FTL', parseAlsoMap('FTL=Full Truckload'))).toMatchObject({ kind: 'EQUIPMENT', value: 'Full Truckload' });
  });
});

describe('planShipment: enrich only', () => {
  it('writes equipment on every empty Load/Order and the rep name on the shipment', () => {
    const p = plan();
    expect(p.writes).toEqual([
      { table: 'Load', id: 'l1', field: 'equipmentType', value: 'Dry Van' },
      { table: 'Order', id: 'o1', field: 'equipmentType', value: 'Dry Van' },
      { table: 'Shipment', id: 's1', field: 'salesRepCode', value: 'RYNE BANDOLIK' },
    ]);
  });
  it('never overwrites a non-empty value; fills only the empty target', () => {
    const p = plan({ loads: [{ id: 'l1', equipmentType: 'Reefer' }], shipment: ship({ salesRepCode: 'X' }) });
    expect(p.writes).toEqual([{ table: 'Order', id: 'o1', field: 'equipmentType', value: 'Dry Van' }]);
    expect(p.rep.status).toBe('ALREADY_SET');
    const all = plan({ loads: [{ id: 'l1', equipmentType: 'Reefer' }], orders: [{ id: 'o1', equipmentType: 'Van' }] });
    expect(all.equipment.status).toBe('ALREADY_SET');
  });
  it('ZAK and unknown codes write no equipment but keep the rep', () => {
    for (const code of ['ZAK', 'PO', 'FTL']) {
      const p = plan({ src: src([['12345', code, 'RYNE BANDOLIK']]).get('12345') });
      expect(p.writes.map((w) => w.field)).toEqual(['salesRepCode']);
    }
  });
  it('conflicting values across files are listed, not applied', () => {
    const p = plan({ src: src([['12345', 'V', 'RYNE BANDOLIK'], ['12345', 'R', 'RUBEN VARGAS']]).get('12345') });
    expect(p.writes).toEqual([]);
    expect(p.equipment.status).toBe('CONFLICT');
    expect(p.rep.status).toBe('CONFLICT');
  });
  it('the same value repeated in several files is not a conflict', () => {
    expect(plan({ src: src([['12345', 'V', 'RYNE BANDOLIK'], ['12345', 'v', 'RYNE BANDOLIK']]).get('12345') }).writes).toHaveLength(3);
  });
  it('division group names are compared with revDivision and never written', () => {
    const agree = plan({ src: src([['12345', '', 'IVAN CARTAGE CO']]).get('12345') });
    expect(agree.rep).toMatchObject({ status: 'DIVISION_AGREES', kind: 'DIVISION' });
    expect(agree.writes).toEqual([]);
    expect(plan({ src: src([['12345', '', 'BCAT']]).get('12345') }).rep.status).toBe('DIVISION_DISAGREES');
    const oo = plan({ shipment: ship({ revSubdivision: 'OWNER_OPERATOR' }), src: src([['12345', '', 'OWNER OPERATORS']]).get('12345') });
    expect(oo.rep.status).toBe('DIVISION_AGREES');
  });
  it('without a file row the Aljex id mapping fills in only when unambiguous', () => {
    const idMap = [{ id: '001', dominant: 'RYNE BANDOLIK', ambiguous: false }, { id: '002', dominant: 'RUBEN VARGAS', ambiguous: true }];
    expect(plan({ src: null, idMap }).writes).toEqual([{ table: 'Shipment', id: 's1', field: 'salesRepCode', value: 'RYNE BANDOLIK' }]);
    expect(plan({ src: null, repId: '002', idMap })).toMatchObject({ rep: { status: 'ID_AMBIGUOUS' }, writes: [] });
    expect(plan({ src: null, repId: '009', idMap }).rep.status).toBe('NO_SOURCE');
  });
});

describe('id mapping purity', () => {
  const ex = (pairs) => indexExport(pairs.map(([pro, repId]) => ({ pro, shipDate: '01/01/25', repId })));
  const mk = (n, name) => Array.from({ length: n }, () => name);
  it('flags < 95% purity and ties as ambiguous', () => {
    const exportRows = []; const srcRows = []; let pro = 1;
    const add = (id, names) => names.forEach((n) => { exportRows.push([String(1000 + pro), id]); srcRows.push([String(1000 + pro), 'V', n]); pro += 1; });
    add('001', [...mk(19, 'A'), 'B']);
    add('002', [...mk(10, 'C'), ...mk(10, 'D')]);
    add('003', mk(20, 'E'));
    const map = buildIdMapping(ex(exportRows), src(srcRows));
    const by = Object.fromEntries(map.map((m) => [m.id, m]));
    expect(by['001']).toMatchObject({ dominant: 'A', ambiguous: false, purity: 0.95 });
    expect(by['002']).toMatchObject({ tie: true, ambiguous: true });
    expect(by['003'].purity).toBe(1);
  });
  it('lists in-scope PROs with no source row', () => {
    const m = indexExport([{ pro: '1001', shipDate: '01/01/24' }, { pro: '1002', shipDate: '01/01/25' }, { pro: '1003', shipDate: '02/01/25' }].map((r) => ({ ...r, repId: '' })));
    expect(missingFromSources(m, src([['1003', 'V', 'X']]), new Set(['1002']))).toEqual([{ pro: '1002', shipDate: '2025-01-01', inProd: true }]);
  });
});

describe('applyOne', () => {
  const entry = {
    shipment: { id: 's1' }, pro: '12345', shipDate: '2025-02-02', equipment: { code: 'V' }, rep: { source: 'FILE' },
    writes: [{ table: 'Load', id: 'l1', field: 'equipmentType', value: 'Dry Van' }, { table: 'Shipment', id: 's1', field: 'salesRepCode', value: 'X' }],
  };
  const fakeDoc = (failTables = []) => {
    const sent = [];
    return { sent, send: async (cmd) => {
      sent.push(cmd);
      const t = cmd.input.TableName;
      if (cmd.constructor.name === 'UpdateCommand' && failTables.some((f) => t.startsWith(f))) { const e = new Error('c'); e.name = 'ConditionalCheckFailedException'; throw e; }
    } };
  };
  it('writes each field conditionally on emptiness, only the allowed fields, and one audit row', async () => {
    const doc = fakeDoc();
    expect(await applyOne({ doc, suffix: 'dev-x', entry })).toEqual({ written: 2, lost: 0 });
    const updates = doc.sent.filter((c) => c.constructor.name === 'UpdateCommand');
    expect(updates).toHaveLength(2);
    for (const u of updates) expect(u.input.ConditionExpression).toMatch(/attribute_not_exists\(#f\).*#f = :blank/);
    const audits = doc.sent.filter((c) => c.constructor.name === 'PutCommand');
    expect(audits).toHaveLength(1);
    expect(audits[0].input.Item.action).toBe(AUDIT_ACTION);
    expect(JSON.parse(audits[0].input.Item.changes).previous).toHaveLength(2);
  });
  it('a target filled meanwhile is skipped; nothing written means no audit row', async () => {
    const doc = fakeDoc(['Load', 'Shipment']);
    expect(await applyOne({ doc, suffix: 'dev-x', entry })).toEqual({ written: 0, lost: 2 });
    expect(doc.sent.filter((c) => c.constructor.name === 'PutCommand')).toHaveLength(0);
  });
  it('refuses a field outside the enrich list and the production suffix without the gate', async () => {
    const bad = { ...entry, writes: [{ table: 'Order', id: 'o', field: 'revenueCents', value: '1' }] };
    await expect(applyOne({ doc: fakeDoc(), suffix: 'dev-x', entry: bad })).rejects.toThrow(/refusing to write/);
    await expect(applyOne({ doc: fakeDoc(), suffix: PROD_SUFFIX, entry })).rejects.toThrow();
  });
});

describe('gate', () => {
  it('is registered for backups of exactly the tables it writes', () => {
    expect(PROD_WRITE_SETS.awEquipRep.models.sort()).toEqual(['AuditLog', 'Load', 'Order', 'Shipment']);
    expect(resolveScripts('awEquipRep')).toEqual(['awEquipRep']);
  });
  it('an apply refuses without BCAT_ALLOW_PROD, with a stale backup, or without the typed AW_PROD_CONFIRM', async () => {
    const now = new Date('2026-11-08T12:00:00');
    const values = { target: 'prod', 'i-mean-production': true, apply: true, 'confirm-prod': `111:${PROD_SUFFIX}` };
    const fresh = { send: async () => ({ BackupSummaries: ['Shipment', 'Load', 'Order', 'AuditLog'].map((t) => ({ TableName: `${t}-${PROD_SUFFIX}`, BackupName: `prodpre-awEquipRep-${t}`, BackupStatus: 'AVAILABLE', BackupCreationDateTime: new Date('2026-11-08T11:00:00') })) }) };
    const base = { now, dynamo: fresh, accountId: async () => '111', out: () => {} };
    await expect(equipRepGate(values, { ...base, env: {} })).rejects.toThrow(/closed/);
    await expect(equipRepGate(values, { ...base, env: { [ALLOW_ENV]: '2026-11-08' } })).rejects.toThrow(/AW_PROD_CONFIRM must equal 2026-11-08-equiprep/);
    await expect(equipRepGate(values, { ...base, dynamo: { send: async () => ({ BackupSummaries: [] }) }, env: { [ALLOW_ENV]: '2026-11-08', AW_PROD_CONFIRM: '2026-11-08-equiprep' } })).rejects.toThrow(/closed/);
    await expect(equipRepGate(values, { ...base, env: { [ALLOW_ENV]: '2026-11-08', AW_PROD_CONFIRM: '2026-11-08-equiprep' } })).resolves.toMatchObject({ apply: true });
  });
  it('--files and --dir are merged without duplicates', () => {
    expect(sourcePaths({ files: '/a/x.csv,/a/x.csv' })).toEqual(['/a/x.csv']);
  });
});
