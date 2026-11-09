/**
 * Pure parts of scripts/awPreDelete.mjs (no AWS, no files except the explicit export/restore helpers that take an `fs`
 * argument): which migrated Aljex shipments are deleted (Ship Date before a cutoff), every child row that goes with them,
 * how a payment that also pays retained invoices/bills is split, the before/after conservation proof, the export manifest
 * verification and the restore plan.
 *
 * Hard guarantees (assertSelection): only pure-numeric, legacyImported Shipment.number rows can be selected (never an
 * L<pro> original), a shipment with no / ambiguous Ship Date is KEPT, and no child row of a selected shipment may also
 * belong to a retained one.
 */
import { createHash } from 'node:crypto';
import { normalizePro } from '../../src/lib/proNumber.ts';

export const DEFAULT_SHIP_BEFORE = '2025-01-01';
export const AUDIT_ACTION = 'AW_PREDELETE';
export const AUDIT_USER = 'aw-predelete';

/** Ryne's read-only scope (2026-11-08, Ship Date < 2025-01-01). A deviation is REPORTED; it only blocks --apply. */
export const EXPECTED = {
  shipments: 441,
  noShipDate: 9,
  invoices: 438,
  invoicesOpenCents: 0,
  bills: 272,
  billsByStatus: { PAID: 265, PARTIAL: 5, TO_BE_PAID: 2 },
  billsOpenCents: 283804,
};
/** Retained open AR before and after (unchanged: the removed invoices are all paid). */
export const EXPECTED_RETAINED_OPEN_AR_CENTS = 35977558;

/** Delete order, children before parents. Payments are handled before this list (modify, then delete). */
export const DELETE_ORDER = ['ArPayment', 'ApPayment', 'CarrierBill', 'Invoice', 'LoadCharge', 'LoadCarrier', 'LoadFinancials', 'LegacyAljexRow', 'ProClaim', 'Load', 'Order', 'Shipment'];
export const MODIFY_MODELS = ['ArPayment', 'ApPayment'];
/** Models written (the gate's backup set mirrors this plus AuditLog). */
export const WRITTEN_MODELS = [...DELETE_ORDER, 'AuditLog'];

/** The attribute a conditional delete re-checks on the live row ("still the row we planned"). */
export const KEY_FIELD = {
  Shipment: 'number', Order: 'shipmentId', Load: 'shipmentId', LoadCarrier: 'shipmentId', LoadFinancials: 'shipmentId',
  LoadCharge: 'shipmentId', Invoice: 'shipmentId', CarrierBill: 'shipmentId', ProClaim: 'id', LegacyAljexRow: 'pro',
};

/**
 * MM/DD/YY or MM/DD/YYYY -> YYYY-MM-DD, null when blank/unparseable. Two-digit years follow the importer pivot (00-69 => 20yy,
 * 70-99 => 19yy, the importer's YEAR_PIVOT): the export carries 01/01/70 as an epoch placeholder on some rows, and that is 1970 (before any cutoff),
 * not 2070 (releaseClassify.parseAljexDate maps it to 2070, which is right for its release/invoice dates and wrong here).
 */
export function parseShipDate(value) {
  const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\s*$/.exec(value ?? '');
  if (!m) return null;
  const yy = Number(m[3]);
  const year = m[3].length === 2 ? (yy < 70 ? 2000 + yy : 1900 + yy) : yy;
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export const isPureNumeric = (v) => /^\d+$/.test(String(v ?? '').trim());
const str = (v) => (v == null ? '' : String(v));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// ───────────────────────────── selection ─────────────────────────────

/** @param {string} v YYYY-MM-DD */
export function assertShipBefore(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v ?? '') || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw new Error(`--ship-before must be YYYY-MM-DD (got "${v}")`);
  return v;
}

/**
 * Export rows -> PRO -> ship date. `rows` are raw `{pro, shipDate}` strings. A PRO whose rows disagree on the date is
 * `ambiguous` (kept); a PRO with only blank dates is `blank` (kept).
 * @returns {Map<string, {date: string|null, ambiguous: boolean}>}
 */
export function indexShipDates(rows) {
  const dates = new Map();
  for (const r of rows) {
    const key = normalizePro(r.pro);
    if (!key) continue;
    const set = dates.get(key) ?? dates.set(key, new Set()).get(key);
    set.add(parseShipDate(r.shipDate) ?? '');
  }
  const out = new Map();
  for (const [k, set] of dates) {
    const real = [...set].filter(Boolean);
    out.set(k, { date: real.length === 1 ? real[0] : null, ambiguous: real.length > 1 });
  }
  return out;
}

