/**
 * Pure parts of scripts/awDeletePayables.mjs (no AWS, no files except the explicit export helpers that take an `fs`
 * argument): which CarrierBill rows are deleted (OPEN payables dated 2025), how the ApPayment rows that paid them are split,
 * how the LoadCarrier legs are released, the before/after conservation proof and the export manifest.
 *
 * Selection (Ryne, 2026-11-09): CarrierBill with billDate in 2025 and balanceCents > 0 that is not PAID/VOID. Paid bills,
 * bills of any other year, AR/invoices, loads and shipments are never selected or touched (assertHardGuarantees).
 *
 * Payments reuse the awPreDelete rule (splitPayment, key 'billId'): a payment that also pays a retained bill is KEPT with
 * only the deleted bills' application lines removed (amount and applied shrink by exactly those dollars, unapplied is
 * untouched); a payment applied ONLY to deleted bills is DELETED, unless it carries unapplied credit / credit applications,
 * in which case it is kept with amount = unapplied credit.
 *
 * LoadCarrier: exactly the app's own VOID_BILL (amplify/functions/tms-finance-actions/bills.ts voidBill): apStatus ->
 * AWAITING_INVOICE, apStatusChangedAt/updatedAt/updatedBy set, invoiceId and apBalanceCents cleared, chargesFinalizedAt REMOVEd.
 * apOpen and apPaidAt are left as they are, as VOID_BILL leaves them.
 */
import { splitPayment, toJsonLine, sha256, dollars } from './preDelete.mjs';

export { dollars, toJsonLine };

export const SCRIPT = 'awDeletePayables';
export const YEAR = '2025';
export const AUDIT_ACTION = 'AW_DELETE_PAYABLE';
export const AUDIT_USER = 'aw-delete-payables';
export const CONFIRM_SUFFIX = 'delpayables';
export const EXPORT_DIR_NAME = 'pre-delete-payables-2025';

/** Ryne's decision (23 open 2025 payables, $14,730.21) and the whole-table open AP before/after. Deviations are REPORTED; they only block --apply. */
export const EXPECTED = {
  bills: 23,
  byStatus: { TO_BE_PAID: 11, PARTIAL: 12 },
  openCentsByStatus: { TO_BE_PAID: 663771, PARTIAL: 809250 },
  openCents: 1473021,
  openApBeforeCents: 14072651,
  openApAfterCents: 12599630,
  paidBills2025: 1360,
};

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const sumBy = (rows, f) => rows.reduce((a, r) => a + f(r), 0);
const OPEN_BILL = (b) => b.status !== 'PAID' && b.status !== 'VOID';
export const isIn2025 = (b) => typeof b.billDate === 'string' && b.billDate.startsWith(`${YEAR}-`);
export const isSelectable = (b) => isIn2025(b) && OPEN_BILL(b) && num(b.balanceCents) > 0;

// ───────────────────────────── selection ─────────────────────────────

/** @returns {{delete: object[], paid2025: number, other2025: object[], total2025: number}} */
export function selectBills(bills) {
  const sel = { delete: [], paid2025: 0, other2025: [], total2025: 0 };
  for (const b of bills) {
    if (!isIn2025(b)) continue;
    sel.total2025 += 1;
    if (isSelectable(b)) sel.delete.push(b);
    else if (b.status === 'PAID') sel.paid2025 += 1;
    else sel.other2025.push(b);
  }
  return sel;
}

/** Hard guarantees: never a PAID/VOID bill, never a bill dated outside 2025, never a bill without a positive balance. */
export function assertHardGuarantees(selection) {
  const bad = selection.delete.filter((b) => !isSelectable(b));
  if (bad.length) throw new Error(`HARD GUARANTEE VIOLATED: ${bad.length} selected bill(s) are paid/void, not dated ${YEAR}, or have no open balance (first: ${bad[0].id})`);
}

// ───────────────────────────── LoadCarrier release ─────────────────────────────

/** Fields a leg release writes or removes; the conditional patch pins every one of them to the value the plan read. */
export const LEG_FIELDS = ['apStatus', 'apStatusChangedAt', 'invoiceId', 'apOpen', 'apBalanceCents', 'chargesFinalizedAt', 'apPaidAt', 'updatedAt', 'updatedBy'];
const LEG_REMOVED = ['invoiceId', 'apBalanceCents', 'chargesFinalizedAt'];

