import { describe, expect, it } from 'vitest';
import { analyze, applyActivate, applyBilling, applyDelete, applyInactivate, applyRestore, carriersGate, conservation, readExport, SUB_MODELS, writeExport } from './awCarriers.mjs';
import {
  buildExport, classifyShipments, exportableChild, deletedByPreDelete, exportableCarrier, indexShipDates, matchMasters, parseShipDate, planBilling, referenceMap,
  planCarriers, refusalFor, verifyExport,
} from './lib/carrierPlan.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';
import { indexShipDates as preIndex, planPreDelete, selectShipments } from './lib/preDelete.mjs';
import { resolveScripts } from './prodBackup.mjs';
import { ALLOW_ENV, PROD_SUFFIX, DEV_SUFFIX, tableName } from './lib/prodGate.mjs';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// All values below are obviously fake.
const ship = (id, number, o = {}) => ({ id, number, legacyImported: true, ...o });
const car = (id, status = 'PENDING', o = {}) => ({ id, name: `Carrier ${id}`, status, ...o });
const lc = (id, shipmentId, carrierId, o = {}) => ({ id, shipmentId, loadId: `l-${shipmentId}`, carrierId, ...o });
const exportRows = [
  { pro: '1001', shipDate: '03/04/24' }, // old -> deleted
  { pro: '1002', shipDate: '06/01/25' }, // new
  { pro: '1003', shipDate: '01/01/70' }, // epoch placeholder -> 1970 -> deleted (same rule as awPreDelete)
  { pro: '1004', shipDate: '12/31/24' }, { pro: '1004', shipDate: '01/02/25' }, // ambiguous -> kept
  { pro: '1005', shipDate: '02/02/24' }, // L original, old, never deleted
];
const baseData = (o = {}) => ({
  carriers: [], shipments: [
    ship('s1', '1001'), ship('s2', '1002'), ship('s3', '1003'), ship('s4', '1004'), ship('s5', 'L1005', { legacyImported: true }),
  ],
  loads: ['s1', 's2', 's3', 's4', 's5'].map((s) => ({ id: `l-${s}`, shipmentId: s })),
  loadCarriers: [], bills: [], apPayments: [], customers: [], settings: [], vaultIds: [], others: { Quote: [], LaneRateSample: [], Commission: [] }, children: {},
  ...o,
});
const run = (data, opts = {}) => analyze(data, { shipDateRows: exportRows, ...opts });

describe('which shipments awPreDelete removes (retained set)', () => {
  const idx = indexShipDates(exportRows);
  it('deletes only pure-numeric legacy shipments with a single date before the cutoff', () => {
    const info = classifyShipments({ shipments: baseData().shipments, shipDates: idx });
    expect(Object.fromEntries([...info].map(([id, v]) => [id, v.deleted]))).toEqual({ s1: true, s2: false, s3: true, s4: false, s5: false });
    expect(parseShipDate('01/01/70')).toBe('1970-01-01');
  });
  it('an L original dated before the cutoff is retained and dated (so it keeps its carrier but does not make it "used")', () => {
    const info = classifyShipments({ shipments: baseData().shipments, shipDates: idx });
    expect(info.get('s5')).toMatchObject({ deleted: false, date: '2024-02-02' });
  });
  it('an ambiguous PRO is kept; its latest date decides "used"', () => {
    const info = classifyShipments({ shipments: baseData().shipments, shipDates: idx });
    expect(info.get('s4')).toMatchObject({ deleted: false, date: '2025-01-02' });
  });
  it('a shipment missing from the export falls back to its pickup day', () => {
    const info = classifyShipments({ shipments: [ship('x', 'S000123-1', { legacyImported: false, pickupAppt: '2026-03-01T10:00:00Z' })], shipDates: idx });
    expect(info.get('x')).toMatchObject({ deleted: false, date: '2026-03-01', source: 'pickup' });
  });
  it('an ApPayment that only pays deleted bills goes; one that also pays a retained bill stays', () => {
    const data = baseData({
      loadCarriers: [lc('lc1', 's1', 'c1'), lc('lc2', 's2', 'c1')],
      bills: [{ id: 'b1', shipmentId: 's1', loadCarrierId: 'lc1', loadId: 'l-s1' }, { id: 'b2', shipmentId: 's2', loadCarrierId: 'lc2', loadId: 'l-s2' }],
      apPayments: [
        { id: 'p1', applications: [{ billId: 'b1', amountCents: 5 }], unappliedCents: 0 },
        { id: 'p2', applications: [{ billId: 'b1', amountCents: 5 }, { billId: 'b2', amountCents: 5 }], unappliedCents: 0 },
        { id: 'p3', applications: [{ billId: 'b1', amountCents: 5 }], unappliedCents: 7 },
      ],
    });
    const info = classifyShipments({ shipments: data.shipments, shipDates: idx });
    const d = deletedByPreDelete({ shipmentInfo: info, ...data });
    expect([...d.deletedApPayments]).toEqual(['p1']);
    expect([...d.deletedBills]).toEqual(['b1']);
  });
});

