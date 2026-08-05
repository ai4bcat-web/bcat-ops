/**
 * Identity rules for ingested maintenance invoices.
 *
 * WHY THIS EXISTS: dedup used to key on
 *     date | equipmentId | vendor | amount | invoiceNumber
 * — every one of which a human edits while reviewing the invoice. Assigning the correct
 * truck (very often 'unassigned' → a real unit) changed the key, so the next ingest run
 * no longer recognised the invoice and inserted it again as a fresh PENDING row. That is
 * why reviewed and archived invoices kept reappearing in the queue.
 *
 * The fix is an identity derived only from what the SOURCE DOCUMENT says, frozen on the
 * record at creation as `externalId`. Later edits in the app cannot change it, so a
 * re-parse of the same email always matches the row it created.
 */
import { createHash } from 'crypto'

/**
 * Case/whitespace/punctuation-insensitive so "A-1 Truck Repair" == "a1 truck  repair".
 * Apostrophes are DELETED rather than turned into a space, so "Brother's Truck Repair"
 * matches "Brothers Truck Repair" — vendors write their own name both ways.
 */
export function normalizeVendor(vendor) {
  return String(vendor ?? '')
    .toLowerCase()
    .replace(/['’"]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Invoice numbers vary in punctuation and case across emails: "INV-1042" == "inv 1042". */
export function normalizeInvoiceNumber(num) {
  return String(num ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/** Dates arrive as YYYY-MM-DD or full ISO; compare on the calendar day only. */
export function normalizeDate(date) {
  return String(date ?? '').slice(0, 10)
}

/**
 * Stable identity for an invoice as the source document described it.
 *
 * Deliberately EXCLUDES equipmentId — which unit a repair belongs to is a judgement the
 * office makes during review, not a property of the document, and including it is what
 * caused the duplicates.
 */
export function invoiceExternalId(raw) {
  const parts = [
    normalizeDate(raw?.date),
    normalizeVendor(raw?.vendor),
    String(raw?.amount ?? 0),
    normalizeInvoiceNumber(raw?.invoiceNumber),
  ].join('|')
  return createHash('sha256').update(parts).digest('hex').slice(0, 32)
}

/**
 * Fallback match for rows created before externalId existed. Same normalisation, and
 * still without equipmentId, so legacy invoices that have since been assigned to a truck
 * are recognised too.
 */
export function legacyContentKey(inv) {
  return [
    normalizeDate(inv?.date),
    normalizeVendor(inv?.vendor),
    String(inv?.amount ?? 0),
    normalizeInvoiceNumber(inv?.invoiceNumber),
  ].join('|')
}

/**
 * Build the lookup of everything already ingested, by both identities, so an invoice is
 * skipped whatever era it was created in — and regardless of its review status. An
 * ARCHIVED invoice must stay archived, not come back on the next run.
 */
export function buildSeenIndex(existingInvoices) {
  const byExternalId = new Set()
  const byContent = new Set()
  for (const inv of existingInvoices ?? []) {
    if (inv?.externalId) byExternalId.add(inv.externalId)
    byContent.add(legacyContentKey(inv))
  }
  return { byExternalId, byContent }
}

/** True when this parsed invoice is already in the backend under either identity. */
export function isAlreadyIngested(raw, seen) {
  return seen.byExternalId.has(invoiceExternalId(raw)) || seen.byContent.has(legacyContentKey(raw))
}
