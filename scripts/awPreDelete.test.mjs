import { describe, expect, it } from 'vitest';
import {
  applyPlan, assertHardGuarantees, deleteRow, preDeleteGate, restoreExport, reviewCsv, writeAndVerifyExport,
} from './awPreDelete.mjs';
import {
  DELETE_ORDER, assertShipBefore, auditItems, buildManifest, conservationProof, deviations, exportFiles, indexShipDates, missingFromExport,
  parseShipDate, planPreDelete, removedTotals, selectShipments, splitPayment, toJsonLine, fromJsonLine, verifyExport,
} from './lib/preDelete.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';
import { resolveScripts } from './prodBackup.mjs';
import { ALLOW_ENV, DEV_SUFFIX, PROD_SUFFIX } from './lib/prodGate.mjs';

// ── fixtures: old shipments 100/101/102, retained 200 (2025), 300 (no date), 400 (conflicting dates), L100 (an L original) ──
const ship = (n, over = {}) => ({ id: `shp-${n}`, number: n, legacyImported: true, orderIds: [`ord-${n}`], loadIds: [`lod-${n}`], ...over });
const dates = (rows) => indexShipDates(rows.map(([pro, shipDate]) => ({ pro, shipDate })));
const SHIPMENTS = [ship('100'), ship('101'), ship('102'), ship('200'), ship('300'), ship('400'), { ...ship('L100'), legacyImported: undefined }];
const DATES = dates([['100', '03/04/24'], ['101', '12/31/24'], ['102', '01/01/70'], ['200', '01/01/25'], ['300', ''], ['400', '05/05/24'], ['400', '05/06/24'], ['L100', '01/01/20']]);
const selection = () => selectShipments({ shipments: SHIPMENTS, shipDates: DATES, shipBefore: '2025-01-01' });
const children = (n, extra = {}) => ({
  Order: [{ id: `ord-${n}`, shipmentId: `shp-${n}` }],
  Load: [{ id: `lod-${n}`, shipmentId: `shp-${n}` }],
  LoadCarrier: [{ id: `lcr-${n}`, shipmentId: `shp-${n}`, loadId: `lod-${n}` }],
  LoadFinancials: [{ id: `lod-${n}`, shipmentId: `shp-${n}` }],
  LoadCharge: [{ id: `chg-${n}`, shipmentId: `shp-${n}` }],
  Invoice: [{ id: n, shipmentId: `shp-${n}`, orderId: `ord-${n}`, status: 'PAID', totalCents: 1000, paidCents: 1000, balanceCents: 0, ...extra.invoice }],
  CarrierBill: [{ id: `cb:lcr-${n}:1`, shipmentId: `shp-${n}`, loadId: `lod-${n}`, loadCarrierId: `lcr-${n}`, status: 'PAID', billedCents: 600, paidCents: 600, balanceCents: 0 }],
  ProClaim: [{ id: n, shipmentId: `shp-${n}`, loadId: `lod-${n}` }],
  LegacyAljexRow: [{ id: `aljex:${n}`, shipmentId: `shp-${n}`, pro: n }],
});
const merge = (...parts) => Object.fromEntries(DELETE_ORDER.filter((m) => !['Shipment', 'ArPayment', 'ApPayment'].includes(m)).map((m) => [m, parts.flatMap((p) => p[m] ?? [])]));
const ar = (id, apps, over = {}) => {
  const applied = apps.reduce((a, x) => a + x.amountCents, 0);
  return { id, customerId: 'c1', kind: 'PAYMENT', amountCents: applied + (over.unappliedCents ?? 0), appliedCents: applied, unappliedCents: 0, applications: apps, ...over };
};
const ap = (id, apps, over = {}) => ({ ...ar(id, apps, over), carrierId: 'k1' });
const inv = (id, amt) => ({ invoiceId: id, amountCents: amt });
const bill = (id, amt) => ({ billId: id, amountCents: amt });
const dataset = (payments = {}) => ({
  Shipment: SHIPMENTS,
  ...merge(...['100', '101', '102', '200', '400'].map((n) => children(n, n === '200' ? { invoice: { status: 'SENT', paidCents: 0, balanceCents: 1000 } } : {}))),
  ArPayment: payments.ar ?? [], ApPayment: payments.ap ?? [], FactoringItem: [],
});