describe('retained set equals what awPreDelete deletes', () => {
  it('same shipments, LoadCarriers, CarrierBills and ApPayments as preDelete.planPreDelete', () => {
    const data = baseData({
      loadCarriers: [lc('lc1', 's1', 'c1'), lc('lc2', 's2', 'c1'), lc('lc3', 's3', 'c2'), lc('lc4', 's5', 'c2')],
      bills: [{ id: 'b1', shipmentId: 's1', loadCarrierId: 'lc1', loadId: 'l-s1' }, { id: 'b2', shipmentId: 's2', loadCarrierId: 'lc2', loadId: 'l-s2' }, { id: 'b3', shipmentId: 's3', loadCarrierId: 'lc3', loadId: 'l-s3' }],
      apPayments: [
        { id: 'p1', applications: [{ billId: 'b1', amountCents: 5 }], appliedCents: 5, amountCents: 5, unappliedCents: 0 },
        { id: 'p2', applications: [{ billId: 'b1', amountCents: 5 }, { billId: 'b2', amountCents: 5 }], appliedCents: 10, amountCents: 10, unappliedCents: 0 },
        { id: 'p3', applications: [{ billId: 'b3', amountCents: 5 }], appliedCents: 5, amountCents: 5, unappliedCents: 3 },
      ],
    });
    const mine = run(data);
    const sel = selectShipments({ shipments: data.shipments, shipDates: preIndex(exportRows), shipBefore: '2025-01-01' });
    const theirs = planPreDelete({ Shipment: data.shipments, Load: data.loads, LoadCarrier: data.loadCarriers, CarrierBill: data.bills, ApPayment: data.apPayments }, sel);
    const ids = (rows) => rows.map((r) => r.id).sort();
    expect([...mine.shipmentInfo].filter(([, v]) => v.deleted).map(([id]) => id).sort()).toEqual(ids(sel.delete));
    expect([...mine.deleted.deletedLoadCarriers].sort()).toEqual(ids(theirs.deletes.LoadCarrier));
    expect([...mine.deleted.deletedBills].sort()).toEqual(ids(theirs.deletes.CarrierBill));
    expect([...mine.deleted.deletedApPayments].sort()).toEqual(ids(theirs.deletes.ApPayment));
  });
});