/**
 * Classify every shipment. Only pure-numeric legacyImported rows are candidates; everything else is `notCandidate`
 * (the 958 L originals land here and are never touched).
 */
export function selectShipments({ shipments, shipDates, shipBefore }) {
  assertShipBefore(shipBefore);
  const sel = { delete: [], keep: [], noShipDate: [], ambiguous: [], notInExport: [], notCandidate: 0, candidates: 0 };
  for (const s of shipments) {
    if (!isPureNumeric(s.number) || s.legacyImported !== true) { sel.notCandidate += 1; continue; }
    sel.candidates += 1;
    const hit = shipDates.get(normalizePro(s.number));
    if (!hit) sel.notInExport.push(s);
    else if (hit.ambiguous) sel.ambiguous.push(s);
    else if (!hit.date) sel.noShipDate.push(s);
    else if (hit.date < shipBefore) sel.delete.push({ ...s, __shipDate: hit.date });
    else sel.keep.push(s);
  }
  return sel;
}

// ───────────────────────────── plan ─────────────────────────────

const parseApps = (v) => {
  if (v == null) return { list: [], wasString: false };
  if (typeof v === 'string') { try { const p = JSON.parse(v); return { list: Array.isArray(p) ? p : [], wasString: true }; } catch { return { list: [], wasString: true }; } }
  return { list: Array.isArray(v) ? v : [], wasString: false };
};
const sumApps = (list) => list.reduce((a, x) => a + num(x.amountCents), 0);

/**
 * Split one payment against the deleted document set.
 * @param {object} p payment row
 * @param {string} key 'invoiceId' | 'billId'
 * @param {Set<string>} gone deleted invoice/bill ids
 * @returns {{action: 'keep'|'delete'|'modify', removedCents: number, keptApps: number, after?: object, reason?: string}}
 */
export function splitPayment(p, key, gone) {
  const { list, wasString } = parseApps(p.applications);
  const old = list.filter((a) => gone.has(str(a[key])));
  const kept = list.filter((a) => !gone.has(str(a[key])));
  const nonDocLink = key === 'invoiceId' ? gone.has(str(p.invoiceId)) : false; // WRITE_OFF names its invoice
  if (old.length === 0 && !nonDocLink) return { action: 'keep', removedCents: 0, keptApps: kept.length };
  const removed = sumApps(old);
  const keptSum = sumApps(kept);
  const unapplied = num(p.unappliedCents);
  const credit = parseApps(p.creditApplications).list;
  if (num(p.appliedCents) !== sumApps(list)) return { action: 'keep', removedCents: 0, keptApps: kept.length, reason: 'APPLIED_MISMATCH' };
  if (kept.length === 0 && unapplied === 0 && credit.length === 0) return { action: 'delete', removedCents: removed, keptApps: 0 };
  const after = { ...p, applications: wasString ? JSON.stringify(kept) : kept, appliedCents: keptSum, amountCents: num(p.amountCents) - removed };
  if (nonDocLink) after.invoiceId = null;
  return { action: 'modify', removedCents: removed, keptApps: kept.length, after, reason: kept.length === 0 ? 'OLD_ONLY_WITH_CREDIT' : 'MIXED' };
}

const group = (rows, f) => {
  const m = new Map();
  for (const r of rows) { const k = f(r); if (k) (m.get(k) ?? m.set(k, []).get(k)).push(r); }
  return m;
};

/**
 * Pure plan. `data` = full table scans by model name (arrays of items).
 * @returns {{deletes: Record<string, object[]>, modifies: Record<string, Array<{before: object, after: object, reason: string, removedCents: number}>>,
 *   blockers: string[], notes: Record<string, number>}}
 */
