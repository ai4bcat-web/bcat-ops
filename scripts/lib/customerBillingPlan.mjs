/**
 * Pure planning for scripts/awCustomerBilling.mjs (Ryne 2026-11-09). Per live production Customer:
 *
 *  1. E-Billing Email from the Aljex customers export (matched by NAME, normalized, since this export has no Account #):
 *       - ivanfactoring@ / invoicefactoring@bcatcorp.com  -> billingMethod FACTOR, NO e-mail stored.
 *       - a real external address                         -> apEmail = that address (overwrites a different one), and
 *                                                            billingMethod MANUAL only while the method is still unset.
 *       - invoices@ / any other internal @bcatcorp.com    -> nothing written (our own mailbox, not the customer's); listed.
 *       - blank                                           -> nothing written.
 *     A name whose export rows disagree (factor vs real address) is a conflict: nothing written, listed.
 *  2. Payment terms (EVERY live customer, file or not): paymentTermsDays 30 while empty; DANISCO customers 120 (set or corrected).
 *     Explicit terms already on a customer (15, 60...) are never touched.
 *
 * Writes are only Customer.billingMethod, Customer.apEmail, Customer.paymentTermsDays.
 */

export const FACTOR_ADDRESSES = new Set(['ivanfactoring@bcatcorp.com', 'invoicefactoring@bcatcorp.com']);
export const INTERNAL_DOMAIN = '@bcatcorp.com';
export const DEFAULT_TERMS_DAYS = 30;
export const DANISCO_TERMS_DAYS = 120;
export const WRITABLE_FIELDS = ['billingMethod', 'apEmail', 'paymentTermsDays'];

export const normName = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const blank = (v) => v == null || (typeof v === 'string' && v.trim() === '');
const EMAIL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

export function parseAddresses(text) {
  const valid = [];
  const bad = [];
  const seen = new Set();
  for (const part of String(text ?? '').split(/[\s,;]+/)) {
    const e = part.trim().toLowerCase().replace(/^[<"'(]+|[>"'),.]+$/g, '');
    if (!e || seen.has(e)) continue;
    seen.add(e);
    (EMAIL_RE.test(e) ? valid : bad).push(e);
  }
  return { valid, bad };
}

/** name -> { factor:Set, real:Set, internal:Set, blank:boolean } from the export rows. */
export function indexExport(rows) {
  const by = new Map();
  for (const r of rows) {
    const key = normName(r.name);
    if (!key) continue;
    const e = by.get(key) ?? { factor: new Set(), real: new Set(), internal: new Set(), blank: false, bad: [] };
    const { valid, bad } = parseAddresses(r.eBilling);
    if (!valid.length && !bad.length) e.blank = true;
    for (const a of valid) {
      if (FACTOR_ADDRESSES.has(a)) e.factor.add(a);
      else if (a.endsWith(INTERNAL_DOMAIN)) e.internal.add(a);
      else e.real.add(a);
    }
    e.bad.push(...bad);
    by.set(key, e);
  }
  return by;
}

const isLive = (c) => c.active !== false && !c.mergedIntoId;

/** One customer's planned writes: [{field, from, to, reason}] plus notes. */
export function planCustomer(customer, entry) {
  const writes = [];
  const notes = [];
  const method = blank(customer.billingMethod) ? null : String(customer.billingMethod);
  if (entry) {
    const hasFactor = entry.factor.size > 0;
    const hasReal = entry.real.size > 0;
    if (hasFactor && hasReal) notes.push('CONFLICT_FACTOR_AND_REAL_ADDRESS');
    else if (hasFactor) {
      if (method !== 'FACTOR') writes.push({ field: 'billingMethod', from: method, to: 'FACTOR', reason: method ? 'FACTOR_OVERRIDES_' + method : 'FACTOR_FROM_EBILLING' });
    } else if (hasReal) {
      const first = [...entry.real][0];
      const cur = blank(customer.apEmail) ? null : String(customer.apEmail).trim().toLowerCase();
      if (cur !== first) writes.push({ field: 'apEmail', from: customer.apEmail ?? null, to: first, reason: cur ? 'AP_EMAIL_CORRECTED' : 'AP_EMAIL_SET' });
      if (entry.real.size > 1) notes.push('MORE_THAN_ONE_REAL_ADDRESS');
      if (method === null) writes.push({ field: 'billingMethod', from: null, to: 'MANUAL', reason: 'MANUAL_FROM_REAL_EMAIL' });
      else if (method === 'FACTOR') notes.push('REAL_EMAIL_BUT_CUSTOMER_IS_FACTOR');
    } else if (entry.internal.size > 0) notes.push('INTERNAL_ADDRESS_ONLY:' + [...entry.internal].join('|'));
    if (entry.bad.length) notes.push('MALFORMED:' + entry.bad.join('|'));
  }
  const terms = customer.paymentTermsDays == null || customer.paymentTermsDays === '' ? null : Number(customer.paymentTermsDays);
  const danisco = /danisco/i.test(String(customer.name ?? ''));
  if (danisco) {
    if (terms !== DANISCO_TERMS_DAYS) writes.push({ field: 'paymentTermsDays', from: terms, to: DANISCO_TERMS_DAYS, reason: 'DANISCO_120' });
  } else if (terms === null || Number.isNaN(terms)) {
    writes.push({ field: 'paymentTermsDays', from: null, to: DEFAULT_TERMS_DAYS, reason: 'DEFAULT_NET_30' });
  } else if (terms !== DEFAULT_TERMS_DAYS) notes.push('EXPLICIT_TERMS_KEPT:' + terms);
  return { writes, notes };
}

export function planAll(customers, exportRows) {
  const idx = indexExport(exportRows);
  const live = customers.filter(isLive);
  const plans = live.map((customer) => {
    const entry = idx.get(normName(customer.name));
    return { customer, inFile: Boolean(entry), ...planCustomer(customer, entry) };
  });
  return { plans, live, toApply: plans.filter((p) => p.writes.length > 0) };
}