describe('selection', () => {
  it('deletes only pure-numeric legacy shipments shipped before the cutoff; no/conflicting date and L originals are kept', () => {
    const s = selection();
    expect(s.delete.map((x) => x.number).sort()).toEqual(['100', '101', '102']);
    expect(s.keep.map((x) => x.number)).toEqual(['200']);
    expect(s.noShipDate.map((x) => x.number)).toEqual(['300']);
    expect(s.ambiguous.map((x) => x.number)).toEqual(['400']);
    expect(s.notCandidate).toBe(1);
    expect(() => assertHardGuarantees(s, SHIPMENTS)).not.toThrow();
  });
  it('the cutoff day itself is kept and a placeholder 01/01/70 is 1970, not 2070', () => {
    expect(parseShipDate('01/01/70')).toBe('1970-01-01');
    expect(parseShipDate('12/31/24')).toBe('2024-12-31');
    expect(selection().delete.map((x) => x.__shipDate)).toContain('1970-01-01');
    expect(selection().delete.map((x) => x.number)).not.toContain('200');
  });
  it('a PRO missing from the export is kept and listed, and the review file names every kept-for-review PRO', () => {
    const s = selectShipments({ shipments: [ship('900')], shipDates: new Map(), shipBefore: '2025-01-01' });
    expect(s.delete).toHaveLength(0);
    expect(reviewCsv(s)).toContain('900,NOT_IN_EXPORT');
    expect(reviewCsv(selection())).toMatch(/300,NO_SHIP_DATE[\s\S]*400,CONFLICTING_SHIP_DATES/);
  });
  it('the hard guarantee throws if an L original or a non-legacy row reaches the delete set', () => {
    expect(() => assertHardGuarantees({ delete: [{ id: 'x', number: 'L5', legacyImported: true }] }, SHIPMENTS)).toThrow(/HARD GUARANTEE/);
    expect(() => assertHardGuarantees({ delete: [{ id: 'y', number: '5', legacyImported: false }] }, SHIPMENTS)).toThrow(/HARD GUARANTEE/);
  });
  it('the cutoff must be an explicit YYYY-MM-DD', () => {
    expect(() => assertShipBefore('2025-1-1')).toThrow();
    expect(() => assertShipBefore(undefined)).toThrow();
    expect(assertShipBefore('2025-01-01')).toBe('2025-01-01');
  });
});

describe('payment split', () => {
  const gone = new Set(['100', '101']);
  it('a payment that also pays a retained invoice keeps it: only old lines go and amount/applied shrink by exactly the old dollars', () => {
    const p = ar('p1', [inv('100', 500), inv('200', 700)], { unappliedCents: 50 });
    const r = splitPayment(p, 'invoiceId', gone);
    expect(r.action).toBe('modify');
    expect(r.after).toMatchObject({ amountCents: 750, appliedCents: 700, unappliedCents: 50, applications: [inv('200', 700)] });
    expect(r.after.appliedCents + r.after.unappliedCents).toBe(r.after.amountCents);
    expect(r.removedCents).toBe(500);
  });
  it('an all-old payment is deleted, unless it carries unapplied credit which is kept', () => {
    expect(splitPayment(ar('p2', [inv('100', 500), inv('101', 100)]), 'invoiceId', gone).action).toBe('delete');
    const credit = splitPayment(ar('p3', [inv('100', 500)], { unappliedCents: 40 }), 'invoiceId', gone);
    expect(credit).toMatchObject({ action: 'modify', reason: 'OLD_ONLY_WITH_CREDIT', after: { amountCents: 40, appliedCents: 0, unappliedCents: 40, applications: [] } });
  });
  it('a payment with no old application is untouched; JSON-string applications stay strings', () => {
    expect(splitPayment(ar('p4', [inv('200', 5)]), 'invoiceId', gone).action).toBe('keep');
    const p = ar('p5', [inv('100', 5), inv('200', 6)]);
    p.applications = JSON.stringify(p.applications);
    expect(typeof splitPayment(p, 'invoiceId', gone).after.applications).toBe('string');
  });
  it('refuses to guess when appliedCents disagrees with the applications', () => {
    expect(splitPayment({ ...ar('p6', [inv('100', 5)]), appliedCents: 9 }, 'invoiceId', gone).reason).toBe('APPLIED_MISMATCH');
  });
});