export function planPreDelete(data, selection) {
  const S = new Set(selection.delete.map((s) => s.id));
  const pros = new Set(selection.delete.map((s) => normalizePro(s.number)));
  const orderIds = new Set(selection.delete.flatMap((s) => s.orderIds ?? []));
  const loadIds = new Set(selection.delete.flatMap((s) => s.loadIds ?? []));
  const get = (m) => data[m] ?? [];
  const blockers = [];

  const deletes = {};
  deletes.Shipment = selection.delete.map(({ __shipDate, ...rest }) => rest);
  deletes.Order = get('Order').filter((r) => S.has(r.shipmentId) || orderIds.has(r.id));
  deletes.Load = get('Load').filter((r) => S.has(r.shipmentId) || loadIds.has(r.id));
  const orderSet = new Set(deletes.Order.map((r) => r.id));
  const loadSet = new Set(deletes.Load.map((r) => r.id));
  deletes.LoadCarrier = get('LoadCarrier').filter((r) => S.has(r.shipmentId) || loadSet.has(r.loadId));
  const lcSet = new Set(deletes.LoadCarrier.map((r) => r.id));
  deletes.LoadFinancials = get('LoadFinancials').filter((r) => S.has(r.shipmentId) || loadSet.has(r.id) || loadSet.has(r.loadId));
  deletes.LoadCharge = get('LoadCharge').filter((r) => S.has(r.shipmentId) || orderSet.has(r.orderId) || loadSet.has(r.loadId) || lcSet.has(r.loadCarrierId));
  deletes.Invoice = get('Invoice').filter((r) => S.has(r.shipmentId) || orderSet.has(r.orderId));
  deletes.CarrierBill = get('CarrierBill').filter((r) => S.has(r.shipmentId) || loadSet.has(r.loadId) || lcSet.has(r.loadCarrierId));
  deletes.ProClaim = get('ProClaim').filter((r) => S.has(r.shipmentId) || loadSet.has(r.loadId) || pros.has(normalizePro(r.id)));
  deletes.LegacyAljexRow = get('LegacyAljexRow').filter((r) => S.has(r.shipmentId) || pros.has(normalizePro(r.pro)));

  // Cross-contamination: a deleted child must not also point at a retained parent.
  const shipmentIds = new Set(get('Shipment').map((r) => r.id));
  for (const [m, rows] of Object.entries(deletes)) {
    if (m === 'Shipment') continue;
    for (const r of rows) if (r.shipmentId && !S.has(r.shipmentId) && shipmentIds.has(r.shipmentId)) blockers.push(`${m} ${r.id} belongs to a retained shipment ${r.shipmentId}`);
  }
  for (const s of get('Shipment')) {
    if (S.has(s.id)) continue;
    if ((s.orderIds ?? []).some((i) => orderIds.has(i)) || (s.loadIds ?? []).some((i) => loadIds.has(i))) blockers.push(`retained shipment ${s.id} lists an order/load of a deleted shipment`);
  }
  // Factoring is never touched: an invoice in FactoringItem blocks.
  const invoiceIds = new Set(deletes.Invoice.map((r) => r.id));
  const billIds = new Set(deletes.CarrierBill.map((r) => r.id));
  for (const inv of deletes.Invoice) if (inv.factoringItemId) blockers.push(`Invoice ${inv.id} is factored (${inv.factoringItemId})`);
  for (const f of get('FactoringItem')) if (S.has(f.shipmentId) || loadSet.has(f.loadId) || invoiceIds.has(f.invoiceId) || orderSet.has(f.orderId)) blockers.push(`FactoringItem ${f.id} references a deleted shipment`);

  // Payments.
  const modifies = { ArPayment: [], ApPayment: [] };
  const notes = { arKept: 0, apKept: 0, arAppliedMismatch: 0, apAppliedMismatch: 0 };
  deletes.ArPayment = [];
  deletes.ApPayment = [];
  for (const [model, key, gone, noteKey] of [['ArPayment', 'invoiceId', invoiceIds, 'ar'], ['ApPayment', 'billId', billIds, 'ap']]) {
    for (const p of get(model)) {
      const r = splitPayment(p, key, gone);
      if (r.reason === 'APPLIED_MISMATCH') { notes[`${noteKey}AppliedMismatch`] += 1; blockers.push(`${model} ${p.id}: appliedCents does not equal the sum of its applications`); continue; }
      if (r.action === 'delete') deletes[model].push(p);
      else if (r.action === 'modify') modifies[model].push({ before: p, after: r.after, reason: r.reason, removedCents: r.removedCents });
      else notes[`${noteKey}Kept`] += 1;
    }
  }
  // Payment cross links (reversals, credit applications) between a deleted/modified-away payment and a retained one.
  for (const model of MODIFY_MODELS) {
    const gonePay = new Set(deletes[model].map((p) => p.id));
    for (const p of get(model)) {
      if (gonePay.has(p.id)) {
        for (const f of ['reversesPaymentId', 'reversedByPaymentId']) if (p[f] && !gonePay.has(p[f])) blockers.push(`${model} ${p.id} (deleted) is linked by ${f} to retained payment ${p[f]}`);
      } else {
        for (const f of ['reversesPaymentId', 'reversedByPaymentId']) if (p[f] && gonePay.has(p[f])) blockers.push(`${model} ${p.id} (retained) is linked by ${f} to deleted payment ${p[f]}`);
        for (const c of parseApps(p.creditApplications).list) if (gonePay.has(str(c.paymentId))) blockers.push(`${model} ${p.id} (retained) spends credit of deleted payment ${c.paymentId}`);
      }
    }
  }
  // A retained ApPayment credit aimed at a deleted leg keeps a dangling loadCarrierId: counted, left as is.
  notes.apCreditOnDeletedLeg = get('ApPayment').filter((p) => p.loadCarrierId && lcSet.has(p.loadCarrierId)).length;
  return { deletes, modifies, blockers, notes };
}

