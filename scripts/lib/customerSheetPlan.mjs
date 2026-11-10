/**
 * Pure planning for scripts/awCustomerSheet.mjs (Ryne 2026-11-10): Ryne's customer list sheet (Name, address, E-Billing Email)
 * decides each matched customer's billing method, invoice e-mail and address. No I/O.
 *   - a factoring address (…factoring@bcatcorp.com) -> billingMethod FACTOR; the invoice e-mail is not required, so apEmail is left alone;
 *   - any other address -> billingMethod MANUAL and apEmail = the address(es), comma separated;
 *   - blank -> the billing fields are left for Ryne to set;
 *   - the address fills billingAddress where the customer has none (never overwrites one).
 * Matching is by normalized name, exact first, then without legal suffixes; an ambiguous name is never guessed.
 */
const SUFFIXES = /\b(INCORPORATED|INC|LLC|L L C|LTD|LIMITED|CORP|CORPORATION|CO|COMPANY|LP|LLP|THE)\b/g;

export const normName = (s) => String(s ?? '').toUpperCase().replace(/&/g, ' AND ').replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
export const looseName = (s) => normName(s).replace(SUFFIXES, ' ').replace(/\s+/g, ' ').trim();

export const isFactoringAddress = (email) => /factoring@bcatcorp\.com$/i.test(String(email ?? '').trim());
const blank = (v) => v == null || String(v).trim() === '';

/** Index the live customers (not merged away) by exact and loose name; a name two customers share is ambiguous. */
export function indexCustomers(customers) {
  const exact = new Map();
  const loose = new Map();
  const put = (map, key, c) => { if (!key) return; map.set(key, map.has(key) ? null : c); };
  for (const c of customers) {
    if (c.mergedIntoId) continue;
    put(exact, normName(c.name), c);
    put(loose, looseName(c.name), c);
  }
  return { exact, loose };
}

export function matchCustomer(index, sheetName) {
  const e = index.exact.get(normName(sheetName));
  if (e) return { customer: e, how: 'NAME' };
  if (e === null) return { ambiguous: true };
  const l = index.loose.get(looseName(sheetName));
  if (l) return { customer: l, how: 'LOOSE_NAME' };
  if (l === null) return { ambiguous: true };
  return { none: true };
}

/** The writes for one sheet row against its customer: { billingMethod?, apEmail?, billingAddress? } plus what it was. */
export function planRow(row, customer) {
  const emails = (row.emails ?? []).filter((e) => !isFactoringAddress(e));
  const factor = (row.emails ?? []).some(isFactoringAddress);
  const set = {};
  let kind = 'BLANK';
  if (factor) { kind = 'FACTOR'; if (customer.billingMethod !== 'FACTOR') set.billingMethod = 'FACTOR'; }
  else if (emails.length) {
    kind = 'MANUAL';
    if (customer.billingMethod !== 'MANUAL') set.billingMethod = 'MANUAL';
    const ap = emails.join(', ');
    if ((customer.apEmail ?? '') !== ap) set.apEmail = ap;
  }
  const hasAddress = customer.billingAddress && (customer.billingAddress.street || customer.billingAddress.city);
  if (!hasAddress && (row.street || row.city)) {
    set.billingAddress = {
      street: row.street || null, street2: row.street2 || null, city: row.city || null, state: row.state || null, zip: row.zip || null, country: 'US',
    };
  }
  return { kind, set };
}

export function planSheet(rows, customers) {
  const index = indexCustomers(customers);
  const entries = []; const unmatched = []; const ambiguous = []; const blankKept = [];
  for (const row of rows) {
    const m = matchCustomer(index, row.name);
    if (m.ambiguous) { ambiguous.push(row); continue; }
    if (!m.customer) { unmatched.push(row); continue; }
    const { kind, set } = planRow(row, m.customer);
    if (kind === 'BLANK') blankKept.push({ row, customer: m.customer });
    if (Object.keys(set).length) entries.push({ row, customer: m.customer, how: m.how, kind, set });
  }
  return { entries, unmatched, ambiguous, blankKept };
}