describe('plan + conservation', () => {
  const payments = {
    ar: [ar('arp-old', [inv('100', 1000)]), ar('arp-mix', [inv('101', 1000), inv('200', 400)]), ar('arp-keep', [inv('200', 77)])],
    ap: [ap('app-old', [bill('cb:lcr-100:1', 600)]), ap('app-mix', [bill('cb:lcr-102:1', 600), bill('cb:lcr-200:1', 5)])],
  };
  const plan = planPreDelete(dataset(payments), selection());

  it('deletes children of exactly the selected shipments and modifies the mixed payments', () => {
    expect(Object.fromEntries(DELETE_ORDER.map((m) => [m, plan.deletes[m].length]))).toEqual({
      ArPayment: 1, ApPayment: 1, CarrierBill: 3, Invoice: 3, LoadCharge: 3, LoadCarrier: 3, LoadFinancials: 3, LegacyAljexRow: 3, ProClaim: 3, Load: 3, Order: 3, Shipment: 3,
    });
    expect(plan.modifies.ArPayment.map((x) => x.before.id)).toEqual(['arp-mix']);
    expect(plan.modifies.ApPayment.map((x) => x.before.id)).toEqual(['app-mix']);
    expect(plan.blockers).toEqual([]);
    expect(plan.deletes.Invoice.map((i) => i.id).sort()).toEqual(['100', '101', '102']);
  });
  it('before/after proof: open AR, paid AR, open AP and every payment balance are conserved on the retained rows', () => {
    const proof = conservationProof(dataset(payments), plan);
    expect(proof.ok).toBe(true);
    expect(proof.before.openArCents).toBe(1000);
    expect(proof.after.openArCents).toBe(1000);
    expect(proof.after.arAppliedToRetainedInvoicesCents).toBe(proof.before.arAppliedToRetainedInvoicesCents);
    expect(removedTotals(plan).invoices).toMatchObject({ count: 3, totalCents: 3000, openCents: 0 });
  });
  it('the proof fails if a retained payment would end up out of balance', () => {
    const broken = { ...plan, modifies: { ...plan.modifies, ArPayment: plan.modifies.ArPayment.map((x) => ({ ...x, after: { ...x.after, amountCents: x.after.amountCents + 1 } })) } };
    const proof = conservationProof(dataset(payments), broken);
    expect(proof.ok).toBe(false);
    expect(proof.checks.everyRetainedPaymentBalances).toBe(false);
  });
  it('blocks on a reversal link to a retained payment, a factored invoice and a child that also belongs to a retained shipment', () => {
    const linked = planPreDelete(dataset({ ar: [ar('arp-old', [inv('100', 1000)], { reversedByPaymentId: 'arp-keep' }), ar('arp-keep', [inv('200', 77)])] }), selection());
    expect(linked.blockers.join()).toMatch(/linked by reversedByPaymentId to retained payment arp-keep/);
    const d = dataset();
    d.Invoice[0] = { ...d.Invoice[0], factoringItemId: 'f1' };
    expect(planPreDelete(d, selection()).blockers.join()).toMatch(/is factored/);
    const d2 = dataset();
    d2.LoadCharge.push({ id: 'chg-x', shipmentId: 'shp-200', loadId: 'lod-100' });
    expect(planPreDelete(d2, selection()).blockers.join()).toMatch(/belongs to a retained shipment/);
  });
  it('deviations name every number that differs from the approved scope', () => {
    const proof = conservationProof(dataset(payments), plan);
    const lines = deviations({ selection: selection(), removed: removedTotals(plan), proof });
    expect(lines.join('\n')).toMatch(/shipments deleted: got 3, expected 441/);
    expect(lines.join('\n')).toMatch(/retained open AR cents \(before\)/);
  });
  it('one AuditLog item per shipment, deterministic id, no PII', () => {
    const items = auditItems(plan, new Date('2026-11-08T00:00:00Z'));
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ entityType: 'SHIPMENT', action: 'AW_PREDELETE', id: 'aw-predelete:shp-100' });
    expect(JSON.parse(items[0].changes)).toMatchObject({ pro: '100', deleted: { Invoice: 1, CarrierBill: 1 } });
  });
});

