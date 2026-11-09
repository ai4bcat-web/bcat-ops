import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { DELETE_ORDER, writeExport } from '../amplify/functions/tms-shipment-actions/shipmentDelete';
import { AUDIT_ACTION, RESTORABLE_MODELS, dirReader, loadExport, restoreGate, restoreRows } from './awRestoreDeleted.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';
import { PROD_SUFFIX, DEV_SUFFIX } from './lib/prodGate.mjs';

/** In-memory DocumentClient: Get + conditional Put (attribute_not_exists(id)) only; anything else throws. */
class FakeDoc {
  tables = new Map();
  writes = 0;
  seed(table, item) { this.tableMap(table).set(item.id, item); }
  tableMap(t) { if (!this.tables.has(t)) this.tables.set(t, new Map()); return this.tables.get(t); }
  get(t, id) { return this.tableMap(t).get(id); }
  tableRows(t) { return [...this.tableMap(t).values()]; }
  async send(cmd) {
    const { TableName, Key, Item, ConditionExpression } = cmd.input;
    if (cmd instanceof GetCommand) return { Item: this.get(TableName, Key.id) };
    if (cmd instanceof PutCommand) {
      if (ConditionExpression === 'attribute_not_exists(id)' && this.get(TableName, Item.id)) {
        throw Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' });
      }
      if (this.get(TableName, Item.id)) throw new Error('unconditional overwrite');
      this.writes += 1;
      this.tableMap(TableName).set(Item.id, Item);
      return {};
    }
    throw new Error(`unexpected command ${cmd.constructor.name}`);
  }
}

/** Export a shipment exactly the way the Lambda does, into an in-memory bucket. */
async function exportFixture() {
  const bucket = new Map();
  const store = {
    now: () => '2026-11-09T10:00:00.000Z',
    randomId: () => 'abc123',
    putObject: async (k, b) => { bucket.set(k, b); },
    getObject: async (k) => { if (!bucket.has(k)) throw new Error(`no ${k}`); return bucket.get(k); },
  };
  const rows = {
    Shipment: [{ id: 's1', proNumber: 'P1', tags: new Set(['a', 'b']) }],
    Order: [{ id: 'o1', shipmentId: 's1', total: 10 }],
    Load: [{ id: 'l1', shipmentId: 's1' }],
    Invoice: [{ id: 'i1', orderId: 'o1' }],
  };
  const plans = [{ shipmentId: 's1', number: 'P1', rows, referenced: { ArPayment: [{ id: 'ap1' }] } }];
  const { prefix, manifest } = await writeExport(store, { email: 'ryne@bcat.test' }, plans, true);
  return { bucket, prefix, manifest, read: async (name) => store.getObject(`${prefix}${name}`) };
}

describe('allowlist', () => {
  it('covers every model the delete action removes plus the forced-delete extras, never ProClaim; the prod write set adds AuditLog', () => {
    for (const m of DELETE_ORDER) expect(RESTORABLE_MODELS).toContain(m);
    expect(RESTORABLE_MODELS.filter((m) => !DELETE_ORDER.includes(m)).sort()).toEqual(['ApPayment', 'ArPayment', 'LegacyAljexRow'].filter((m) => !DELETE_ORDER.includes(m)).sort());
    expect(RESTORABLE_MODELS).not.toContain('ProClaim');
    expect([...PROD_WRITE_SETS.awRestoreDeleted.models].sort()).toEqual([...RESTORABLE_MODELS, 'AuditLog'].sort());
  });
});