// ───────────────────────────── money + conservation ─────────────────────────────

const OPEN_BILL = (b) => b.status !== 'PAID' && b.status !== 'VOID';
const liveInvoice = (i) => i.status !== 'VOID';

const sumBy = (rows, f) => rows.reduce((a, r) => a + f(r), 0);
export const dollars = (cents) => `${cents < 0 ? '-' : ''}$${Math.trunc(Math.abs(cents) / 100).toLocaleString('en-US')}.${String(Math.abs(cents) % 100).padStart(2, '0')}`;

/** Totals of the rows removed (counts + cents). */
export function removedTotals(plan) {
  const inv = plan.deletes.Invoice;
  const bills = plan.deletes.CarrierBill;
  const byStatus = {};
  for (const b of bills) byStatus[b.status] = (byStatus[b.status] ?? 0) + 1;
  return {
    invoices: { count: inv.length, totalCents: sumBy(inv, (i) => num(i.totalCents)), paidCents: sumBy(inv, (i) => num(i.paidCents)), openCents: sumBy(inv.filter(liveInvoice), (i) => num(i.balanceCents)) },
    bills: { count: bills.length, byStatus, billedCents: sumBy(bills, (b) => num(b.billedCents)), paidCents: sumBy(bills, (b) => num(b.paidCents)), openCents: sumBy(bills.filter(OPEN_BILL), (b) => num(b.balanceCents)), openCount: bills.filter(OPEN_BILL).length },
    arPayments: { deleted: plan.deletes.ArPayment.length, deletedCents: sumBy(plan.deletes.ArPayment, (p) => num(p.amountCents)), modified: plan.modifies.ArPayment.length, modifiedRemovedCents: sumBy(plan.modifies.ArPayment, (m) => m.removedCents) },
    apPayments: { deleted: plan.deletes.ApPayment.length, deletedCents: sumBy(plan.deletes.ApPayment, (p) => num(p.amountCents)), modified: plan.modifies.ApPayment.length, modifiedRemovedCents: sumBy(plan.modifies.ApPayment, (m) => m.removedCents) },
  };
}

/** One side of the proof. `invoices/bills/arPayments/apPayments` are the rows present on that side. */
export function ledgerSnapshot({ invoices, bills, arPayments, apPayments }) {
  const invIds = new Set(invoices.map((i) => i.id));
  const billIds = new Set(bills.map((b) => b.id));
  const appsTo = (payments, key, ids) => sumBy(payments, (p) => sumBy(parseApps(p.applications).list.filter((a) => ids.has(str(a[key]))), (a) => num(a.amountCents)));
  const broken = (payments) => payments.filter((p) => num(p.appliedCents) + num(p.unappliedCents) !== num(p.amountCents)).length;
  return {
    invoices: invoices.length,
    openArCents: sumBy(invoices.filter(liveInvoice), (i) => num(i.balanceCents)),
    paidArCents: sumBy(invoices, (i) => num(i.paidCents)),
    bills: bills.length,
    openApCents: sumBy(bills.filter(OPEN_BILL), (b) => num(b.balanceCents)),
    paidApCents: sumBy(bills, (b) => num(b.paidCents)),
    arPayments: arPayments.length,
    apPayments: apPayments.length,
    arUnappliedCents: sumBy(arPayments, (p) => num(p.unappliedCents)),
    apUnappliedCents: sumBy(apPayments, (p) => num(p.unappliedCents)),
    arAppliedToRetainedInvoicesCents: appsTo(arPayments, 'invoiceId', invIds),
    apAppliedToRetainedBillsCents: appsTo(apPayments, 'billId', billIds),
    arPaymentsOutOfBalance: broken(arPayments),
    apPaymentsOutOfBalance: broken(apPayments),
  };
}

