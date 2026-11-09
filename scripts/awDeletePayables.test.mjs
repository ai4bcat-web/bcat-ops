import { describe, expect, it } from 'vitest';
import {
  applyPlan, billsCsv, deleteBill, deletePayablesGate, restoreExport, writeAndVerifyExport,
} from './awDeletePayables.mjs';
import {
  EXPECTED, assertHardGuarantees, auditItems, buildManifest, conservationProof, deviations, exportFiles, fieldPatch, missingFromExport,
  planDeletePayables, releasedLeg, removedTotals, selectBills, toJsonLine,
} from './lib/deletePayables.mjs';
import { fromJsonLine, verifyExport } from './lib/preDelete.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';
import { resolveScripts } from './prodBackup.mjs';
import { ALLOW_ENV, DEV_SUFFIX, PROD_SUFFIX } from './lib/prodGate.mjs';

const NOW = new Date('2026-11-09T12:00:00Z');

// ── fixtures ──
// b1: TO_BE_PAID 2025 open (leg lc1); b2: PARTIAL 2025 open (leg lc2, paid 400 by pay-only + 100 by pay-mix);
// b3: PAID 2025; b4: PARTIAL dated 2024 (open but not 2025); b5: TO_BE_PAID 2026; b6: VOID 2025 balance 0.
const bill = (id, over = {}) => ({ id, billDate: '2025-06-01', status: 'TO_BE_PAID', carrierId: 'k1', shipmentId: `shp-${id}`, loadCarrierId: `lc-${id}`, billedCents: 1000, paidCents: 0, balanceCents: 1000, apOpen: 'OPEN', ...over });
const leg = (id, over = {}) => ({ id: `lc-${id}`, kind: 'CARRIER', apStatus: 'TO_BE_PAID', apOpen: 'OPEN', apBalanceCents: 1000, chargesFinalizedAt: '2025-06-01T12:00:00.000Z', apStatusChangedAt: '2025-06-01T12:00:00.000Z', updatedBy: 'aljex-import', updatedAt: '2025-06-01T12:00:00.000Z', ...over });
const app = (id, apps, over = {}) => {
  const applied = apps.reduce((a, x) => a + x.amountCents, 0);
  const unapplied = over.unappliedCents ?? 0;
  return { id, carrierId: 'k1', kind: 'PAYMENT', amountCents: applied + unapplied, appliedCents: applied, unappliedCents: unapplied, applications: apps, ...over };
};
const on = (billId, amountCents) => ({ billId, amountCents });
const dataset = (payments = []) => ({
  CarrierBill: [
    bill('b1'),
    bill('b2', { status: 'PARTIAL', paidCents: 500, balanceCents: 500 }),
    bill('b3', { status: 'PAID', paidCents: 1000, balanceCents: 0, apOpen: undefined }),
    bill('b4', { status: 'PARTIAL', billDate: '2024-12-31', paidCents: 300, balanceCents: 700 }),
    bill('b5', { billDate: '2026-01-01' }),
    bill('b6', { status: 'VOID', balanceCents: 0, apOpen: undefined }),
  ],
  LoadCarrier: ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'].map((n) => leg(n)),
  ApPayment: payments,
});
const PAYMENTS = [
  app('pay-only', [on('b2', 400)]), // only deleted bills -> deleted
  app('pay-mix', [on('b2', 100), on('b3', 600)]), // mixed with a retained paid bill -> modified
  app('pay-retained', [on('b3', 400), on('b4', 300)]), // untouched
  app('pay-credit', [on('b2', 50)], { unappliedCents: 25 }), // old only but unapplied credit -> modified, credit stays
];
const plan = () => planDeletePayables(dataset(PAYMENTS), { now: NOW });