describe('restore round trip', () => {
  it('restores what the delete exported (sets intact), skips ledger copies, audits once, never overwrites', async () => {
    const fx = await exportFixture();
    const { manifest, loaded } = await loadExport(fx.read);
    expect(loaded.map((l) => l.model)[0]).toBe('Shipment');
    expect(loaded.some((l) => l.model === 'ArPayment')).toBe(false);

    const doc = new FakeDoc();
    doc.seed(`Order-${DEV_SUFFIX}`, { id: 'o1', shipmentId: 's1', total: 999 }); // edited since: must survive
    const dry = await restoreRows({ doc, suffix: DEV_SUFFIX, manifest, loaded, apply: false });
    expect(doc.writes).toBe(0);
    expect(dry.tables.Order).toMatchObject({ restored: 0, alreadyPresent: 1 });
    expect(dry.tables.Shipment).toMatchObject({ restored: 1 });

    const r = await restoreRows({ doc, suffix: DEV_SUFFIX, manifest, loaded, apply: true, prefix: fx.prefix });
    expect(r.tables.Shipment).toMatchObject({ restored: 1, failed: 0 });
    expect(r.tables.Order).toMatchObject({ restored: 0, alreadyPresent: 1 });
    expect(doc.get(`Order-${DEV_SUFFIX}`, 'o1').total).toBe(999);
    expect(doc.get(`Shipment-${DEV_SUFFIX}`, 's1').tags).toEqual(new Set(['a', 'b']));
    expect(doc.get(`Invoice-${DEV_SUFFIX}`, 'i1')).toBeTruthy();
    expect(doc.tableRows(`ArPayment-${DEV_SUFFIX}`)).toHaveLength(0);
    const audits = doc.tableRows(`AuditLog-${DEV_SUFFIX}`);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ entityId: 's1', action: AUDIT_ACTION });

    const again = await restoreRows({ doc, suffix: DEV_SUFFIX, manifest, loaded, apply: true });
    expect(Object.values(again.tables).every((t) => t.restored === 0)).toBe(true);
    expect(doc.tableRows(`AuditLog-${DEV_SUFFIX}`)).toHaveLength(1);
  });

  it('reads the same export from a local directory', async () => {
    const fx = await exportFixture();
    const dir = mkdtempSync(join(tmpdir(), 'restore-'));
    for (const [k, v] of fx.bucket) writeFileSync(join(dir, k.slice(fx.prefix.length)), v);
    const { loaded } = await loadExport(dirReader(dir));
    expect(loaded.find((l) => l.model === 'Shipment').rows[0].tags).toEqual(new Set(['a', 'b']));
  });
});

describe('fail closed before any write', () => {
  it('rejects a table file whose bytes changed', async () => {
    const fx = await exportFixture();
    fx.bucket.set(`${fx.prefix}Order.jsonl`, '{"id":"o1","shipmentId":"s1","total":1}\n');
    await expect(loadExport(fx.read)).rejects.toThrow(/hash/);
  });

  it('rejects a manifest naming a model outside the allowlist or a path-like file', async () => {
    const fx = await exportFixture();
    const m = JSON.parse(fx.bucket.get(`${fx.prefix}manifest.json`));
    m.tables.UserProfile = { file: 'UserProfile.jsonl', count: 0, sha256: 'x', deleted: true };
    await expect(loadExport(async (n) => (n === 'manifest.json' ? JSON.stringify(m) : fx.read(n)))).rejects.toThrow(/not allowed/);
    delete m.tables.UserProfile;
    m.tables.Order.file = '../Order.jsonl';
    await expect(loadExport(async (n) => (n === 'manifest.json' ? JSON.stringify(m) : fx.read(n)))).rejects.toThrow(/file name/);
  });

  it('refuses apply on the production suffix without a passed gate', async () => {
    const fx = await exportFixture();
    const { manifest, loaded } = await loadExport(fx.read);
    const doc = new FakeDoc();
    await expect(restoreRows({ doc, suffix: PROD_SUFFIX, manifest, loaded, apply: true })).rejects.toThrow();
    expect(doc.writes).toBe(0);
  });

  it('the gate is closed for a prod target without the allow env', async () => {
    await expect(restoreGate({ target: 'prod', apply: false }, { env: {}, accountId: async () => '123', dynamo: { send: async () => ({ BackupSummaries: [] }) }, out: () => {} })).rejects.toThrow(/Production gate closed/);
  });
});
