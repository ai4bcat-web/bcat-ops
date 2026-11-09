/**
 * Pure planning for scripts/awCustomerEmail.mjs: which customer e-mail fields the Aljex customers export may fill.
 * Enrich only: a target is planned only while it is empty; nothing here reads or plans any non-e-mail field.
 *
 * Where each Aljex column goes (the fields the app's invoice path actually reads, see release.ts manualInvoiceRecipients):
 *   E-Billing Email  -> first external valid address = Customer.apEmail (the invoice "To"); the other valid external
 *                       addresses = Customer.invoiceCopyEmails (the invoice "cc"), only when apEmail is set by this run
 *                       (or already equals that primary) and the copy list is empty.
 *   Contact email    -> Customer.contactEmail (first valid address).
 *   Contact 2 email  -> counted only (no safe field; the first contact's address is the customer contact).
 * Never written: internal @bcatcorp.com addresses (the factor bridge / BCAT's own invoices@ mailbox; the importer already
 * maps those to FACTOR or a review flag), and apEmail for a FACTOR customer (the factor, not an AP mailbox, handles it).
 */

export const INTERNAL_DOMAIN = '@bcatcorp.com';
export const EMAIL_FIELDS = ['apEmail', 'invoiceCopyEmails', 'contactEmail'];

// local@domain.tld: no spaces/commas/semicolons/angle brackets/parens, at least one dot in the domain, alphabetic TLD >= 2,
// no leading/trailing/double dots in either part.
const EMAIL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

export const isValidEmail = (value) => EMAIL_RE.test(String(value ?? '').trim().toLowerCase());

/** Split on commas, semicolons, whitespace; trim, lowercase, de-duplicate (order kept); valid / malformed apart. */
export function parseAddresses(text) {
  const valid = [];
  const malformed = [];
  const seen = new Set();
  for (const part of String(text ?? '').split(/[\s,;]+/)) {
    const e = part.trim().toLowerCase().replace(/^[<"'(]+|[>"'),.]+$/g, '');
    if (!e || seen.has(e)) continue;
    seen.add(e);
    (isValidEmail(e) ? valid : malformed).push(e);
  }
  return { valid, malformed };
}

export const isInternal = (email) => String(email).toLowerCase().endsWith(INTERNAL_DOMAIN);

const blank = (v) => v == null || (typeof v === 'string' && v.trim() === '');
const blankList = (v) => !Array.isArray(v) || v.length === 0;

/**
 * Plan one export row against its customer.
 * @param {{account:string, name?:string, eBilling?:string, contactEmail?:string, contact2Email?:string}} row
 * @param {{id:string, name?:string, billingMethod?:string|null, apEmail?:string|null, invoiceCopyEmails?:string[]|null, contactEmail?:string|null}} customer
 * @returns {{writes: Array<{field:string, value:any}>, malformed:string[], internal:string[], extras:string[], skipped:string[], contact2:number}}
 */
export function planCustomerEmail(row, customer) {
  const writes = [];
  const skipped = [];
  const eb = parseAddresses(row.eBilling);
  const ct = parseAddresses(row.contactEmail);
  const c2 = parseAddresses(row.contact2Email);
  const malformed = [...eb.malformed, ...ct.malformed, ...c2.malformed];
  const internal = eb.valid.filter(isInternal);
  const external = eb.valid.filter((e) => !isInternal(e));
  const extras = [];

  if (external.length) {
    const primary = external[0];
    if (customer.billingMethod === 'FACTOR') skipped.push('FACTOR_CUSTOMER');
    else if (!blank(customer.apEmail)) {
      skipped.push('AP_ALREADY_SET');
      // The Aljex primary is already the app's AP address: its extra addresses may still fill an empty copy list.
      if (String(customer.apEmail).trim().toLowerCase() === primary && blankList(customer.invoiceCopyEmails) && external.length > 1) {
        extras.push(...external.slice(1));
        writes.push({ field: 'invoiceCopyEmails', value: extras });
      }
    } else {
      writes.push({ field: 'apEmail', value: primary });
      if (external.length > 1 && blankList(customer.invoiceCopyEmails)) {
        extras.push(...external.slice(1));
        writes.push({ field: 'invoiceCopyEmails', value: extras });
      } else if (external.length > 1) skipped.push('COPY_LIST_ALREADY_SET');
    }
  } else if (eb.valid.length === 0 && !blank(row.eBilling) && eb.malformed.length === 0) skipped.push('NO_ADDRESS');

  if (ct.valid.length) {
    if (!blank(customer.contactEmail)) skipped.push('CONTACT_ALREADY_SET');
    else writes.push({ field: 'contactEmail', value: ct.valid[0] });
  }
  return { writes, malformed, internal, extras, skipped, contact2: c2.valid.length };
}

/** Index export rows by Account # (first row wins; a repeated Account # is returned in `duplicates`). */
export function indexByAccount(rows) {
  const byAccount = new Map();
  const duplicates = [];
  for (const r of rows) {
    const a = String(r.account ?? '').trim();
    if (!a) continue;
    if (byAccount.has(a)) duplicates.push(a);
    else byAccount.set(a, r);
  }
  return { byAccount, duplicates };
}

/**
 * Match customers (merged-away rows excluded) to export rows by aljexCode. A code carried by more than one live customer is
 * ambiguous and never written.
 */
export function matchCustomers(customers, byAccount) {
  const live = customers.filter((c) => blank(c.mergedIntoId));
  const byCode = new Map();
  for (const c of live) {
    const code = String(c.aljexCode ?? '').trim();
    if (code) byCode.set(code, [...(byCode.get(code) ?? []), c]);
  }
  const matched = [];
  const ambiguous = [];
  const unmatchedRows = [];
  for (const [account, row] of byAccount) {
    const hit = byCode.get(account) ?? [];
    if (hit.length === 1) matched.push({ row, customer: hit[0] });
    else if (hit.length > 1) ambiguous.push(account);
    else unmatchedRows.push(row);
  }
  return { matched, ambiguous, unmatchedRows, live };
}

/** The apEmail a customer will have after the plan is applied. */
export function apAfter(customer, plan) {
  const w = plan?.writes.find((x) => x.field === 'apEmail');
  return w ? w.value : String(customer.apEmail ?? '').trim().toLowerCase() || null;
}