/** The leg as it looks with no bill (the app's VOID_BILL shape). */
export function releasedLeg(leg, now) {
  const iso = now.toISOString();
  const after = { ...leg, apStatus: 'AWAITING_INVOICE', apStatusChangedAt: iso, updatedAt: iso, updatedBy: AUDIT_USER };
  for (const f of LEG_REMOVED) delete after[f];
  return after;
}

/**
 * Conditional field patch turning `from` into `to` over `fields`: SET where `to` has the field, REMOVE where it does not,
 * and every field's `from` value (or its absence) is a condition, so a row that moved since the plan is never touched.
 * @returns {{UpdateExpression: string, ConditionExpression: string, ExpressionAttributeNames: object, ExpressionAttributeValues: object}|null}
 */
export function fieldPatch(from, to, fields = LEG_FIELDS) {
  const names = {};
  const values = {};
  const sets = [];
  const removes = [];
  const conds = ['attribute_exists(id)'];
  fields.forEach((f, i) => {
    names[`#f${i}`] = f;
    if (to[f] === undefined) { if (from[f] !== undefined) removes.push(`#f${i}`); }
    else if (to[f] !== from[f]) { values[`:t${i}`] = to[f]; sets.push(`#f${i} = :t${i}`); }
    if (from[f] === undefined) conds.push(`attribute_not_exists(#f${i})`);
    else { values[`:c${i}`] = from[f]; conds.push(`#f${i} = :c${i}`); }
  });
  if (!sets.length && !removes.length) return null;
  return {
    UpdateExpression: [sets.length ? `SET ${sets.join(', ')}` : '', removes.length ? `REMOVE ${removes.join(', ')}` : ''].filter(Boolean).join(' '),
    ConditionExpression: conds.join(' AND '),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
}

// ───────────────────────────── plan ─────────────────────────────

const parseApps = (v) => {
  if (v == null) return [];
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
  return Array.isArray(v) ? v : [];
};
const str = (v) => (v == null ? '' : String(v));

/**
 * Pure plan. `data` = full scans `{CarrierBill, ApPayment, LoadCarrier}`.
 * @returns {{deletes: {CarrierBill: object[], ApPayment: object[]}, modifies: {ApPayment: Array<{before, after, reason, removedCents}>, LoadCarrier: Array<{before, after, reason, billId}>},
 *   blockers: string[], notes: Record<string, number>, selection: object}}
 */
export function planDeletePayables(data, { now = new Date() } = {}) {
  const selection = selectBills(data.CarrierBill ?? []);
  assertHardGuarantees(selection);
  const bills = selection.delete;
  const billIds = new Set(bills.map((b) => b.id));
  const blockers = [];
  const notes = { apKept: 0, apAppliedMismatch: 0, legMissing: 0, legPointsElsewhere: 0, legReleased: 0, creditedBills: bills.filter((b) => num(b.creditedCents) > 0).length };

  const deletes = { CarrierBill: bills, ApPayment: [] };
  const modifies = { ApPayment: [], LoadCarrier: [] };
  for (const p of data.ApPayment ?? []) {
    const r = splitPayment(p, 'billId', billIds);
    if (r.reason === 'APPLIED_MISMATCH') { notes.apAppliedMismatch += 1; blockers.push(`ApPayment ${p.id}: appliedCents does not equal the sum of its applications`); continue; }
    if (r.action === 'delete') deletes.ApPayment.push(p);
    else if (r.action === 'modify') modifies.ApPayment.push({ before: p, after: r.after, reason: r.reason, removedCents: r.removedCents });
    else notes.apKept += 1;
  }
  // Reversal / credit links between a deleted payment and a retained one block (same as awPreDelete).
  const gonePay = new Set(deletes.ApPayment.map((p) => p.id));
  for (const p of data.ApPayment ?? []) {
    if (gonePay.has(p.id)) {
      for (const f of ['reversesPaymentId', 'reversedByPaymentId']) if (p[f] && !gonePay.has(p[f])) blockers.push(`ApPayment ${p.id} (deleted) is linked by ${f} to retained payment ${p[f]}`);
    } else {
      for (const f of ['reversesPaymentId', 'reversedByPaymentId']) if (p[f] && gonePay.has(p[f])) blockers.push(`ApPayment ${p.id} (retained) is linked by ${f} to deleted payment ${p[f]}`);
      for (const c of parseApps(p.creditApplications)) if (gonePay.has(str(c.paymentId))) blockers.push(`ApPayment ${p.id} (retained) spends credit of deleted payment ${c.paymentId}`);
    }
  }
  // A retained payment (e.g. a credit) aimed at a deleted bill's leg keeps its loadCarrierId: counted, left as is.
  notes.apCreditOnReleasedLeg = 0;

  // Legs: released only while they still belong to the deleted bill (invoiceId is the bill id) or never recorded a bill id.
  const legs = new Map((data.LoadCarrier ?? []).map((l) => [l.id, l]));
  const done = new Set();
  for (const b of bills) {
    const leg = legs.get(b.loadCarrierId);
    if (!leg) { notes.legMissing += 1; continue; }
    if (done.has(leg.id)) continue;
    if (leg.invoiceId != null && leg.invoiceId !== b.id) { notes.legPointsElsewhere += 1; continue; }
    done.add(leg.id);
    const after = releasedLeg(leg, now);
    modifies.LoadCarrier.push({ before: leg, after, reason: leg.invoiceId == null ? 'RELEASED_NO_INVOICE_ID' : 'RELEASED', billId: b.id });
    notes.legReleased += 1;
  }
  const lcRelease = new Set(modifies.LoadCarrier.map((x) => x.before.id));
  notes.apCreditOnReleasedLeg = (data.ApPayment ?? []).filter((p) => p.loadCarrierId && lcRelease.has(p.loadCarrierId) && !gonePay.has(p.id)).length;
  // Any other row that is not a deleted bill but points at a released leg as its invoice is a conflict.
  for (const b of data.CarrierBill ?? []) if (!billIds.has(b.id) && lcRelease.has(b.loadCarrierId) && b.status !== 'VOID') blockers.push(`retained bill ${b.id} sits on a leg (${b.loadCarrierId}) the plan releases`);
  return { deletes, modifies, blockers, notes, selection };
}

// ───────────────────────────── money + conservation ─────────────────────────────

const histogram = (rows, f) => { const o = {}; for (const r of rows) { const k = String(f(r)); o[k] = (o[k] ?? 0) + 1; } return o; };

/** Totals of the rows removed. */
export function removedTotals(plan) {
  const bills = plan.deletes.CarrierBill;
  const openByStatus = {};
  for (const b of bills) openByStatus[b.status] = (openByStatus[b.status] ?? 0) + num(b.balanceCents);
  return {
    bills: { count: bills.length, byStatus: histogram(bills, (b) => b.status), openCentsByStatus: openByStatus, billedCents: sumBy(bills, (b) => num(b.billedCents)), paidCents: sumBy(bills, (b) => num(b.paidCents)), creditedCents: sumBy(bills, (b) => num(b.creditedCents)), openCents: sumBy(bills, (b) => num(b.balanceCents)) },
    apPayments: {
      deleted: plan.deletes.ApPayment.length, deletedCents: sumBy(plan.deletes.ApPayment, (p) => num(p.amountCents)),
      modified: plan.modifies.ApPayment.length, modifiedRemovedCents: sumBy(plan.modifies.ApPayment, (m) => m.removedCents),
    },
    legs: { released: plan.modifies.LoadCarrier.length },
  };
}

const byCarrier = (bills) => {
  const m = {};
  for (const b of bills) {
    const k = b.carrierId ?? 'NONE';
    const e = m[k] ?? (m[k] = { bills: 0, openCents: 0, paidCents: 0, billedCents: 0 });
    e.bills += 1; e.billedCents += num(b.billedCents); e.paidCents += num(b.paidCents);
    if (OPEN_BILL(b)) e.openCents += num(b.balanceCents);
  }
  return m;
};

/** Per retained bill: dollars the (given) payments apply to it. */
const appliedPerBill = (payments, billIds) => {
  const m = new Map();
  for (const p of payments) for (const a of parseApps(p.applications)) { const id = str(a.billId); if (billIds.has(id)) m.set(id, (m.get(id) ?? 0) + num(a.amountCents)); }
  return m;
};

function snapshot(bills, payments) {
  return {
    bills: bills.length,
    openApCents: sumBy(bills.filter(OPEN_BILL), (b) => num(b.balanceCents)),
    paidApCents: sumBy(bills, (b) => num(b.paidCents)),
    paidBills: bills.filter((b) => b.status === 'PAID').length,
    apPayments: payments.length,
    apUnappliedCents: sumBy(payments, (p) => num(p.unappliedCents)),
    apPaymentsOutOfBalance: payments.filter((p) => num(p.appliedCents) + num(p.unappliedCents) !== num(p.amountCents)).length,
  };
}

/**
 * BEFORE = the whole table as it is today; AFTER = the same table with the bills deleted and the planned payment edits.
 * `ok` is true only when every invariant holds.
 */
export function conservationProof(data, plan) {
  const goneBills = new Set(plan.deletes.CarrierBill.map((b) => b.id));
  const gonePay = new Set(plan.deletes.ApPayment.map((p) => p.id));
  const modPay = new Map(plan.modifies.ApPayment.map((x) => [x.before.id, x.after]));
  const bills = data.CarrierBill ?? [];
  const payments = data.ApPayment ?? [];
  const keptBills = bills.filter((b) => !goneBills.has(b.id));
  const afterPayments = payments.filter((p) => !gonePay.has(p.id)).map((p) => modPay.get(p.id) ?? p);
  const keptIds = new Set(keptBills.map((b) => b.id));
  const before = snapshot(bills, payments);
  const after = snapshot(keptBills, afterPayments);
  const removed = removedTotals(plan);
  const appliedBefore = appliedPerBill(payments, keptIds);
  const appliedAfter = appliedPerBill(afterPayments, keptIds);
  const retainedBillAppliedUnchanged = [...keptIds].every((id) => (appliedBefore.get(id) ?? 0) === (appliedAfter.get(id) ?? 0));
  const carriersBefore = byCarrier(bills);
  const carriersAfter = byCarrier(keptBills);
  const carriersRemoved = byCarrier(plan.deletes.CarrierBill);
  const carrierTotalsConserve = Object.keys({ ...carriersBefore, ...carriersAfter }).every((k) => {
    const b = carriersBefore[k] ?? { bills: 0, openCents: 0, paidCents: 0, billedCents: 0 };
    const a = carriersAfter[k] ?? { bills: 0, openCents: 0, paidCents: 0, billedCents: 0 };
    const r = carriersRemoved[k] ?? { bills: 0, openCents: 0, paidCents: 0, billedCents: 0 };
    return ['bills', 'openCents', 'paidCents', 'billedCents'].every((f) => b[f] - r[f] === a[f]);
  });
  const retainedPaidBefore = sumBy(bills.filter((b) => b.status === 'PAID' && keptIds.has(b.id)), (b) => num(b.paidCents));
  const retainedPaidAfter = sumBy(keptBills.filter((b) => b.status === 'PAID'), (b) => num(b.paidCents));
  const deletedPaymentUnapplied = sumBy(plan.deletes.ApPayment, (p) => num(p.unappliedCents));
  const checks = {
    openApDropEqualsRemovedOpen: before.openApCents - after.openApCents === removed.bills.openCents,
    retainedPaidApUnchanged: retainedPaidBefore === retainedPaidAfter && before.paidBills === after.paidBills + plan.deletes.CarrierBill.filter((b) => b.status === 'PAID').length,
    retainedBillPaymentsUnchanged: retainedBillAppliedUnchanged,
    carrierTotalsConserve,
    unappliedConserved: before.apUnappliedCents - deletedPaymentUnapplied === after.apUnappliedCents,
    noUnappliedCreditDeleted: deletedPaymentUnapplied === 0,
    everyRetainedPaymentBalances: after.apPaymentsOutOfBalance === 0,
    noPaidBillDeleted: plan.deletes.CarrierBill.every((b) => b.status !== 'PAID'),
  };
  return { before, after, removed, checks, ok: Object.values(checks).every(Boolean), carriers: { before: carriersBefore, after: carriersAfter, removed: carriersRemoved } };
}

/** Compare the removal against Ryne's decision; each line is a printed deviation. */
export function deviations({ selection, removed, proof }) {
  const out = [];
  const eq = (label, got, want) => { if (got !== want) out.push(`${label}: got ${got}, expected ${want}`); };
  eq('bills deleted', removed.bills.count, EXPECTED.bills);
  for (const k of new Set([...Object.keys(EXPECTED.byStatus), ...Object.keys(removed.bills.byStatus)])) {
    eq(`bills ${k}`, removed.bills.byStatus[k] ?? 0, EXPECTED.byStatus[k] ?? 0);
    eq(`open cents ${k}`, removed.bills.openCentsByStatus[k] ?? 0, EXPECTED.openCentsByStatus[k] ?? 0);
  }
  eq('open cents deleted', removed.bills.openCents, EXPECTED.openCents);
  eq('whole-table open AP before (cents)', proof.before.openApCents, EXPECTED.openApBeforeCents);
  eq('whole-table open AP after (cents)', proof.after.openApCents, EXPECTED.openApAfterCents);
  eq('PAID bills dated 2025 (kept)', selection.paid2025, EXPECTED.paidBills2025);
  return out;
}

// ───────────────────────────── export / restore ─────────────────────────────

/** Files an export holds. Deletes: `<Model>.delete.jsonl` (rows). Edits: `<Model>.modify.jsonl` ({before, after, reason}). */
export function exportFiles(plan) {
  const files = {};
  for (const m of ['CarrierBill', 'ApPayment']) if (plan.deletes[m].length) files[`${m}.delete.jsonl`] = { model: m, kind: 'delete', ids: plan.deletes[m].map((r) => r.id), text: `${plan.deletes[m].map(toJsonLine).join('\n')}\n` };
  for (const m of ['ApPayment', 'LoadCarrier']) if (plan.modifies[m].length) files[`${m}.modify.jsonl`] = { model: m, kind: 'modify', ids: plan.modifies[m].map((x) => x.before.id), text: `${plan.modifies[m].map((x) => toJsonLine({ before: x.before, after: x.after, reason: x.reason })).join('\n')}\n` };
  return files;
}

export function buildManifest({ files, suffix, now = new Date() }) {
  return {
    script: SCRIPT, createdAt: now.toISOString(), suffix, year: YEAR,
    files: Object.fromEntries(Object.entries(files).map(([name, f]) => [name, { model: f.model, kind: f.kind, count: f.ids.length, sha256: sha256(f.text) }])),
  };
}

/** Every planned row id must already be in the (verified) export; returns the ids that are not. */
export function missingFromExport(plan, rowsByFile) {
  const have = (name) => new Set((rowsByFile[name] ?? []).map((r) => (r.before ? r.before.id : r.id)));
  const missing = [];
  for (const m of ['CarrierBill', 'ApPayment']) { const h = have(`${m}.delete.jsonl`); for (const r of plan.deletes[m]) if (!h.has(r.id)) missing.push(`${m}:${r.id}`); }
  for (const m of ['ApPayment', 'LoadCarrier']) { const h = have(`${m}.modify.jsonl`); for (const x of plan.modifies[m]) if (!h.has(x.before.id)) missing.push(`${m}:${x.before.id}`); }
  return missing;
}

/** One AuditLog item per deleted bill (no PII). Deterministic id => a re-run cannot double up. */
export function auditItems(plan, now = new Date()) {
  const iso = now.toISOString();
  const legByBill = new Map(plan.modifies.LoadCarrier.map((x) => [x.billId, x.before.id]));
  const payLines = (b) => {
    const touch = (list) => list.filter((p) => parseApps(p.applications).some((a) => str(a.billId) === b.id)).map((p) => p.id);
    return { deletedPayments: touch(plan.deletes.ApPayment), editedPayments: touch(plan.modifies.ApPayment.map((x) => x.before)) };
  };
  return plan.deletes.CarrierBill.map((b) => ({
    id: `aw-delpayables:${b.id}`,
    __typename: 'AuditLog',
    entityType: 'CarrierBill',
    entityId: b.id,
    action: AUDIT_ACTION,
    user: AUDIT_USER,
    changes: JSON.stringify({
      billNumber: b.billNumber ?? null, billDate: b.billDate ?? null, status: b.status, carrierId: b.carrierId ?? null, shipmentId: b.shipmentId ?? null,
      billedCents: num(b.billedCents), paidCents: num(b.paidCents), balanceCents: num(b.balanceCents),
      releasedLeg: legByBill.get(b.id) ?? null, ...payLines(b),
    }),
    createdAt: iso,
    updatedAt: iso,
  }));
}
