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
 *
 * Migration note: when a source document does not contain an invoice number, we now use a
 * `sourceDocumentId` (attachment hash + index or body Message-ID + index) to keep distinct
 * documents distinct. Old rows from before `sourceDocumentId` exist, and a new source-
 * identified document that matches an old row purely by date/vendor/amount is AMBIGUOUS:
 * it could be the same repair or a different one on the same day. We fail these closed for
 * manual review rather than suppressing a genuine invoice or creating a duplicate.
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

function isInvoiceNumberPresent(num) {
  return normalizeInvoiceNumber(num) !== ''
}

/**
 * Build the hash input for an invoice. When an invoice number is present it dominates
 * identity and sourceDocumentId is ignored, preserving existing numbered-invoice dedup.
 * For unnumbered documents the sourceDocumentId participates; if absent it falls back to
 * the classic content-only hash.
 */
function identityParts(raw) {
  const hasNumber = isInvoiceNumberPresent(raw?.invoiceNumber)
  return [
    normalizeDate(raw?.date),
    normalizeVendor(raw?.vendor),
    String(raw?.amount ?? 0),
    ...(hasNumber ? [normalizeInvoiceNumber(raw?.invoiceNumber)] : [String(raw?.sourceDocumentId ?? '')]),
  ].join('|')
}

/**
 * Stable identity for an invoice as the source document described it.
 * Deliberately EXCLUDES equipmentId — which unit a repair belongs to is a judgement the
 * office makes during review, not a property of the document, and including it is what
 * caused the duplicates.
 */
export function invoiceExternalId(raw) {
  const input = identityParts(raw)
  return createHash('sha256').update(input).digest('hex').slice(0, 32)
}

/**
 * Classic content hash used during migration: ignores sourceDocumentId even if present.
 * An old row whose externalId equals this value tells us the document was created without
 * source-document identification.
 */
export function classicInvoiceExternalId(raw) {
  const input = [
    normalizeDate(raw?.date),
    normalizeVendor(raw?.vendor),
    String(raw?.amount ?? 0),
    normalizeInvoiceNumber(raw?.invoiceNumber),
  ].join('|')
  return createHash('sha256').update(input).digest('hex').slice(0, 32)
}

/**
 * Fallback match for rows created before externalId existed. Same normalisation, and
 * still without equipmentId, so legacy invoices that have since been assigned to a truck
 * are recognised too.
 *
 * For unnumbered source-identified rows, sourceDocumentId keeps separate documents separate
 * even though invoiceNumber is absent. For truly legacy unnumbered rows (no externalId and
 * no sourceDocumentId), this conservatively falls back to date|vendor|amount matching,
 * which may require human review when ambiguous — but it will NOT suppress a genuinely
 * new numbered invoice.
 */
export function legacyContentKey(inv) {
  const hasNumber = isInvoiceNumberPresent(inv?.invoiceNumber)
  const sourceDoc = String(inv?.sourceDocumentId ?? '')
  return [
    normalizeDate(inv?.date),
    normalizeVendor(inv?.vendor),
    String(inv?.amount ?? 0),
    ...(hasNumber ? [normalizeInvoiceNumber(inv?.invoiceNumber)] : [sourceDoc]),
  ].join('|')
}

/**
 * Index of already-ingested invoices. Tracks three categories:
 *   - byExternalId: full source-identified externalId
 *   - byClassicExternalId: externalIds created without sourceDocumentId (numbered or not)
 *   - byContent: legacy fallback content key
 *
 * A new invoice is:
 *   - DUPLICATE if its full externalId is in byExternalId.
 *   - AMBIGUOUS if it is source-identified and unnumbered, not a duplicate, but matches a
 *     classic or legacy record by content. We cannot safely insert without human review.
 *   - NEW otherwise.
 */
export function buildSeenIndex(existingInvoices) {
  const byExternalId = new Set()
  const byClassicExternalId = new Set()
  const byContent = new Set()
  for (const inv of existingInvoices ?? []) {
    if (inv?.externalId) {
      byExternalId.add(inv.externalId)
      // Rows created without sourceDocumentId (numbered or unnumbered) have externalIds that
      // match the classic hash. They are migration-era records and should trigger ambiguity
      // for new source-identified unnumbered docs.
      if (!isInvoiceNumberPresent(inv.invoiceNumber) && String(inv?.sourceDocumentId ?? '') === '' && inv.externalId === classicInvoiceExternalId(inv)) {
        byClassicExternalId.add(inv.externalId)
      }
    }
    byContent.add(legacyContentKey(inv))
    // For legacy unnumbered rows that lack an externalId entirely, register the
    // classic content hash as a migration-era marker.
    if (!isInvoiceNumberPresent(inv?.invoiceNumber) && String(inv?.sourceDocumentId ?? '') === '' && !inv?.externalId) {
      byClassicExternalId.add(classicInvoiceExternalId(inv))
    }
  }
  return { byExternalId, byClassicExternalId, byContent }
}

const DEDUP_DUPLICATE = 'DUPLICATE'
const DEDUP_AMBIGUOUS = 'AMBIGUOUS'
const DEDUP_NEW = 'NEW'

/**
 * Tri-state dedup for a parsed invoice.
 *
 *   DUPLICATE: already present under its source identity (or classic identity when the
 *              new document also lacks sourceDocumentId).
 *   AMBIGUOUS: source-identified unnumbered document that matches an existing record by
 *              content/classic identity but may be a genuinely different repair. Caller
 *              should fail closed for manual review.
 *   NEW:       safe to insert.
 */
export function classifyDedup(raw, seen) {
  const externalId = invoiceExternalId(raw)

  if (seen.byExternalId.has(externalId)) return DEDUP_DUPLICATE

  const numbered = isInvoiceNumberPresent(raw?.invoiceNumber)
  const hasSourceDoc = String(raw?.sourceDocumentId ?? '') !== ''

  // Numbered invoices, or docs without sourceDocumentId, are matched by content key as
  // before; there is no source-doc disambiguation to create ambiguity.
  if (numbered || !hasSourceDoc) {
    return seen.byContent.has(legacyContentKey(raw)) ? DEDUP_DUPLICATE : DEDUP_NEW
  }

  // Unnumbered source-identified document. If any existing record matches the classic
  // content key, we cannot tell whether it is the same repair or a different one.
  const classic = classicInvoiceExternalId(raw)
  if (seen.byClassicExternalId.has(classic) || seen.byContent.has(legacyContentKey(raw))) {
    return DEDUP_AMBIGUOUS
  }

  return DEDUP_NEW
}

export function dedupIsDuplicate(result) {
  return result === DEDUP_DUPLICATE
}

export function dedupIsAmbiguous(result) {
  return result === DEDUP_AMBIGUOUS
}

/** True when this parsed invoice is already in the backend under either identity. */
export function isAlreadyIngested(raw, seen) {
  return dedupIsDuplicate(classifyDedup(raw, seen))
}