describe('selection', () => {
  it('selects only open bills dated 2025: never PAID/VOID, never another year', () => {
    const s = selectBills(dataset().CarrierBill);
    expect(s.delete.map((b) => b.id)).toEqual(['b1', 'b2']);
    expect(s.paid2025).toBe(1);
    expect(s.total2025).toBe(4);
    expect(s.other2025.map((b) => b.id)).toEqual(['b6']);
  });
  it('the 2025 boundary is by billDate year (2024-12-31 and 2026-01-01 are kept)', () => {
    const s = selectBills([bill('x', { billDate: '2025-01-01' }), bill('y', { billDate: '2025-12-31' }), bill('z', { billDate: '2024-12-31' }), bill('w', { billDate: '2026-01-01' })]);
    expect(s.delete.map((b) => b.id)).toEqual(['x', 'y']);
  });
  it('a bill with no open balance is never selected, even unpaid-status', () => {
    expect(selectBills([bill('x', { balanceCents: 0 })]).delete).toEqual([]);
  });
  it('the hard guarantee throws if a PAID, VOID, out-of-year or zero-balance bill reaches the delete set', () => {
    for (const b of [bill('p', { status: 'PAID' }), bill('v', { status: 'VOID' }), bill('o', { billDate: '2024-06-01' }), bill('z', { balanceCents: 0 })]) {
      expect(() => assertHardGuarantees({ delete: [b] })).toThrow(/HARD GUARANTEE/);
    }
  });
});

describe('plan: mixed payments and legs', () => {
  it('deletes exactly the open 2025 bills and nothing else', () => {
    const p = plan();
    expect(p.deletes.CarrierBill.map((b) => b.id)).toEqual(['b1', 'b2']);
    expect(p.blockers).toEqual([]);
  });
  it('a payment applied only to deleted bills is deleted; mixed ones keep retained lines; credit stays as unapplied', () => {
    const p = plan();
    expect(p.deletes.ApPayment.map((x) => x.id)).toEqual(['pay-only']);
    const mix = p.modifies.ApPayment.find((x) => x.before.id === 'pay-mix');
    expect(mix).toMatchObject({ reason: 'MIXED', removedCents: 100, after: { amountCents: 600, appliedCents: 600, unappliedCents: 0, applications: [on('b3', 600)] } });
    const credit = p.modifies.ApPayment.find((x) => x.before.id === 'pay-credit');
    expect(credit).toMatchObject({ reason: 'OLD_ONLY_WITH_CREDIT', after: { amountCents: 25, appliedCents: 0, unappliedCents: 25, applications: [] } });
    expect(p.modifies.ApPayment.map((x) => x.before.id)).not.toContain('pay-retained');
    expect(p.notes.apKept).toBe(1);
  });
  it('refuses to guess when a payment applied total disagrees with its lines', () => {
    const p = planDeletePayables(dataset([{ ...app('bad', [on('b2', 5)]), appliedCents: 9 }]), { now: NOW });
    expect(p.blockers.join()).toMatch(/appliedCents does not equal/);
  });
  it('blocks a reversal link between a deleted payment and a retained one', () => {
    const p = planDeletePayables(dataset([app('pay-only', [on('b2', 400)], { reversedByPaymentId: 'keep' }), app('keep', [on('b3', 5)])]), { now: NOW });
    expect(p.blockers.join()).toMatch(/linked by reversedByPaymentId to retained payment keep/);
  });
  it('releases each deleted bill leg like the app VOID_BILL: AWAITING_INVOICE, bill fields removed, loads untouched', () => {
    const p = plan();
    expect(p.modifies.LoadCarrier.map((x) => x.before.id)).toEqual(['lc-b1', 'lc-b2']);
    const after = p.modifies.LoadCarrier[0].after;
    expect(after).toMatchObject({ id: 'lc-b1', apStatus: 'AWAITING_INVOICE', apStatusChangedAt: NOW.toISOString(), updatedBy: 'aw-delete-payables' });
    for (const f of ['invoiceId', 'apBalanceCents', 'chargesFinalizedAt']) expect(after).not.toHaveProperty(f);
    expect(after.apOpen).toBe('OPEN'); // VOID_BILL leaves apOpen
    expect(after.kind).toBe('CARRIER');
  });
  it('a leg that points at a different bill is left alone, and a retained bill on a released leg blocks', () => {
    const d = dataset();
    d.LoadCarrier[0] = leg('b1', { invoiceId: 'cb:other' });
    expect(planDeletePayables(d, { now: NOW }).modifies.LoadCarrier.map((x) => x.before.id)).toEqual(['lc-b2']);
    const d2 = dataset();
    d2.CarrierBill.push(bill('b7', { loadCarrierId: 'lc-b1', billDate: '2026-02-02' }));
    expect(planDeletePayables(d2, { now: NOW }).blockers.join()).toMatch(/retained bill b7 sits on a leg/);
  });
  it('a missing leg is counted, not an error', () => {
    const d = dataset();
    d.LoadCarrier = d.LoadCarrier.filter((l) => l.id !== 'lc-b1');
    expect(planDeletePayables(d, { now: NOW }).notes.legMissing).toBe(1);
  });
});