describe('activate: used since the cutoff, from retained rows only', () => {
  it('activates a carrier on a retained load shipped >= cutoff; ignores one that only ran a to-be-deleted load', () => {
    const data = baseData({
      carriers: [car('new'), car('old'), car('act', 'ACTIVE'), car('dnu', 'DO_NOT_USE'), car('inact', 'INACTIVE', { statusReason: 'OTHER' })],
      loadCarriers: [lc('a', 's2', 'new'), lc('b', 's1', 'old'), lc('c', 's2', 'act'), lc('d', 's2', 'dnu'), lc('e', 's2', 'inact')],
    });
    const { plan } = run(data);
    expect(plan.activate.map((a) => a.id).sort()).toEqual(['inact', 'new']);
    expect(plan.alreadyActive).toEqual(['act']);
    expect(plan.doNotUseUsed).toEqual(['dnu']); // never activated
    expect(plan.activate.find((a) => a.id === 'inact')).toMatchObject({ previousStatus: 'INACTIVE', previousReason: 'OTHER' });
  });
  it('a retained pre-cutoff L original makes a carrier referenced but not used', () => {
    const data = baseData({ carriers: [car('o')], loadCarriers: [lc('a', 's5', 'o')] });
    const { plan } = run(data);
    expect(plan.activate).toEqual([]);
    expect(plan.keep.map((k) => [k.id, k.reasons[0].table])).toEqual([['o', 'LoadCarrier']]);
  });
  it('lastLoadAt is compared, never trusted', () => {
    const data = baseData({
      carriers: [car('both', 'PENDING', { lastLoadAt: '2025-06-01T00:00:00Z' }), car('only', 'PENDING'), car('stale', 'PENDING', { lastLoadAt: '2026-01-01T00:00:00Z' })],
      loadCarriers: [lc('a', 's2', 'both'), lc('b', 's2', 'only')],
    });
    const { plan } = run(data);
    expect(plan.lastLoadAt).toEqual({ both: ['both'], onlyUsed: ['only'], onlyLastLoadAt: ['stale'] });
    expect(plan.activate.map((a) => a.id).sort()).toEqual(['both', 'only']); // 'stale' is not activated
  });
});

describe('delete: never a carrier anything retained still references', () => {
  const data = () => baseData({
    carriers: [car('free'), car('gone', 'INACTIVE'), car('bill'), car('pay'), car('dnu', 'DO_NOT_USE'), car('kid', 'PENDING', { mcpSyncedAt: 'T' }), car('ll', 'PENDING', { lastLoadAt: '2026-01-01T00:00:00Z' })],
    loadCarriers: [lc('a', 's1', 'gone')],
    bills: [{ id: 'b2', shipmentId: 's5', loadCarrierId: 'zz', loadId: 'l-s5', carrierId: 'bill', status: 'TO_BE_PAID', balanceCents: 100 }],
    apPayments: [{ id: 'p', carrierId: 'pay', applications: [], unappliedCents: 50 }],
    children: { CarrierContact: new Map([['kid', [{ id: 'k1', carrierId: 'kid' }]]]) },
    others: { Quote: [], LaneRateSample: [], Commission: [] },
  });
  it('deletes unreferenced carriers incl. INACTIVE ones and ones with child rows; a carrier referenced only by to-be-deleted rows waits for awPreDelete', () => {
    const { plan } = run(data());
    expect(plan.delete.map((d) => [d.id, d.blockedNow]).sort()).toEqual([['free', false], ['gone', true], ['kid', false]]);
  });
  it('class A = never MCP-synced, class B = MCP-synced; the child rows are counted with the carrier', () => {
    const { plan } = run(data());
    expect(Object.fromEntries(plan.delete.map((d) => [d.id, d.cls]))).toEqual({ free: 'A', gone: 'A', kid: 'B' });
    expect(plan.delete.find((d) => d.id === 'kid').children).toEqual({ CarrierContact: 1 });
  });
  it('keeps referenced, DO_NOT_USE and lastLoadAt carriers, each with the reason', () => {
    const { plan } = run(data());
    const why = Object.fromEntries(plan.keep.map((k) => [k.id, k.reasons.map((r) => r.table)]));
    expect(why).toEqual({ bill: ['CarrierBill'], pay: ['ApPayment'], dnu: ['Carrier.status'], ll: ['Carrier.lastLoadAt'] });
  });
  it('referenced + never synced -> INACTIVE (kept, never deleted); synced, DO_NOT_USE and already-INACTIVE ones are not written', () => {
    const d = baseData({
      carriers: [car('ns'), car('nsOld', 'INACTIVE'), car('nsDnu', 'DO_NOT_USE'), car('syn', 'PENDING', { mcpSyncedAt: 'T' }), car('free')],
      loadCarriers: [lc('a', 's2', 'ns'), lc('b', 's4', 'nsOld'), lc('c', 's5', 'nsDnu'), lc('e', 's2', 'syn')],
    });
    const { plan } = run(d);
    expect(plan.neverSyncedReferenced.sort()).toEqual(['ns', 'nsOld']);
    expect(plan.inactivate.map((a) => [a.id, a.previousStatus])).toEqual([['ns', 'PENDING']]);
    expect(plan.delete.map((x) => x.id)).toEqual(['free']);
  });
  it('--ignore-lastloadat / --include-do-not-use release those two classes', () => {
    const { plan } = run(data(), { protectLastLoad: false, keepDoNotUse: false });
    expect(plan.delete.map((d) => d.id)).toContain('ll');
    expect(plan.delete.map((d) => d.id)).toContain('dnu');
  });
  it('a retained customer / settings carrier list keeps the carrier', () => {
    const d = data();
    d.customers = [{ id: 'cu', quotingDefaults: { blockedLtlCarrierIds: ['free'] } }];
    expect(run(d).plan.keep.some((k) => k.id === 'free' && k.reasons[0].table === 'Customer.quotingDefaults')).toBe(true);
  });
  it('alias safety: a reference through a merged alias resolves to the survivor (activated, never deleted)', () => {
    const d = baseData({
      carriers: [car('sur', 'PENDING', { aljexCode: '900000001', aljexAliases: ['900000002'] }), car('other')],
      loadCarriers: [lc('a', 's2', '900000002')], // stored by the alias code
    });
    const { plan, refs } = run(d);
    expect(refs.byCarrier.get('sur').used).toBe(1);
    expect(plan.activate.map((a) => a.id)).toEqual(['sur']);
    expect(plan.delete.map((x) => x.id)).toEqual(['other']);
  });
  it('alias safety: an unused carrier that shares an Aljex id with a used carrier is kept', () => {
    const d = baseData({
      carriers: [car('sur', 'PENDING', { aljexCode: '900000001', aljexAliases: ['900000002'] }), car('dup', 'PENDING', { aljexCode: '900000002' })],
      loadCarriers: [lc('a', 's2', 'sur')],
    });
    const { plan } = run(d);
    expect(plan.keep.find((k) => k.id === 'dup').reasons[0].table).toBe('Carrier.aljexAliases');
    expect(plan.delete).toEqual([]);
  });
  it('conservation: every retained reference still resolves, nothing else moves', () => {
    const d = data();
    const a = run(d);
    const proof = conservation({ ...d, vaultIds: ['free', 'gone', 'bill'] }, a, a.plan.delete.map((x) => x.id));
    expect(proof).toMatchObject({ carriersBefore: 7, carriersAfter: 4, vaultRowsBefore: 3, vaultRowsAfter: 1, ok: true, openApCentsRetained: 100 });
    expect(proof.rows.CarrierBill).toEqual({ retained: 1, resolvedBefore: 1, resolvedAfter: 1 });
  });
  it('refusalFor refuses on any live reference, at apply time', () => {
    expect(refusalFor({})).toBeNull();
    expect(refusalFor({ CarrierBill: 1 })).toMatch(/still referenced \(CarrierBill 1\)/);
  });
});