// ── in-memory DocumentClient: Put/Get/Update/Delete with the conditions the script uses ──
function fakeDoc(data) {
  const tables = new Map();
  for (const [m, rows] of Object.entries(data)) tables.set(`${m}-${DEV_SUFFIX}`, new Map(rows.map((r) => [r.id, structuredClone(r)])));
  const ops = [];
  const cond = (row, input) => {
    const expr = input.ConditionExpression ?? '';
    if (expr.includes('attribute_not_exists(id)') && row) return false;
    if (expr.includes('attribute_exists(id)') && !row) return false;
    for (const [, name, val] of expr.matchAll(/(#?\w+) = (:\w+)/g)) {
      const field = name.startsWith('#') ? input.ExpressionAttributeNames[name] : name;
      if (row?.[field] !== input.ExpressionAttributeValues[val]) return false;
    }
    return true;
  };
  const fail = Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' });
  return {
    tables, ops,
    async send(cmd) {
      const { input } = cmd;
      const name = cmd.constructor.name.replace('Command', '');
      const t = tables.get(input.TableName) ?? tables.set(input.TableName, new Map()).get(input.TableName);
      const key = input.Key?.id ?? input.Item?.id;
      ops.push({ op: name, table: input.TableName.split('-')[0], id: key });
      if (name === 'Get') return { Item: t.get(key) };
      if (!cond(t.get(key), input)) throw fail;
      if (name === 'Delete') t.delete(key);
      else if (name === 'Put') t.set(key, structuredClone(input.Item));
      else if (name === 'Update') {
        const row = t.get(key);
        row.applications = input.ExpressionAttributeValues[':apps'];
        row.appliedCents = input.ExpressionAttributeValues[':applied'];
        row.amountCents = input.ExpressionAttributeValues[':amount'];
      }
      return {};
    },
  };
}
const memFs = () => {
  const files = new Map();
  return {
    files,
    existsSync: (p) => files.has(p),
    mkdirSync: () => {}, chmodSync: () => {},
    readdirSync: () => [...files.keys()],
    readFileSync: (p) => { if (!files.has(p)) throw new Error(`ENOENT ${p}`); return files.get(p); },
    writeFileSync: (p, text) => files.set(p, text),
  };
};
const exp = (fs, plan) => writeAndVerifyExport({ dir: '/x', plan, suffix: DEV_SUFFIX, shipBefore: '2025-01-01', fs });

describe('export + verification', () => {
  const payments = { ar: [ar('arp-mix', [inv('101', 1000), inv('200', 400)])], ap: [] };
  const plan = planPreDelete(dataset(payments), selection());

  it('writes every row to be deleted or modified, then verifies count + sha from disk', () => {
    const { manifest, rows } = exp(memFs(), plan);
    expect(manifest.files['Shipment.delete.jsonl']).toMatchObject({ count: 3, kind: 'delete' });
    expect(manifest.files['ArPayment.modify.jsonl']).toMatchObject({ count: 1, kind: 'modify' });
    expect(rows['Invoice.delete.jsonl']).toHaveLength(3);
    expect(missingFromExport(plan, rows)).toEqual([]);
  });
  it('refuses a tampered file, a short file, a missing file and a foreign suffix; reuses a good export on re-run', () => {
    const fs = memFs();
    exp(fs, plan);
    expect(exp(fs, plan).reused).toBe(true);
    expect(() => writeAndVerifyExport({ dir: '/x', plan, suffix: 'other-NONE', shipBefore: '2025-01-01', fs })).toThrow(/belongs to/);
    const name = '/x/Invoice.delete.jsonl';
    const good = fs.files.get(name);
    fs.files.set(name, good.replace('PAID', 'XAID'));
    expect(() => exp(fs, plan)).toThrow(/sha256 mismatch/);
    fs.files.delete(name);
    expect(() => exp(fs, plan)).toThrow(/ENOENT|missing/);
    const files = exportFiles(plan);
    const manifest = buildManifest({ files, suffix: DEV_SUFFIX, shipBefore: '2025-01-01' });
    expect(() => verifyExport({ ...manifest, files: { ...manifest.files, 'Invoice.delete.jsonl': { ...manifest.files['Invoice.delete.jsonl'], count: 99 } } }, (n) => files[n].text)).toThrow(/manifest says 99/);
  });
  it('refuses to overwrite a directory that has files but no manifest', () => {
    const fs = memFs();
    fs.files.set('/x/stray', 'x');
    expect(() => exp(fs, plan)).toThrow(/no manifest/);
  });
  it('a plan row the export lacks (e.g. new data since the export) is refused', () => {
    const fs = memFs();
    exp(fs, plan);
    const bigger = planPreDelete({ ...dataset(payments), ArPayment: [...payments.ar, ar('arp-new', [inv('100', 5), inv('200', 5)])] }, selection());
    expect(() => exp(fs, bigger)).toThrow(/does not hold 1 row/);
  });
  it('JSON lines round-trip DynamoDB sets', () => {
    expect(fromJsonLine(toJsonLine({ id: 'a', tags: new Set(['x', 'y']) })).tags).toEqual(new Set(['x', 'y']));
  });
});

describe('apply + restore against an in-memory table', () => {
  const payments = {
    ar: [ar('arp-old', [inv('100', 1000)]), ar('arp-mix', [inv('101', 1000), inv('200', 400)]), ar('arp-keep', [inv('200', 77)])],
    ap: [ap('app-old', [bill('cb:lcr-100:1', 600)])],
  };
  const setup = () => {
    const data = dataset(payments);
    const plan = planPreDelete(data, selection());
    const { rows } = exp(memFs(), plan);
    return { data, plan, rows, verified: new Set(Object.keys(rows)) };
  };

  it('modifies payments, deletes children before parents, audits before the shipment goes, never touches retained rows', async () => {
    const { data, plan, verified } = setup();
    const doc = fakeDoc({ ...data, AuditLog: [] });
    const out = await applyPlan({ doc, suffix: DEV_SUFFIX, plan, verifiedFiles: verified, concurrency: 1 });
    expect(out['Shipment.delete']).toEqual({ deleted: 3 });
    expect(out['ArPayment.modify']).toEqual({ modified: 1 });
    const t = (m) => doc.tables.get(`${m}-${DEV_SUFFIX}`);
    expect([...t('Shipment').keys()].sort()).toEqual(['shp-200', 'shp-300', 'shp-400', 'shp-L100']);
    expect([...t('Invoice').keys()].sort()).toEqual(['200', '400']);
    expect(t('ArPayment').get('arp-mix')).toMatchObject({ amountCents: 400, appliedCents: 400, unappliedCents: 0 });
    expect(t('ArPayment').has('arp-old')).toBe(false);
    expect(t('ArPayment').get('arp-keep')).toMatchObject({ amountCents: 77 });
    expect(t('AuditLog').size).toBe(3);
    const tablesInOrder = doc.ops.filter((o) => o.table !== 'AuditLog').map((o) => o.table);
    expect(tablesInOrder.indexOf('Invoice')).toBeLessThan(tablesInOrder.indexOf('Order'));
    expect(tablesInOrder.lastIndexOf('Order')).toBeLessThan(tablesInOrder.indexOf('Shipment'));
    expect(doc.ops.findIndex((o) => o.table === 'AuditLog')).toBeLessThan(doc.ops.findIndex((o) => o.table === 'Shipment'));
    expect(doc.ops.some((o) => ['FactoringItem', 'TmsSettings'].includes(o.table))).toBe(false);
  });
  it('is idempotent: a second run over the same plan deletes nothing twice and writes no second audit row', async () => {
    const { data, plan, verified } = setup();
    const doc = fakeDoc({ ...data, AuditLog: [] });
    await applyPlan({ doc, suffix: DEV_SUFFIX, plan, verifiedFiles: verified });
    const again = await applyPlan({ doc, suffix: DEV_SUFFIX, plan, verifiedFiles: verified });
    expect(again['Shipment.delete']).toEqual({ changed: 3 });
    expect(again['ArPayment.modify']).toEqual({ changed: 1 });
    expect(again['AuditLog.put']).toEqual({ exists: 3 });
    expect(doc.tables.get(`AuditLog-${DEV_SUFFIX}`).size).toBe(3);
  });
  it('refuses a table whose export file is not verified, before writing anything to it', async () => {
    const { data, plan, verified } = setup();
    verified.delete('Invoice.delete.jsonl');
    const doc = fakeDoc({ ...data, AuditLog: [] });
    await expect(applyPlan({ doc, suffix: DEV_SUFFIX, plan, verifiedFiles: verified })).rejects.toThrow(/Invoice.delete.jsonl is not written and verified/);
    expect(doc.ops.some((o) => o.table === 'Invoice' && o.op === 'Delete')).toBe(false);
  });
  it('a conditional delete leaves a row whose key moved (a retained shipment reusing the id is never deleted)', async () => {
    const doc = fakeDoc({ Order: [{ id: 'o1', shipmentId: 'shp-other' }] });
    expect(await deleteRow({ doc, suffix: DEV_SUFFIX, model: 'Order', row: { id: 'o1', shipmentId: 'shp-100' } })).toBe('changed');
    expect(doc.tables.get(`Order-${DEV_SUFFIX}`).has('o1')).toBe(true);
  });
  it('restore puts back every deleted row if absent and reverts modified payments; a re-run and a dry run write nothing more', async () => {
    const { data, plan, rows, verified } = setup();
    const doc = fakeDoc({ ...data, AuditLog: [] });
    await applyPlan({ doc, suffix: DEV_SUFFIX, plan, verifiedFiles: verified });
    const dry = await restoreExport({ doc, suffix: DEV_SUFFIX, rows, apply: false });
    expect(dry['Shipment.put']).toEqual({ wouldPut: 3 });
    expect(doc.tables.get(`Shipment-${DEV_SUFFIX}`).size).toBe(4);
    const res = await restoreExport({ doc, suffix: DEV_SUFFIX, rows, apply: true });
    expect(res['Shipment.put']).toEqual({ put: 3 });
    expect(res['ArPayment.revert']).toEqual({ reverted: 1 });
    const t = (m) => doc.tables.get(`${m}-${DEV_SUFFIX}`);
    expect([...t('Shipment').keys()].sort()).toEqual(['shp-100', 'shp-101', 'shp-102', 'shp-200', 'shp-300', 'shp-400', 'shp-L100']);
    expect(t('ArPayment').get('arp-mix')).toEqual(data.ArPayment.find((p) => p.id === 'arp-mix'));
    expect(t('Invoice').size).toBe(5);
    const again = await restoreExport({ doc, suffix: DEV_SUFFIX, rows, apply: true });
    expect(again['Shipment.put']).toEqual({ present: 3 });
    expect(again['ArPayment.revert']).toEqual({ skipped: 1 });
  });
  it('restore never overwrites a row that already exists', async () => {
    const { rows } = setup();
    const doc = fakeDoc({ Shipment: [{ id: 'shp-100', number: 'REUSED' }] });
    await restoreExport({ doc, suffix: DEV_SUFFIX, rows, apply: true });
    expect(doc.tables.get(`Shipment-${DEV_SUFFIX}`).get('shp-100').number).toBe('REUSED');
  });
  it('refuses production tables without the gate', async () => {
    const { plan, verified } = setup();
    await expect(applyPlan({ doc: fakeDoc({}), suffix: PROD_SUFFIX, plan, verifiedFiles: verified })).rejects.toThrow(/without --target prod/);
  });
});

describe('write set + production gate', () => {
  it('backs up exactly the tables the script writes and prodBackup accepts the script', () => {
    expect([...PROD_WRITE_SETS.awPreDelete.models].sort()).toEqual([...DELETE_ORDER, 'AuditLog'].sort());
    expect(PROD_WRITE_SETS.awPreDelete.models).not.toContain('FactoringItem');
    expect(PROD_WRITE_SETS.awPreDelete.models).not.toContain('TmsSettings');
    expect(resolveScripts('awPreDelete')).toEqual(['awPreDelete']);
  });

  const NOW = new Date(2026, 10, 8, 12, 0, 0);
  const TODAY = '2026-11-08';
  const ACCT = '111122223333';
  const backups = (skip = []) => ({
    async send(cmd) {
      const t = cmd.input.TableName;
      return { BackupSummaries: skip.includes(t.split('-')[0]) ? [] : [{ TableName: t, BackupName: `prodpre-awPreDelete-${t}-x`, BackupStatus: 'AVAILABLE', BackupCreationDateTime: new Date(NOW.getTime() - 600000) }] };
    },
  });
  const run = (over = {}, valueOver = {}) => preDeleteGate(
    { target: 'prod', 'i-mean-production': true, apply: true, 'confirm-prod': `${ACCT}:${PROD_SUFFIX}`, ...valueOver },
    { env: { [ALLOW_ENV]: TODAY, AW_PROD_CONFIRM: `${TODAY}-predelete` }, now: NOW, accountId: async () => ACCT, dynamo: backups(), out: () => {}, ...over },
  );
  it('opens only with every condition', async () => {
    expect(await run()).toMatchObject({ apply: true, suffix: PROD_SUFFIX });
  });
  it.each([
    ['BCAT_ALLOW_PROD missing', { env: { AW_PROD_CONFIRM: `${TODAY}-predelete` } }, {}, /BCAT_ALLOW_PROD/],
    ['stale/missing backup of Invoice', { dynamo: backups(['Invoice']) }, {}, /backup/],
    ['stale/missing backup of ApPayment', { dynamo: backups(['ApPayment']) }, {}, /backup/],
    ['no --i-mean-production', {}, { 'i-mean-production': false }, /i-mean-production/],
    ['wrong typed confirmation', {}, { 'confirm-prod': `${ACCT}:wrong` }, /typed confirmation/],
    ['AW_PROD_CONFIRM missing', { env: { [ALLOW_ENV]: TODAY } }, {}, /AW_PROD_CONFIRM must equal 2026-11-08-predelete/],
    ['AW_PROD_CONFIRM of the release script', { env: { [ALLOW_ENV]: TODAY, AW_PROD_CONFIRM: `${TODAY}-release` } }, {}, /AW_PROD_CONFIRM/],
  ])('refuses an apply: %s', async (_n, over, valueOver, re) => {
    await expect(run(over, valueOver)).rejects.toThrow(re);
  });
  it('a dry run needs neither backups nor AW_PROD_CONFIRM', async () => {
    const g = await run({ env: { [ALLOW_ENV]: TODAY }, dynamo: backups(DELETE_ORDER) }, { apply: false, 'confirm-prod': undefined });
    expect(g.apply).toBe(false);
  });
});