describe('conservation arithmetic', () => {
  it('open AP drops by exactly the removed open balances; retained paid AP, retained payments and unapplied credit are conserved', () => {
    const d = dataset(PAYMENTS);
    const p = planDeletePayables(d, { now: NOW });
    const proof = conservationProof(d, p);
    expect(proof.ok).toBe(true);
    expect(proof.before.openApCents).toBe(1000 + 500 + 700 + 1000);
    expect(proof.after.openApCents).toBe(700 + 1000);
    expect(removedTotals(p).bills).toMatchObject({ count: 2, openCents: 1500, byStatus: { TO_BE_PAID: 1, PARTIAL: 1 } });
    expect(proof.after.paidApCents).toBe(proof.before.paidApCents - 500);
    expect(proof.after.apUnappliedCents).toBe(proof.before.apUnappliedCents);
    expect(proof.carriers.removed.k1).toMatchObject({ bills: 2, openCents: 1500 });
  });
  it('fails when a retained payment would end up out of balance or a retained bill loses payment dollars', () => {
    const d = dataset(PAYMENTS);
    const p = planDeletePayables(d, { now: NOW });
    const broken = { ...p, modifies: { ...p.modifies, ApPayment: p.modifies.ApPayment.map((x) => (x.before.id === 'pay-mix' ? { ...x, after: { ...x.after, amountCents: x.after.amountCents + 1 } } : x)) } };
    expect(conservationProof(d, broken).checks.everyRetainedPaymentBalances).toBe(false);
    const lost = { ...p, modifies: { ...p.modifies, ApPayment: p.modifies.ApPayment.map((x) => (x.before.id === 'pay-mix' ? { ...x, after: { ...x.after, applications: [on('b3', 500)], appliedCents: 500, amountCents: 500 } } : x)) } };
    const proof = conservationProof(d, lost);
    expect(proof.checks.retainedBillPaymentsUnchanged).toBe(false);
    expect(proof.ok).toBe(false);
  });
  it('fails if a PAID bill were deleted', () => {
    const d = dataset();
    const p = planDeletePayables(d, { now: NOW });
    const bad = { ...p, deletes: { ...p.deletes, CarrierBill: [...p.deletes.CarrierBill, d.CarrierBill.find((b) => b.id === 'b3')] } };
    expect(conservationProof(d, bad).checks.noPaidBillDeleted).toBe(false);
  });
  it('deviations name every number that differs from Ryne\'s decision', () => {
    const d = dataset(PAYMENTS);
    const p = planDeletePayables(d, { now: NOW });
    const lines = deviations({ selection: p.selection, removed: removedTotals(p), proof: conservationProof(d, p) }).join('\n');
    expect(lines).toMatch(new RegExp(`bills deleted: got 2, expected ${EXPECTED.bills}`));
    expect(lines).toMatch(/PAID bills dated 2025 \(kept\): got 1, expected 1360/);
  });
});