/** A fake DynamoDB document client that records commands, answers money-table index queries from `refs` and child index queries from `kids`. */
const fakeDoc = ({ refs = {}, kids = {}, failCondition = false, failTx = false, existing = new Set() } = {}) => {
  const sent = [];
  return {
    sent,
    send: async (cmd) => {
      const name = cmd.constructor.name;
      sent.push({ name, input: cmd.input });
      if (name === 'QueryCommand') {
        const table = cmd.input.TableName.split('-')[0];
        if (kids[table]) return { Items: kids[table].map((id) => ({ id })) };
        if (cmd.input.ProjectionExpression === 'id') return { Items: [] };
        return { Count: refs[table] ?? 0 };
      }
      if (failTx && name === 'TransactWriteCommand') { const e = new Error('x'); e.name = 'TransactionCanceledException'; throw e; }
      if (failCondition && (name === 'UpdateCommand' || name === 'DeleteCommand')) { const e = new Error('x'); e.name = 'ConditionalCheckFailedException'; throw e; }
      if (name === 'PutCommand' && existing.has(`${cmd.input.TableName.split('-')[0]}:${cmd.input.Item.id}`)) { const e = new Error('x'); e.name = 'ConditionalCheckFailedException'; throw e; }
      return {};
    },
  };
};
const written = (doc, name) => doc.sent.filter((s) => s.name === name);