/**
 * BEFORE (retained rows as they are today) vs AFTER (the same rows with the planned payment edits). Retained rows are
 * those not in the delete set; `ok` is true only when every invariant holds.
 */
export function conservationProof(data, plan) {
  const del = (m) => new Set(plan.deletes[m].map((r) => r.id));
  const keepRows = (m) => (data[m] ?? []).filter((r) => !del(m).has(r.id));
  const retained = { invoices: keepRows('Invoice'), bills: keepRows('CarrierBill') };
  const before = ledgerSnapshot({ ...retained, arPayments: keepRows('ArPayment'), apPayments: keepRows('ApPayment') });
  const afterRows = (m) => {
    const mod = new Map(plan.modifies[m].map((x) => [x.before.id, x.after]));
    return keepRows(m).map((p) => mod.get(p.id) ?? p);
  };
  const after = ledgerSnapshot({ ...retained, arPayments: afterRows('ArPayment'), apPayments: afterRows('ApPayment') });
  const checks = {
    openArUnchanged: before.openArCents === after.openArCents,
    paidArUnchanged: before.paidArCents === after.paidArCents,
    openApUnchanged: before.openApCents === after.openApCents,
    arAppliedToRetainedUnchanged: before.arAppliedToRetainedInvoicesCents === after.arAppliedToRetainedInvoicesCents,
    apAppliedToRetainedUnchanged: before.apAppliedToRetainedBillsCents === after.apAppliedToRetainedBillsCents,
    unappliedUnchanged: before.arUnappliedCents === after.arUnappliedCents && before.apUnappliedCents === after.apUnappliedCents,
    everyRetainedPaymentBalances: after.arPaymentsOutOfBalance === 0 && after.apPaymentsOutOfBalance === 0,
    noRetainedRowChangedExceptPayments: true,
  };
  return { before, after, checks, ok: Object.values(checks).every(Boolean) };
}

/**
 * Open AP the removal takes away = removed open bills. The "after" retained open AP in the proof is measured over RETAINED
 * bills only, so compare against the full-table figure here: all-bills open AP - removed open AP.
 */
export function wholeTableDrop(data, plan) {
  const all = (data.CarrierBill ?? []).filter(OPEN_BILL).reduce((a, b) => a + num(b.balanceCents), 0);
  const kept = (data.CarrierBill ?? []).filter((b) => !plan.deletes.CarrierBill.some((d) => d.id === b.id)).filter(OPEN_BILL).reduce((a, b) => a + num(b.balanceCents), 0);
  return { openApBeforeCents: all, openApAfterCents: kept, dropCents: all - kept };
}

/** Compare the removal against Ryne's expectations; each line is a printed deviation. */
export function deviations({ selection, removed, proof }) {
  const out = [];
  const eq = (label, got, want) => { if (got !== want) out.push(`${label}: got ${got}, expected ${want}`); };
  eq('shipments deleted', selection.delete.length, EXPECTED.shipments);
  eq('shipments with no ship date (kept)', selection.noShipDate.length, EXPECTED.noShipDate);
  eq('invoices deleted', removed.invoices.count, EXPECTED.invoices);
  eq('invoices open cents', removed.invoices.openCents, EXPECTED.invoicesOpenCents);
  eq('bills deleted', removed.bills.count, EXPECTED.bills);
  for (const k of new Set([...Object.keys(EXPECTED.billsByStatus), ...Object.keys(removed.bills.byStatus)])) eq(`bills ${k}`, removed.bills.byStatus[k] ?? 0, EXPECTED.billsByStatus[k] ?? 0);
  eq('bills open cents', removed.bills.openCents, EXPECTED.billsOpenCents);
  eq('retained open AR cents (before)', proof.before.openArCents, EXPECTED_RETAINED_OPEN_AR_CENTS);
  eq('retained open AR cents (after)', proof.after.openArCents, EXPECTED_RETAINED_OPEN_AR_CENTS);
  return out;
}

// ───────────────────────────── export / restore ─────────────────────────────

