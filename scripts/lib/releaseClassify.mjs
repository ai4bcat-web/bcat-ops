/**
 * Pure classification for scripts/awRelease.mjs (no AWS, no files): which migrated DELIVERED shipments the Aljex export
 * says were RELEASED to billing, and what (if anything) has to be written for them.
 *
 * "Released" in this app is ORDER-level, not a Shipment.status value (src/lib/shipmentLists.ts isReleasedToInvoicing):
 * Order.readyToInvoiceAt or Order.invoiceId set, or Order.arStatus anything other than DOCS_NEEDED. Shipment.status
 * stays DELIVERED. The Active shipments list hides a released row; the All list shows it.
 */
import { normalizePro } from '../../src/lib/proNumber.ts';

/** Order.arStatus rungs the app treats as "left DOCS_NEEDED" (released). */
export const isOrderReleased = (order) =>
  !!order && (order.readyToInvoiceAt != null || order.invoiceId != null || (order.arStatus != null && order.arStatus !== 'DOCS_NEEDED'));

/** MM/DD/YY or MM/DD/YYYY -> YYYY-MM-DD, null when blank/unparseable. */
export function parseAljexDate(value) {
  const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\s*$/.exec(value ?? '');
  if (!m) return null;
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Index export rows by normalized PRO. Duplicate PROs merge: any release/invoice date wins (latest date), dispatch
 * status of the last row. `dupes` counts the merged extra rows.
 * @param {Array<{pro: string, release: string, invoice: string, status: string}>} rows raw column strings
 */
export function indexExport(rows) {
  const byPro = new Map();
  let dupes = 0;
  for (const r of rows) {
    const key = normalizePro(r.pro);
    if (!key) continue;
    const release = parseAljexDate(r.release);
    const invoice = parseAljexDate(r.invoice);
    const prev = byPro.get(key);
    if (!prev) {
      byPro.set(key, { release, invoice, status: (r.status ?? '').trim().toUpperCase() });
      continue;
    }
    dupes += 1;
    byPro.set(key, {
      release: [prev.release, release].filter(Boolean).sort().pop() ?? null,
      invoice: [prev.invoice, invoice].filter(Boolean).sort().pop() ?? null,
      status: (r.status ?? '').trim().toUpperCase() || prev.status,
    });
  }
  return { byPro, dupes };
}

/** A carrier bill that was approved (approvedAt, or it moved past IN_REVIEW into payables). */
export const isApprovedBill = (bill) =>
  !!bill && bill.status !== 'VOID' && bill.status !== 'IN_REVIEW' && (bill.approvedAt != null || ['TO_BE_PAID', 'PARTIAL', 'PAID'].includes(bill.status));

export const CATEGORIES = ['TO_RELEASE', 'ALREADY_RELEASED', 'STAY_DELIVERED', 'REVIEW', 'UNKNOWN', 'OTHER_STATUS'];

/**
 * @param {object} input
 * @param {{id: string, number?: string, status: string, voidedAt?: string|null, deletedAt?: string|null}} input.shipment
 * @param {Array<object>} input.orders        the shipment's Order rows
 * @param {string[]} input.keys               normalized PROs the shipment is known by (number, Load.aljexId, ProClaim id)
 * @param {Map<string, {release: string|null, invoice: string|null, status: string}>} input.exportByPro
 * @param {boolean} input.hasInvoice          an Invoice row exists for the shipment/order (any status)
 * @param {boolean} input.hasApprovedBill     an approved CarrierBill exists for the shipment
 * @returns {{category: string, reason: string, releaseDate: string|null, invoiceDate: string|null, source: string|null, order: object|null}}
 *   `source` is ALJEX_RELEASE_DATE | FALLBACK_INVOICE | FALLBACK_CARRIER_BILL for released rows.
 */
export function classifyShipment({ shipment, orders, keys, exportByPro, hasInvoice, hasApprovedBill }) {
  let row = null;
  for (const k of keys) {
    const hit = exportByPro.get(k);
    if (hit) { row = hit; break; }
  }
  const releaseDate = row?.release ?? null;
  const invoiceDate = row?.invoice ?? null;
  const done = (category, reason, source = null, order = null) => ({ category, reason, releaseDate, invoiceDate, source, order });

  if (shipment.status !== 'DELIVERED') {
    return row && (releaseDate || invoiceDate)
      ? done('OTHER_STATUS', `status ${shipment.status} left alone; Aljex has ${releaseDate ? 'a Release Date' : 'no Release Date'}${invoiceDate ? ' and an Invoice Date' : ''}`)
      : done('OTHER_STATUS', `status ${shipment.status} left alone`);
  }
  if (shipment.voidedAt || shipment.deletedAt) return done('STAY_DELIVERED', 'voided/deleted shipment');

  let source = null;
  if (row) {
    if (releaseDate && invoiceDate) source = 'ALJEX_RELEASE_DATE';
    else if (releaseDate) return done('REVIEW', 'Aljex has a Release Date but no Invoice Date');
    else if (invoiceDate) return done('REVIEW', 'Aljex has an Invoice Date but no Release Date');
    else if (row.status === 'DELIVERED') return done('REVIEW', 'Aljex DELIVERED with no Release Date and no Invoice Date');
    else return done('STAY_DELIVERED', `Aljex status ${row.status || '(blank)'} with no Release Date and no Invoice Date`);
  } else if (hasInvoice) source = 'FALLBACK_INVOICE';
  else if (hasApprovedBill) source = 'FALLBACK_CARRIER_BILL';
  else return done('UNKNOWN', 'not in the Aljex export and no Invoice or approved CarrierBill');

  if (orders.length !== 1) return done('REVIEW', `released by ${source} but the shipment has ${orders.length} orders`, source);
  const order = orders[0];
  if (isOrderReleased(order)) return done('ALREADY_RELEASED', `released by ${source}; order already ${order.invoiceId ? 'invoiced' : order.arStatus}`, source, order);
  return done('TO_RELEASE', `released by ${source}`, source, order);
}

/**
 * The Order fields a release writes. Money fields are never part of it.
 *  - Aljex Release + Invoice date: the Aljex-era bill already went out -> LEGACY (the app's own rung for exactly that,
 *    never a worklist row, never invoiced a second time); readyToInvoiceAt = the Aljex Release Date (noon UTC).
 *  - Fallback by an approved carrier bill (no invoice anywhere): the app's own release, UNBILLED, stamped now.
 * Same bookkeeping as READY_TO_INVOICE (documents.ts): arStatusChangedAt, readyToInvoiceAt, updatedBy/At, version + 1.
 */
export const RELEASE_USER = 'migration:awRelease';
export function releasePatch({ source, releaseDate }, order, nowIso) {
  const legacy = source === 'ALJEX_RELEASE_DATE';
  return {
    arStatus: legacy ? 'LEGACY' : 'UNBILLED',
    arStatusChangedAt: nowIso,
    readyToInvoiceAt: legacy && releaseDate ? `${releaseDate}T12:00:00.000Z` : nowIso,
    updatedBy: RELEASE_USER,
    updatedAt: nowIso,
    version: (typeof order.version === 'number' ? order.version : 1) + 1,
  };
}

/** The only attribute names a release may ever SET (asserted by the script and its test). */
export const RELEASE_FIELDS = ['arStatus', 'arStatusChangedAt', 'readyToInvoiceAt', 'updatedBy', 'updatedAt', 'version'];

export const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