describe('apply helpers', () => {
  it('delete refuses a carrier that is still referenced live (ordering safe) and writes nothing', async () => {
    const doc = fakeDoc({ refs: { CarrierBill: 1 } });
    const r = await applyDelete({ doc, suffix: DEV_SUFFIX, entry: { id: 'c1', status: 'PENDING' }, carrier: car('c1'), hasVault: true });
    expect(r.refused).toMatch(/CarrierBill/);
    expect(doc.sent.every((s) => s.name === 'QueryCommand')).toBe(true);
  });
  it('delete is ONE transaction: conditional carrier delete + its child rows + vault row + audit row without sensitive data', async () => {
    const doc = fakeDoc({ kids: { CarrierContact: ['k1', 'k2'], CarrierPaymentMethod: ['m1'] } });
    const children = { CarrierContact: [{ id: 'k1' }, { id: 'k2' }], CarrierPaymentMethod: [{ id: 'm1' }] };
    const r = await applyDelete({ doc, suffix: DEV_SUFFIX, entry: { id: 'c1', status: 'INACTIVE', cls: 'B' }, carrier: car('c1', 'INACTIVE', { updatedAt: 'T', taxIdLast4: '9999', mcpSyncedAt: 'T' }), children, hasVault: true, exportName: 'stamp' });
    expect(r).toEqual({ deleted: true, children: { CarrierContact: 2, CarrierPaymentMethod: 1, CarrierDocument: 0 } });
    expect(written(doc, 'DeleteCommand')).toHaveLength(0); // nothing outside the transaction
    const items = written(doc, 'TransactWriteCommand')[0].input.TransactItems;
    expect(items[0].Delete.ConditionExpression).toContain('updatedAt = :u');
    expect(items.filter((i) => i.Delete).map((i) => i.Delete.TableName.split('-')[0]).sort()).toEqual(['Carrier', 'CarrierContact', 'CarrierContact', 'CarrierPaymentMethod', 'CarrierTaxVault']);
    expect(items.find((i) => i.Delete?.TableName.startsWith('CarrierTaxVault')).Delete.TableName).toBe(`CarrierTaxVault-${DEV_SUFFIX.replace(/-NONE$/, '')}`);
    const audit = JSON.stringify(items.find((i) => i.Put).Put.Item);
    expect(audit).toContain('AW_CARRIER_DELETE');
    expect(audit).not.toContain('9999');
  });
  it('delete refuses a carrier that grew a child row after the scan, or changed (transaction cancelled): nothing is half-deleted', async () => {
    const grew = fakeDoc({ kids: { CarrierContact: ['k1', 'new'] } });
    const r = await applyDelete({ doc: grew, suffix: DEV_SUFFIX, entry: { id: 'c1', status: 'PENDING' }, carrier: car('c1'), children: { CarrierContact: [{ id: 'k1' }] }, hasVault: false });
    expect(r.refused).toMatch(/appeared since the scan/);
    expect(written(grew, 'TransactWriteCommand')).toHaveLength(0);
    const changed = fakeDoc({ failTx: true });
    expect((await applyDelete({ doc: changed, suffix: DEV_SUFFIX, entry: { id: 'c1', status: 'PENDING' }, carrier: car('c1'), hasVault: false })).refused).toMatch(/changed since the scan/);
  });
  it('inactivate is conditional on the previous status and on never having synced; a lost race writes no audit row', async () => {
    const lost = fakeDoc({ failCondition: true });
    expect(await applyInactivate({ doc: lost, suffix: DEV_SUFFIX, entry: { id: 'c1', previousStatus: 'PENDING' } })).toBe(false);
    expect(written(lost, 'PutCommand')).toHaveLength(0);
    const ok = fakeDoc();
    expect(await applyInactivate({ doc: ok, suffix: DEV_SUFFIX, entry: { id: 'c1', previousStatus: 'PENDING', previousReason: null } })).toBe(true);
    const u = written(ok, 'UpdateCommand')[0].input;
    expect(u.ConditionExpression).toContain('#s = :prev');
    expect(u.ConditionExpression).toContain('attribute_not_exists(mcpSyncedAt)');
    expect(u.ExpressionAttributeValues[':inactive']).toBe('INACTIVE');
    expect(JSON.stringify(written(ok, 'PutCommand')[0].input.Item)).toContain('AW_CARRIER_INACTIVATE');
  });
  it('activate is conditional on the previous status; a lost race writes no audit row', async () => {
    const lost = fakeDoc({ failCondition: true });
    expect(await applyActivate({ doc: lost, suffix: DEV_SUFFIX, entry: { id: 'c1', previousStatus: 'PENDING' } })).toBe(false);
    expect(written(lost, 'PutCommand')).toHaveLength(0);
    const ok = fakeDoc();
    expect(await applyActivate({ doc: ok, suffix: DEV_SUFFIX, entry: { id: 'c1', previousStatus: 'PENDING', previousReason: null } })).toBe(true);
    expect(written(ok, 'UpdateCommand')[0].input.ConditionExpression).toContain('#s = :prev');
    expect(written(ok, 'UpdateCommand')[0].input.ExpressionAttributeValues[':active']).toBe('ACTIVE');
  });
  it('billing writes each field only while empty and the payment method only while absent', async () => {
    const doc = fakeDoc();
    const plan = { patch: { phone: '555-0100' }, method: { id: 'pm-aljex-c1', carrierId: 'c1' } };
    const r = await applyBilling({ doc, suffix: DEV_SUFFIX, carrier: car('c1'), plan });
    expect(r).toEqual({ fields: 1, method: 1, lost: 0 });
    expect(written(doc, 'UpdateCommand')[0].input.ConditionExpression).toMatch(/attribute_not_exists\(#f\) OR attribute_type\(#f, :nul\)/);
    expect(written(doc, 'PutCommand').find((p) => p.input.TableName.startsWith('CarrierPaymentMethod')).input.ConditionExpression).toBe('attribute_not_exists(id)');
    await expect(applyBilling({ doc, suffix: DEV_SUFFIX, carrier: car('c1'), plan: { patch: { taxIdLast4: '1' }, method: null } })).rejects.toThrow(/refusing to write/);
  });
});

describe('export has no sensitive columns', () => {
  const row = car('c1', 'INACTIVE', { taxIdLast4: '9999', taxIdType: 'EIN', taxIdOnFileAt: 'T', bankAccount: 'x', routingNumber: 'y', internalNotes: 'Imported. Paid through Aljex factor 123456789. Remit to Nowhere.', mcNumber: '700001' });
  it('drops tax / bank attributes and redacts the factor id in notes', () => {
    const out = exportableCarrier(row);
    expect(Object.keys(out).sort()).toEqual(['id', 'internalNotes', 'mcNumber', 'name', 'status']);
    expect(out.internalNotes).not.toMatch(/\d{9}/);
    expect(out.internalNotes).toContain('Remit to Nowhere');
  });
  it('manifest carries counts + sha256 and detects tampering; files 0600 in a 0700 directory', () => {
    const { files, manifest } = buildExport({ carriers: [row], vaultCarrierIds: ['c1'], suffix: 'sfx', now: new Date('2026-11-08T10:00:00Z') });
    expect(manifest.counts).toEqual({ carriers: 1, inactive: 1, vaultRows: 1, CarrierContact: 0, CarrierPaymentMethod: 0, CarrierDocument: 0 });
    expect(verifyExport(manifest, (n) => files[n])).toBe(true);
    expect(verifyExport(manifest, (n) => `${files[n]} `)).toBe(false);
    expect(JSON.stringify(files)).not.toMatch(/9999|123456789|bankAccount|routingNumber/);
    const dir = mkdtempSync(join(tmpdir(), 'awc-'));
    const { target } = writeExport({ dir, carriers: [row], vaultCarrierIds: ['c1'], suffix: 'sfx' });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const n of readdirSync(target)) expect(statSync(join(target, n)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(target, 'carriers.jsonl'), 'utf8')).not.toContain('9999');
  });
});

describe('child rows export and restore', () => {
  const pm = { id: 'm1', carrierId: 'c1', method: 'CHECK', payeeEmail: 'a@b.test', bankName: 'Fake Bank', accountName: 'Holder', accountLast4: '7777', routingLast4: '8888', bankDetailsKey: 'carrier-docs/c1/private/x', remitToAddress: { city: 'Dayton' } };
  const contact = { id: 'k1', carrierId: 'c1', name: 'Sam', email: 's@b.test', types: ['DISPATCH'] };
  const doc1 = { id: 'd1', carrierId: 'c1', type: 'W9', name: 'w9.pdf', s3Key: 'carrier-docs/c1/w9.pdf' };
  it('drops bank / account / routing attributes from child rows, keeps the rest', () => {
    const out = exportableChild(pm);
    expect(Object.keys(out).sort()).toEqual(['carrierId', 'id', 'method', 'payeeEmail', 'remitToAddress']);
  });
  it('export carries every child row; restore from the export is put-if-absent and audited', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'awc-'));
    const row = car('c1', 'PENDING', { mcNumber: '700001' });
    const { target, manifest } = writeExport({ dir, carriers: [row], children: { CarrierContact: [contact], CarrierPaymentMethod: [pm], CarrierDocument: [doc1] }, vaultCarrierIds: ['c1'], suffix: 'sfx' });
    expect(manifest.counts).toMatchObject({ carriers: 1, CarrierContact: 1, CarrierPaymentMethod: 1, CarrierDocument: 1 });
    expect(Object.keys(readdirSync(target)).length).toBe(6);
    expect(readFileSync(join(target, 'carrier-payment-methods.jsonl'), 'utf8')).not.toMatch(/7777|8888|Fake Bank|Holder|private/);
    const back = readExport(target);
    expect(back.carriers.map((c) => c.id)).toEqual(['c1']);
    const doc = fakeDoc({ existing: new Set(['CarrierContact:k1']) });
    const r = await applyRestore({ doc, suffix: DEV_SUFFIX, carrier: back.carriers[0], children: back.children, exportName: 'stamp' });
    expect(r).toEqual({ carrier: 1, CarrierContact: 0, CarrierPaymentMethod: 1, CarrierDocument: 1 });
    expect(written(doc, 'PutCommand').every((p) => p.input.ConditionExpression === 'attribute_not_exists(id)' || p.input.TableName.startsWith('AuditLog'))).toBe(true);
    expect(JSON.stringify(written(doc, 'PutCommand').at(-1).input.Item)).toContain('AW_CARRIER_RESTORE');
  });
  it('a tampered export is refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'awc-'));
    const { target } = writeExport({ dir, carriers: [car('c1')], vaultCarrierIds: [], suffix: 'sfx' });
    writeFileSync(join(target, 'carriers.jsonl'), '{"id":"evil"}\n');
    expect(() => readExport(target)).toThrow(/manifest sha256/);
  });
});