/** JSON with DynamoDB string/number Sets preserved ({"__set": [...]}) so an export round-trips. */
export const toJsonLine = (item) => JSON.stringify(item, (_k, v) => (v instanceof Set ? { __set: [...v] } : v));
export const fromJsonLine = (line) => JSON.parse(line, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) && Array.isArray(v.__set) && Object.keys(v).length === 1 ? new Set(v.__set) : v));
export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** Files an export holds: per model `<Model>.delete.jsonl`, and for payments `<Model>.modify.jsonl` ({before, after, reason}). */
export function exportFiles(plan) {
  const files = {};
  for (const m of DELETE_ORDER) if (plan.deletes[m]?.length) files[`${m}.delete.jsonl`] = { model: m, kind: 'delete', ids: plan.deletes[m].map((r) => r.id), text: `${plan.deletes[m].map(toJsonLine).join('\n')}\n` };
  for (const m of MODIFY_MODELS) if (plan.modifies[m].length) files[`${m}.modify.jsonl`] = { model: m, kind: 'modify', ids: plan.modifies[m].map((x) => x.before.id), text: `${plan.modifies[m].map((x) => toJsonLine({ before: x.before, after: x.after, reason: x.reason })).join('\n')}\n` };
  return files;
}

/** The manifest written next to the files. `files[name] = {model, kind, count, sha256}` */
export function buildManifest({ files, suffix, shipBefore, now = new Date() }) {
  return {
    script: 'awPreDelete', createdAt: now.toISOString(), suffix, shipBefore,
    files: Object.fromEntries(Object.entries(files).map(([name, f]) => [name, { model: f.model, kind: f.kind, count: f.ids.length, sha256: sha256(f.text) }])),
  };
}

/**
 * Re-read every file named by the manifest through `readText(name)` and check count + sha256 (+ that every line parses and
 * carries an id). Throws on the first mismatch; returns the row sets by file.
 */
export function verifyExport(manifest, readText) {
  const out = {};
  for (const [name, meta] of Object.entries(manifest.files)) {
    const text = readText(name);
    if (typeof text !== 'string') throw new Error(`export file missing: ${name}`);
    if (sha256(text) !== meta.sha256) throw new Error(`export file ${name}: sha256 mismatch`);
    const lines = text.split('\n').filter(Boolean);
    if (lines.length !== meta.count) throw new Error(`export file ${name}: ${lines.length} rows, manifest says ${meta.count}`);
    out[name] = lines.map(fromJsonLine);
    for (const r of out[name]) if (!(meta.kind === 'modify' ? r.before?.id : r.id)) throw new Error(`export file ${name}: a row has no id`);
  }
  return out;
}

/** Every planned row id must already be in the (verified) export; returns the ids that are not. */
export function missingFromExport(plan, rowsByFile) {
  const have = (name) => new Set((rowsByFile[name] ?? []).map((r) => (r.before ? r.before.id : r.id)));
  const missing = [];
  for (const m of DELETE_ORDER) { const h = have(`${m}.delete.jsonl`); for (const r of plan.deletes[m] ?? []) if (!h.has(r.id)) missing.push(`${m}:${r.id}`); }
  for (const m of MODIFY_MODELS) { const h = have(`${m}.modify.jsonl`); for (const x of plan.modifies[m]) if (!h.has(x.before.id)) missing.push(`${m}:${x.before.id}`); }
  return missing;
}

/** Restore order: parents first (reverse of delete). */
export const RESTORE_ORDER = [...DELETE_ORDER].reverse();

/** One AuditLog item per deleted shipment (no PII; counts of children). Deterministic id => a re-run cannot double up. */
export function auditItems(plan, now = new Date()) {
  const iso = now.toISOString();
  const byShip = (m) => group(plan.deletes[m] ?? [], (r) => r.shipmentId);
  const tables = Object.fromEntries(['Order', 'Load', 'LoadCarrier', 'LoadFinancials', 'LoadCharge', 'Invoice', 'CarrierBill', 'ProClaim', 'LegacyAljexRow'].map((m) => [m, byShip(m)]));
  return plan.deletes.Shipment.map((s) => ({
    id: `aw-predelete:${s.id}`,
    __typename: 'AuditLog',
    entityType: 'SHIPMENT',
    entityId: s.id,
    action: AUDIT_ACTION,
    user: AUDIT_USER,
    changes: JSON.stringify({ pro: s.number, deleted: Object.fromEntries(Object.entries(tables).map(([m, g]) => [m, g.get(s.id)?.length ?? 0])) }),
    createdAt: iso,
    updatedAt: iso,
  }));
}