// ── in-memory DocumentClient: Put/Get/Update/Delete with the conditions and SET/REMOVE the script uses ──
function fakeDoc(data) {
  const tables = new Map();
  for (const [m, rows] of Object.entries(data)) tables.set(`${m}-${DEV_SUFFIX}`, new Map(rows.map((r) => [r.id, structuredClone(r)])));
  const ops = [];
  const fail = Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' });
  const names = (input, n) => (n.startsWith('#') ? input.ExpressionAttributeNames[n] : n);
  const cond = (row, input) => {
    const expr = input.ConditionExpression ?? '';
    if (expr.includes('attribute_not_exists(id)') && row) return false;
    if (expr.includes('attribute_exists(id)') && !row) return false;
    for (const [, n] of expr.matchAll(/attribute_not_exists\((#\w+)\)/g)) if (row?.[names(input, n)] !== undefined) return false;
    for (const [, n, v] of expr.matchAll(/(#?\w+) = (:\w+)/g)) if (row?.[names(input, n)] !== input.ExpressionAttributeValues[v]) return false;
    return true;
  };
  return {
    tables, ops,
    async send(cmd) {
      const { input } = cmd;
      const op = cmd.constructor.name.replace('Command', '');
      const t = tables.get(input.TableName) ?? tables.set(input.TableName, new Map()).get(input.TableName);
      const key = input.Key?.id ?? input.Item?.id;
      ops.push({ op, table: input.TableName.split('-')[0], id: key });
      if (op === 'Get') return { Item: t.get(key) };
      if (!cond(t.get(key), input)) throw fail;
      if (op === 'Delete') t.delete(key);
      else if (op === 'Put') t.set(key, structuredClone(input.Item));
      else if (op === 'Update') {
        const row = t.get(key);
        const v = input.ExpressionAttributeValues;
        if (v[':apps'] !== undefined) {
          row.applications = v[':apps']; row.appliedCents = v[':applied']; row.amountCents = v[':amount'];
        } else {
          const expr = input.UpdateExpression;
          const [setPart, removePart] = [/SET (.*?)(?: REMOVE |$)/.exec(expr)?.[1], /REMOVE (.*)$/.exec(expr)?.[1]];
          for (const s of (setPart ?? '').split(', ').filter(Boolean)) { const [n, val] = s.split(' = '); row[names(input, n)] = structuredClone(v[val]); }
          for (const n of (removePart ?? '').split(', ').filter(Boolean)) delete row[names(input, n)];
        }
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
const exp = (fs, p) => writeAndVerifyExport({ dir: '/x', plan: p, suffix: DEV_SUFFIX, fs, now: NOW });

describe('export + verification', () => {
  const p = plan();
  it('writes every row to be deleted or edited with count + sha256, and the plan is fully covered', () => {
    const { manifest, rows } = exp(memFs(), p);
    expect(manifest).toMatchObject({ script: 'awDeletePayables', suffix: DEV_SUFFIX });
    expect(manifest.files['CarrierBill.delete.jsonl']).toMatchObject({ count: 2, kind: 'delete' });
    expect(manifest.files['ApPayment.delete.jsonl']).toMatchObject({ count: 1, kind: 'delete' });
    expect(manifest.files['ApPayment.modify.jsonl']).toMatchObject({ count: 2, kind: 'modify' });
    expect(manifest.files['LoadCarrier.modify.jsonl']).toMatchObject({ count: 2, kind: 'modify' });
    expect(missingFromExport(p, rows)).toEqual([]);
  });
  it('refuses a tampered file, a short file, a missing file and a foreign suffix; reuses a good export on re-run', () => {
    const fs = memFs();
    exp(fs, p);
    expect(exp(fs, p).reused).toBe(true);
    expect(() => writeAndVerifyExport({ dir: '/x', plan: p, suffix: 'other-NONE', fs })).toThrow(/belongs to/);
    const name = '/x/CarrierBill.delete.jsonl';
    const good = fs.files.get(name);
    fs.files.set(name, good.replace('TO_BE_PAID', 'XO_BE_PAID'));
    expect(() => exp(fs, p)).toThrow(/sha256 mismatch/);
    fs.files.delete(name);
    expect(() => exp(fs, p)).toThrow(/ENOENT|missing/);
    const files = exportFiles(p);
    const manifest = buildManifest({ files, suffix: DEV_SUFFIX, now: NOW });
    expect(() => verifyExport({ ...manifest, files: { ...manifest.files, 'CarrierBill.delete.jsonl': { ...manifest.files['CarrierBill.delete.jsonl'], count: 99 } } }, (n) => files[n].text)).toThrow(/manifest says 99/);
  });
  it('refuses to overwrite a directory that has files but no manifest', () => {
    const fs = memFs();
    fs.files.set('/x/stray', 'x');
    expect(() => exp(fs, p)).toThrow(/no manifest/);
  });
  it('a plan row the export lacks (new data since the export) is refused', () => {
    const fs = memFs();
    exp(fs, p);
    const bigger = planDeletePayables(dataset([...PAYMENTS, app('pay-new', [on('b1', 5)])]), { now: NOW });
    expect(() => exp(fs, bigger)).toThrow(/does not hold 1 row/);
  });
  it('JSON lines round-trip DynamoDB sets', () => {
    expect(fromJsonLine(toJsonLine({ id: 'a', tags: new Set(['x', 'y']) })).tags).toEqual(new Set(['x', 'y']));
  });
});

describe('apply + restore against an in-memory table', () => {
  const setup = () => {
    const data = dataset(PAYMENTS);
    const p = planDeletePayables(data, { now: NOW });
    const { rows } = exp(memFs(), p);
    return { data, p, rows, verified: new Set(Object.keys(rows)) };
  };
  const t = (doc, m) => doc.tables.get(`${m}-${DEV_SUFFIX}`);

  it('edits payments, releases legs, audits, deletes the bills last; paid bills, other-year bills and other legs are untouched', async () => {
    const { data, p, verified } = setup();
    const doc = fakeDoc({ ...data, AuditLog: [] });
    const out = await applyPlan({ doc, suffix: DEV_SUFFIX, plan: p, verifiedFiles: verified, now: NOW, concurrency: 1 });
    expect(out).toMatchObject({ 'ApPayment.modify': { modified: 2 }, 'ApPayment.delete': { deleted: 1 }, 'LoadCarrier.release': { patched: 2 }, 'AuditLog.put': { written: 2 }, 'CarrierBill.delete': { deleted: 2 } });
    expect([...t(doc, 'CarrierBill').keys()].sort()).toEqual(['b3', 'b4', 'b5', 'b6']);
    expect(t(doc, 'ApPayment').has('pay-only')).toBe(false);
    expect(t(doc, 'ApPayment').get('pay-mix')).toMatchObject({ amountCents: 600, appliedCents: 600 });
    expect(t(doc, 'ApPayment').get('pay-retained')).toEqual(data.ApPayment.find((x) => x.id === 'pay-retained'));
    const l1 = t(doc, 'LoadCarrier').get('lc-b1');
    expect(l1).toMatchObject({ apStatus: 'AWAITING_INVOICE', kind: 'CARRIER' });
    expect(l1.apOpen).toBe('OPEN');
    expect(l1).not.toHaveProperty('apBalanceCents');
    expect(t(doc, 'LoadCarrier').get('lc-b3')).toEqual(data.LoadCarrier.find((x) => x.id === 'lc-b3'));
    expect(t(doc, 'LoadCarrier').get('lc-b4')).toEqual(data.LoadCarrier.find((x) => x.id === 'lc-b4'));
    expect(t(doc, 'AuditLog').get('aw-delpayables:b2')).toMatchObject({ action: 'AW_DELETE_PAYABLE', entityType: 'CarrierBill', entityId: 'b2' });
    const order = doc.ops.map((o) => o.table);
    expect(order.lastIndexOf('AuditLog')).toBeLessThan(order.indexOf('CarrierBill'));
    expect(order.lastIndexOf('LoadCarrier')).toBeLessThan(order.indexOf('CarrierBill'));
    expect(doc.ops.every((o) => ['ApPayment', 'LoadCarrier', 'AuditLog', 'CarrierBill'].includes(o.table))).toBe(true);
  });
  it('is idempotent: a second run changes nothing and writes no second audit row', async () => {
    const { data, p, verified } = setup();
    const doc = fakeDoc({ ...data, AuditLog: [] });
    await applyPlan({ doc, suffix: DEV_SUFFIX, plan: p, verifiedFiles: verified, now: NOW });
    const snapshot = JSON.stringify([...doc.tables].map(([k, v]) => [k, [...v]]));
    const again = await applyPlan({ doc, suffix: DEV_SUFFIX, plan: p, verifiedFiles: verified, now: NOW });
    expect(again).toMatchObject({ 'ApPayment.modify': { changed: 2 }, 'ApPayment.delete': { changed: 1 }, 'LoadCarrier.release': { changed: 2 }, 'AuditLog.put': { exists: 2 }, 'CarrierBill.delete': { changed: 2 } });
    expect(JSON.stringify([...doc.tables].map(([k, v]) => [k, [...v]]))).toBe(snapshot);
  });
  it('refuses a step whose export file is not verified, before writing anything', async () => {
    const { data, p, verified } = setup();
    verified.delete('LoadCarrier.modify.jsonl');
    const doc = fakeDoc({ ...data, AuditLog: [] });
    await expect(applyPlan({ doc, suffix: DEV_SUFFIX, plan: p, verifiedFiles: verified, now: NOW })).rejects.toThrow(/LoadCarrier.modify.jsonl is not written and verified/);
    expect(doc.ops.filter((o) => o.op !== 'Get')).toEqual([]);
  });
  it('a bill that became PAID (or whose balance moved) since the plan is never deleted', async () => {
    const { data, p } = setup();
    const doc = fakeDoc({ ...data, AuditLog: [] });
    t(doc, 'CarrierBill').get('b1').status = 'PAID';
    expect(await deleteBill({ doc, suffix: DEV_SUFFIX, row: p.deletes.CarrierBill[0] })).toBe('changed');
    t(doc, 'CarrierBill').get('b2').balanceCents = 1;
    expect(await deleteBill({ doc, suffix: DEV_SUFFIX, row: p.deletes.CarrierBill[1] })).toBe('changed');
    expect(t(doc, 'CarrierBill').size).toBe(6);
  });
  it('a leg that a later bill moved on (new invoiceId) is not released', async () => {
    const { data, p, verified } = setup();
    const doc = fakeDoc({ ...data, AuditLog: [] });
    t(doc, 'LoadCarrier').get('lc-b1').invoiceId = 'cb:new';
    const out = await applyPlan({ doc, suffix: DEV_SUFFIX, plan: p, verifiedFiles: verified, now: NOW });
    expect(out['LoadCarrier.release']).toEqual({ patched: 1, changed: 1 });
    expect(t(doc, 'LoadCarrier').get('lc-b1').invoiceId).toBe('cb:new');
  });
  it('restore: dry run writes nothing; apply puts every deleted row back and reverts edits exactly; a re-run is a no-op', async () => {
    const { data, p, rows, verified } = setup();
    const doc = fakeDoc({ ...data, AuditLog: [] });
    await applyPlan({ doc, suffix: DEV_SUFFIX, plan: p, verifiedFiles: verified, now: NOW });
    const dry = await restoreExport({ doc, suffix: DEV_SUFFIX, rows, apply: false });
    expect(dry).toMatchObject({ 'CarrierBill.put': { wouldPut: 2 }, 'ApPayment.put': { wouldPut: 1 }, 'ApPayment.revert': { wouldRevert: 2 }, 'LoadCarrier.revert': { wouldRevert: 2 } });
    expect(t(doc, 'CarrierBill').size).toBe(4);
    const res = await restoreExport({ doc, suffix: DEV_SUFFIX, rows, apply: true });
    expect(res).toMatchObject({ 'CarrierBill.put': { put: 2 }, 'ApPayment.put': { put: 1 }, 'ApPayment.revert': { reverted: 2 }, 'LoadCarrier.revert': { reverted: 2 } });
    for (const m of ['CarrierBill', 'ApPayment', 'LoadCarrier']) {
      expect([...t(doc, m).values()].sort((a, b) => a.id.localeCompare(b.id))).toEqual([...data[m]].sort((a, b) => a.id.localeCompare(b.id)));
    }
    const again = await restoreExport({ doc, suffix: DEV_SUFFIX, rows, apply: true });
    expect(again).toMatchObject({ 'CarrierBill.put': { present: 2 }, 'ApPayment.revert': { skipped: 2 }, 'LoadCarrier.revert': { skipped: 2 } });
  });
  it('restore never overwrites an existing bill and skips a leg the app changed since', async () => {
    const { data, p, rows, verified } = setup();
    const doc = fakeDoc({ ...data, AuditLog: [] });
    await applyPlan({ doc, suffix: DEV_SUFFIX, plan: p, verifiedFiles: verified, now: NOW });
    t(doc, 'CarrierBill').set('b1', { id: 'b1', status: 'REUSED' });
    t(doc, 'LoadCarrier').get('lc-b2').apStatus = 'IN_REVIEW';
    const res = await restoreExport({ doc, suffix: DEV_SUFFIX, rows, apply: true });
    expect(t(doc, 'CarrierBill').get('b1').status).toBe('REUSED');
    expect(res['LoadCarrier.revert']).toEqual({ reverted: 1, skipped: 1 });
    expect(t(doc, 'LoadCarrier').get('lc-b2').apStatus).toBe('IN_REVIEW');
  });
  it('refuses production tables without the gate', async () => {
    const { p, verified } = setup();
    await expect(applyPlan({ doc: fakeDoc({}), suffix: PROD_SUFFIX, plan: p, verifiedFiles: verified })).rejects.toThrow(/without --target prod/);
    await expect(restoreExport({ doc: fakeDoc({}), suffix: PROD_SUFFIX, rows: {}, apply: true })).rejects.toThrow(/without --target prod/);
  });
});

describe('release patch + reports', () => {
  it('fieldPatch pins every patched field (value or absence) and removes the fields the target lacks', () => {
    const before = leg('x');
    const patch = fieldPatch(before, releasedLeg(before, NOW));
    expect(patch.UpdateExpression).toMatch(/^SET .* REMOVE /);
    expect(patch.ConditionExpression).toContain('attribute_exists(id)');
    expect(patch.ConditionExpression).toContain('attribute_not_exists'); // invoiceId absent on the migrated legs
    expect(fieldPatch(before, before)).toBeNull();
  });
  it('one AuditLog item per deleted bill with a deterministic id and no PII', () => {
    const items = auditItems(plan(), NOW);
    expect(items.map((i) => i.id)).toEqual(['aw-delpayables:b1', 'aw-delpayables:b2']);
    const c = JSON.parse(items[1].changes);
    expect(c).toMatchObject({ status: 'PARTIAL', balanceCents: 500, releasedLeg: 'lc-b2', deletedPayments: ['pay-only'], editedPayments: ['pay-mix', 'pay-credit'] });
  });
  it('the bills report lists every bill with its leg action', () => {
    expect(billsCsv(plan()).trim().split('\n')).toHaveLength(3);
    expect(billsCsv(plan())).toContain('RELEASED_NO_INVOICE_ID');
  });
});

describe('write set + production gate', () => {
  it('backs up exactly the tables the script writes and prodBackup accepts the script', () => {
    expect([...PROD_WRITE_SETS.awDeletePayables.models].sort()).toEqual(['ApPayment', 'AuditLog', 'CarrierBill', 'LoadCarrier']);
    for (const m of ['Invoice', 'ArPayment', 'Load', 'Shipment', 'Order', 'TmsSettings']) expect(PROD_WRITE_SETS.awDeletePayables.models).not.toContain(m);
    expect(resolveScripts('awDeletePayables')).toEqual(['awDeletePayables']);
  });

  const GNOW = new Date(2026, 10, 9, 12, 0, 0);
  const TODAY = '2026-11-09';
  const ACCT = '111122223333';
  const backups = (skip = []) => ({
    async send(cmd) {
      const tn = cmd.input.TableName;
      return { BackupSummaries: skip.includes(tn.split('-')[0]) ? [] : [{ TableName: tn, BackupName: `prodpre-awDeletePayables-${tn}-x`, BackupStatus: 'AVAILABLE', BackupCreationDateTime: new Date(GNOW.getTime() - 600000) }] };
    },
  });
  const run = (over = {}, valueOver = {}) => deletePayablesGate(
    { target: 'prod', 'i-mean-production': true, apply: true, 'confirm-prod': `${ACCT}:${PROD_SUFFIX}`, ...valueOver },
    { env: { [ALLOW_ENV]: TODAY, AW_PROD_CONFIRM: `${TODAY}-delpayables` }, now: GNOW, accountId: async () => ACCT, dynamo: backups(), out: () => {}, ...over },
  );
  it('opens only with every condition', async () => {
    expect(await run()).toMatchObject({ apply: true, suffix: PROD_SUFFIX });
  });
  it.each([
    ['BCAT_ALLOW_PROD missing', { env: { AW_PROD_CONFIRM: `${TODAY}-delpayables` } }, {}, /BCAT_ALLOW_PROD/],
    ['stale/missing backup of CarrierBill', { dynamo: backups(['CarrierBill']) }, {}, /backup/],
    ['stale/missing backup of LoadCarrier', { dynamo: backups(['LoadCarrier']) }, {}, /backup/],
    ['stale/missing backup of ApPayment', { dynamo: backups(['ApPayment']) }, {}, /backup/],
    ['no --i-mean-production', {}, { 'i-mean-production': false }, /i-mean-production/],
    ['wrong typed confirmation', {}, { 'confirm-prod': `${ACCT}:wrong` }, /typed confirmation/],
    ['AW_PROD_CONFIRM missing', { env: { [ALLOW_ENV]: TODAY } }, {}, /AW_PROD_CONFIRM must equal 2026-11-09-delpayables/],
    ['AW_PROD_CONFIRM of the predelete script', { env: { [ALLOW_ENV]: TODAY, AW_PROD_CONFIRM: `${TODAY}-predelete` } }, {}, /AW_PROD_CONFIRM/],
  ])('refuses an apply: %s', async (_n, over, valueOver, re) => {
    await expect(run(over, valueOver)).rejects.toThrow(re);
  });
  it('a dry run needs neither backups nor AW_PROD_CONFIRM', async () => {
    const g = await run({ env: { [ALLOW_ENV]: TODAY }, dynamo: backups(['CarrierBill', 'ApPayment', 'LoadCarrier', 'AuditLog']) }, { apply: false, 'confirm-prod': undefined });
    expect(g.apply).toBe(false);
  });
});
