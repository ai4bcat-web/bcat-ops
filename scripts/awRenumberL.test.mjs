import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, appendFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planRenumber, exportPlan, verifyExport, applyEntry, FIELDS } from './awRenumberL.mjs';

function fixture() {
  const t = { Shipment: [{ id: 's', number: 'L14334  ', searchKey: 'l14334   customer', status: 'DELIVERED' }], Load: [{ id: 'l', shipmentId: 's', aljexId: '14334  ', loadNumber: 'L14334  -1', rate: 12345 }], ProClaim: [{ id: '14334', shipmentId: 's', loadId: 'l' }] };
  for (const model of Object.keys(FIELDS)) if (!t[model]) t[model] = [{ id: model, shipmentId: 's', shipmentNumber: 'L14334  ', loadNumber: 'L14334  -1', amountCents: 12345 }];
  return t;
}
class FakeDoc {
  constructor(t) { this.rows = new Map(Object.entries(t).flatMap(([m, rows]) => rows.map((r) => [`${m}-test/${r.id}`, structuredClone(r)]))); }
  async send(c) {
    const p = c.input;
    if (c.constructor.name === 'GetCommand') return { Item: this.rows.get(`${p.TableName}/${p.Key.id}`) };
    if (c.constructor.name !== 'TransactWriteCommand') throw new Error('unexpected command');
    const next = new Map(this.rows);
    for (const op of p.TransactItems) {
      if (op.Put) { const k = `${op.Put.TableName}/${op.Put.Item.id}`; if (next.has(k)) throw new Error('condition'); next.set(k, op.Put.Item); continue; }
      const u = op.Update; const k = `${u.TableName}/${u.Key.id}`; const row = next.get(k);
      if (!row) throw new Error('condition');
      const changed = { ...row };
      for (const [alias, f] of Object.entries(u.ExpressionAttributeNames)) {
        const i = alias.slice(2);
        if (row[f] !== u.ExpressionAttributeValues[`:old${i}`]) throw new Error('condition');
        changed[f] = u.ExpressionAttributeValues[`:new${i}`];
      }
      next.set(k, changed);
    }
    this.rows = next; return {};
  }
}

describe('awRenumberL', () => {
  it('exports full before rows, applies every number copy atomically and rolls back without touching money, status or PRO identity', async () => {
    const tables = fixture(); const doc = new FakeDoc(tables); const original = new Map(doc.rows);
    const plan = planRenumber(tables); const dir = mkdtempSync(join(tmpdir(), 'renumber-'));
    try {
      const saved = exportPlan(dir, plan, 'test');
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, 'before.jsonl')).mode & 0o777).toBe(0o600);
      expect(saved.entries[0].writes.find((w) => w.model === 'Load').row.rate).toBe(12345);
      await applyEntry(doc, 'test', saved.entries[0]);
      expect(doc.rows.get('Shipment-test/s').number).toBe('14334');
      expect(doc.rows.get('Load-test/l')).toMatchObject({ loadNumber: '14334-1', aljexId: '14334  ', rate: 12345 });
      expect(doc.rows.get('CarrierBill-test/CarrierBill')).toMatchObject({ shipmentNumber: '14334', loadNumber: '14334-1', amountCents: 12345 });
      expect(await applyEntry(doc, 'test', saved.entries[0])).toBe('already-done');
      await applyEntry(doc, 'test', verifyExport(dir, 'test').entries[0], true);
      for (const [k, row] of original) expect(doc.rows.get(k)).toEqual(row);
      expect(await applyEntry(doc, 'test', saved.entries[0], true)).toBe('already-done');
      expect([...doc.rows.keys()].filter((k) => k.startsWith('AuditLog'))).toHaveLength(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('refuses a corrupt export or the wrong target before writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'renumber-'));
    try {
      exportPlan(dir, planRenumber(fixture()), 'test');
      expect(() => verifyExport(dir, 'other')).toThrow('target');
      appendFileSync(join(dir, 'before.jsonl'), 'corruption');
      expect(() => verifyExport(dir, 'test')).toThrow('checksum');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('refuses stale fields as an entire shipment transaction, including the audit', async () => {
    const tables = fixture(); const plan = planRenumber(tables); const doc = new FakeDoc(tables);
    doc.rows.get('Load-test/l').loadNumber = 'changed-by-person';
    await expect(applyEntry(doc, 'test', plan.entries[0])).rejects.toThrow('condition');
    expect(doc.rows.get('Shipment-test/s').number).toBe('L14334  ');
    expect([...doc.rows.keys()].filter((k) => k.startsWith('AuditLog'))).toHaveLength(0);
  });
  it('rolls back an interrupted apply without changing shipments never applied', async () => {
    const tables = fixture(); const doc = new FakeDoc(tables); const before = new Map(doc.rows);
    expect(await applyEntry(doc, 'test', planRenumber(tables).entries[0], true)).toBe('not-applied');
    expect(doc.rows).toEqual(before);
  });
  it('reports collisions and duplicates, and stops if a ProClaim needs a primary-key change', () => {
    const t = fixture(); t.Shipment.push({ id: 'other', number: '14334' });
    expect(planRenumber(t).summary.collisions).toBe(1);
    t.Shipment.push({ id: 'twin', number: 'L14334' }); t.Load.push({ id: 'twinload', shipmentId: 'twin', aljexId: '14334' });
    t.ProClaim = [];
    expect(planRenumber(t).summary.duplicates).toBe(2);
    t.ProClaim = [{ id: 'L14334', shipmentId: 's' }];
    expect(() => planRenumber(t)).toThrow('re-key');
  });
});
