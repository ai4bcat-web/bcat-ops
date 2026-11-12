/**
 * Pure planning for scripts/awCustomerBillingEmails.mjs (Ryne 2026-11-12: "upload all these AP emails into all customers").
 * Source: the OTR billing-emails list (name, mcNumber, dotNumber, billingEmail, billingContactName, billingPhone).
 * Writes Customer.apEmail (the invoice "To", only while empty), appends the company's other AP addresses to apEmailsExtra, and
 * notice-of-assignment addresses to noaEmail. Never for a FACTOR customer's AP fields, never an @bcatcorp.com address, never a POD inbox.
 * Matching is exact on MC number first, then on the normalized name (case, punctuation, "(...)" notes and a trailing LLC/INC/CORP... dropped).
 */
import { FACTOR_ADDRESSES, INTERNAL_DOMAIN, parseAddresses } from './customerBillingPlan.mjs';

const blank = (v) => v == null || String(v).trim() === '';
export const SKIP_NAMES = [/^jenny test custy/i, /^carrier settlements$/i];
const SUFFIX_WORDS = new Set(['llc', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd', 'lp', 'llp']);

export const normKey = (name) => {
  const words = String(name ?? '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/&/g, ' and ').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  while (words.length > 1 && SUFFIX_WORDS.has(words[words.length - 1])) words.pop();
  return words.join('');
};
export const normMc = (v) => { const d = String(v ?? '').replace(/\D/g, '').replace(/^0+/, ''); return d || ''; };

/** Notice-of-assignment (factoring notice) addresses: kept OUT of the AP e-mail field (Ryne 2026-11-12). */
export const isNoticeAddress = (a) => /@noa\.triumphpay\.com$|@relaypayments\.com$|noa@|factornotice|factor@|factoringinvoices_noa|noalor|kofnoa|tlfactoring|apfactor|^support@payments\.tfin\.com$/i.test(String(a));

/** Proof-of-delivery / paperwork inboxes: never an AP address (Ryne 2026-11-12); reported, not written. */
export const isPodAddress = (a) => /^pod@|paperwork/i.test(String(a));

/** CSV rows -> [{name,key,mc,emails,notice,skipped}] (blank-email and skipped rows dropped, counted). */
export function prepareRows(rows) {
  const out = []; let blankRows = 0; const skipped = []; const bcatInternal = [];
  for (const r of rows) {
    const name = String(r.name ?? '').trim();
    if (!name) continue;
    if (SKIP_NAMES.some((re) => re.test(name))) { skipped.push(name); continue; }
    const { valid, bad } = parseAddresses(r.billingEmail);
    const real = valid.filter((a) => !a.endsWith(INTERNAL_DOMAIN) && !FACTOR_ADDRESSES.has(a));
    if (valid.some((a) => a.endsWith(INTERNAL_DOMAIN))) bcatInternal.push(name);
    if (!real.length) { if (!bad.length && !valid.length) blankRows += 1; continue; }
    out.push({ name, key: normKey(name), mc: normMc(r.mcNumber), emails: real.filter((a) => !isNoticeAddress(a)), noa: real.filter(isNoticeAddress), bad });
  }
  return { rows: out, blankRows, skipped, bcatInternal };
}

/**
 * Group prepared rows into companies: rows that share a normalized name or an MC number are one company.
 * Several AP addresses are no longer a conflict (Ryne 2026-11-12): the first becomes apEmail, the rest go to apEmailsExtra.
 * POD / paperwork inboxes are split out into `pod` and never written.
 */
export function groupCompanies(rows) {
  const parent = rows.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a, b) => { parent[find(a)] = find(b); };
  const seen = new Map();
  rows.forEach((r, i) => {
    for (const k of [r.key && `n:${r.key}`, r.mc && `m:${r.mc}`].filter(Boolean)) { if (seen.has(k)) union(i, seen.get(k)); else seen.set(k, i); }
  });
  const groups = new Map();
  rows.forEach((r, i) => { const g = find(i); groups.set(g, [...(groups.get(g) ?? []), r]); });
  return [...groups.values()].map((rs) => {
    const all = [...new Set(rs.flatMap((r) => r.emails))];
    const emails = all.filter((a) => !isPodAddress(a));
    const pod = all.filter(isPodAddress);
    const noa = [...new Set(rs.flatMap((r) => r.noa))];
    return { noa, pod, names: [...new Set(rs.map((r) => r.name))], keys: new Set(rs.map((r) => r.key)), mcs: new Set(rs.map((r) => r.mc).filter(Boolean)), emails, conflict: false };
  });
}

const isLive = (c) => c.active !== false && !c.mergedIntoId;

/**
 * Plan against production Customers. Returns { companies, results, unmatched } where each result is
 * { company, customer?, status, email?, existing?, flags[] } and status is one of
 * FILL | SAME_EMAIL | DIFFERS | FACTOR_CUSTOMER | AMBIGUOUS | UNMATCHED | NOA_ONLY (only a notice address; AP left blank) |
 * POD_ONLY (only POD / paperwork inboxes). FILL and SAME_EMAIL carry `extrasAdded` (addresses to append to apEmailsExtra).
 * `noa` on each result lists the notice-of-assignment addresses. They go to Customer.noaEmail (never apEmail): `noaWrites` lists the
 * matched customers whose noaEmail is blank and whose company has exactly one notice address; the rest are reported in `noaOther`.
 */
export function planBillingEmails(customers, prepared, opts = {}) {
  // includeFactored (Ryne 2026-11-12): factored customers get their AP address too (a factored bill is never e-mailed, so it is reference only).
  const includeFactored = opts.includeFactored === true;
  const companies = groupCompanies(prepared.rows);
  const live = customers.filter(isLive);
  const byKey = new Map(); const byMc = new Map();
  for (const c of live) {
    const k = normKey(c.name); if (k) byKey.set(k, [...(byKey.get(k) ?? []), c]);
    const m = normMc(c.mcNumber); if (m) byMc.set(m, [...(byMc.get(m) ?? []), c]);
  }
  const results = []; const claimed = new Map();
  for (const company of companies) {
    const found = new Map();
    for (const m of company.mcs) for (const c of byMc.get(m) ?? []) found.set(c.id, c);
    if (!found.size) for (const k of company.keys) for (const c of byKey.get(k) ?? []) found.set(c.id, c);
    const flags = [];
    if (!found.size) { results.push({ company, status: 'UNMATCHED', flags }); continue; }
    if (found.size > 1) { results.push({ company, status: 'AMBIGUOUS', matches: [...found.values()], flags }); continue; }
    const customer = [...found.values()][0];
    if (claimed.has(customer.id)) { results.push({ company, customer, status: 'AMBIGUOUS', matches: [customer], flags: [...flags, 'CUSTOMER_MATCHED_BY_TWO_COMPANIES'] }); continue; }
    claimed.set(customer.id, company);
    if (company.conflict) { results.push({ company, customer, status: 'CONFLICT', flags }); continue; }
    if (!company.emails.length) { results.push({ company, customer, status: company.noa.length ? 'NOA_ONLY' : 'POD_ONLY', flags }); continue; }
    const email = company.emails[0];
    const existing = blank(customer.apEmail) ? null : String(customer.apEmail).trim();
    if (customer.billingMethod === 'FACTOR') {
      if (!includeFactored) { results.push({ company, customer, status: 'FACTOR_CUSTOMER', email, existing, flags }); continue; }
      flags.push('FACTORED');
    }
    if (existing && existing.toLowerCase() !== email) { results.push({ company, customer, status: 'DIFFERS', email, existing, flags }); continue; }
    // Extras: the company's other AP addresses, appended to what the customer already lists (never removed), minus the primary.
    const current = (customer.apEmailsExtra ?? []).map((a) => String(a).trim().toLowerCase()).filter(Boolean);
    const extrasAdded = company.emails.slice(1).filter((a) => a !== email && !current.includes(a));
    if (existing) { results.push({ company, customer, status: 'SAME_EMAIL', email, existing, extrasAdded, extrasBefore: customer.apEmailsExtra ?? null, flags }); continue; }
    if (blank(customer.billingMethod)) flags.push('BILLING_METHOD_UNSET');
    results.push({ company, customer, status: 'FILL', email, extrasAdded, extrasBefore: customer.apEmailsExtra ?? null, flags });
  }
  // NOA addresses are written independently of the AP result, but only for a single, unambiguous match with one address.
  const noaWrites = []; const noaOther = [];
  for (const r of results) {
    if (!r.customer || !r.company.noa.length) continue;
    if (r.status === 'AMBIGUOUS' || r.status === 'CONFLICT') { noaOther.push({ ...r, why: r.status }); continue; }
    if (r.company.noa.length > 1) { noaOther.push({ ...r, why: 'MULTIPLE_NOA' }); continue; }
    const noa = r.company.noa[0];
    const existing = blank(r.customer.noaEmail) ? null : String(r.customer.noaEmail).trim();
    if (!existing) noaWrites.push({ customer: r.customer, noa, company: r.company });
    else noaOther.push({ ...r, why: existing.toLowerCase() === noa ? 'NOA_SAME' : 'NOA_DIFFERS', existing, noa });
  }
  return { companies, results, noaWrites, noaOther, liveCount: live.length };
}