describe('billing: enrich only, never a sensitive field', () => {
  const master = (o = {}) => ({
    id: '900000001', aliases: [], name: 'Blue Line', street: '9 Road', city: 'Dayton', state: 'OH', zip: '45402', phone: '555-0111', fax: '', contact: 'Sam', phoneAccounting: '',
    payableTo: 'Blue Line Pay LLC', remit: { street: 'PO Box 1', city: 'Dayton', state: 'OH', zip: '45402-1234' }, mc: '700001', dot: '3000001', safety: 'NONE',
    termsDays: 30, quickPay: { eligible: true, days: 10, pct: '2.00' }, factorId: '', active: true, otherNames: [], ...o,
  });
  it('fills every empty field and creates one CHECK payment method with payee + remit-to (zip+4)', () => {
    const p = planBilling(car('c1'), master(), 0, new Date('2026-11-08T00:00:00Z'));
    expect(p.patch).toEqual({ address: { street: '9 Road', city: 'Dayton', state: 'OH', zip: '45402', country: 'US' }, phone: '555-0111', dispatcherName: 'Sam', paymentTermsDays: 30, quickPayEligible: true, defaultQuickPayDays: 10 });
    expect(p.method).toMatchObject({ id: 'pm-aljex-c1', method: 'CHECK', recipientType: 'CARRIER', accountName: 'Blue Line Pay LLC', remitToAddress: { zip: '45402-1234' }, isPreferred: true });
    expect(Object.keys(p.method).join()).not.toMatch(/account(Last4|Number)|routing|bank|tax/i);
  });
  it('never overwrites: filled fields stay (differences are only reported) and an existing payment method blocks a second one', () => {
    const c = car('c1', 'ACTIVE', { address: { street: 'Other', city: 'X' }, phone: '555-9999', dispatcherName: 'Pat', paymentTermsDays: 15, quickPayEligible: false, defaultQuickPayDays: 5 });
    const p = planBilling(c, master(), 1);
    expect(p.patch).toEqual({});
    expect(p.method).toBeNull();
    expect(p.differs.sort()).toEqual(['paymentTermsDays', 'phone']);
  });
  it('matches by MC/DOT then Aljex id (merged aliases too), skips an MC/DOT split, never matches by name', () => {
    const carriers = [car('a', 'ACTIVE', { mcNumber: '700001' }), car('b', 'ACTIVE', { aljexCode: '900000009', aljexAliases: ['900000010'] }), car('x', 'ACTIVE', { dotNumber: '77' })];
    const m = matchMasters(carriers, [master(), master({ id: '900000010', mc: '', dot: '', name: 'Whatever' }), master({ id: '900000020', mc: '700001', dot: '77' }), master({ id: '900000030', mc: '', dot: '', name: 'Carrier a' })]);
    expect([...m.matched.keys()].sort()).toEqual(['a', 'b']);
    expect(m.conflicts).toEqual(['900000020']);
    expect(m.unmatched).toEqual(['900000030']);
  });
});

describe('production gate', () => {
  it('lists the models each subcommand writes, all inside the one backup set; vault table has no -NONE suffix', () => {
    const all = PROD_WRITE_SETS.awCarriers.models;
    for (const models of Object.values(SUB_MODELS)) for (const m of models) expect(all).toContain(m);
    expect(resolveScripts('awCarriers')).toEqual(['awCarriers']);
    expect(tableName('CarrierTaxVault', PROD_SUFFIX)).toBe('CarrierTaxVault-5ucwdyvwivelbo4k4jomvrwel4');
    expect(tableName('Carrier', PROD_SUFFIX)).toBe(`Carrier-${PROD_SUFFIX}`);
  });
  it('apply needs the allow env, the typed AW_PROD_CONFIRM for that subcommand and a fresh backup of exactly its tables', async () => {
    const now = new Date('2026-11-08T12:00:00');
    const values = { target: 'prod', 'i-mean-production': true, apply: true, 'confirm-prod': `111:${PROD_SUFFIX}` };
    const backups = (models) => ({ send: async () => ({ BackupSummaries: models.map((t) => ({ TableName: tableName(t, PROD_SUFFIX), BackupName: `prodpre-awCarriers-${t}`, BackupStatus: 'AVAILABLE', BackupCreationDateTime: new Date('2026-11-08T11:00:00') })) }) });
    const base = { now, accountId: async () => '111', out: () => {} };
    const env = { [ALLOW_ENV]: '2026-11-08', AW_PROD_CONFIRM: '2026-11-08-carriers-delete' };
    await expect(carriersGate('delete', values, { ...base, dynamo: backups(SUB_MODELS.delete), env: {} })).rejects.toThrow(/closed/);
    await expect(carriersGate('delete', values, { ...base, dynamo: backups(SUB_MODELS.delete), env: { [ALLOW_ENV]: '2026-11-08' } })).rejects.toThrow(/AW_PROD_CONFIRM must equal 2026-11-08-carriers-delete/);
    await expect(carriersGate('delete', values, { ...base, dynamo: backups(SUB_MODELS.delete), env: { ...env, AW_PROD_CONFIRM: '2026-11-08-carriers-activate' } })).rejects.toThrow(/AW_PROD_CONFIRM must equal/);
    await expect(carriersGate('delete', values, { ...base, dynamo: backups(['Carrier', 'AuditLog']), env })).rejects.toThrow(/closed/); // vault backup missing
    await expect(carriersGate('delete', values, { ...base, dynamo: backups(SUB_MODELS.delete), env })).resolves.toMatchObject({ apply: true });
    await expect(carriersGate('activate', values, { ...base, dynamo: backups(SUB_MODELS.activate), env: { ...env, AW_PROD_CONFIRM: '2026-11-08-carriers-activate' } })).resolves.toMatchObject({ apply: true });
    await expect(carriersGate('nope', values, base)).rejects.toThrow(/unknown subcommand/);
  });
});
