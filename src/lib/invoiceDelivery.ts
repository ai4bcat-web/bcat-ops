/**
 * The delivery side of an invoice: which shipments may go out through the standard
 * invoice template, and which documents travel with an invoice, in what order.
 *
 * Pure and dependency-light on purpose — the finance Lambda bundles this by relative
 * import, so nothing here may touch node:, the DOM or an alias.
 */
import { canEmailTo, type ShipmentDocumentRecord, type ShipmentDocumentType } from './shipmentDocuments'

// ── Square-invoiced divisions ───────────────────────────────────────────────

/** Best Care Auto Transport invoices through Square (queue 42), never the standard template. */
export const SQUARE_INVOICED_DIVISION = 'CAR_SHIPPING'

/** Prefix of the refusal so callers and the UI can tell "not here" from a real failure. */
export const SQUARE_INVOICED_CODE = 'SQUARE_INVOICED'

export const SQUARE_INVOICED_MESSAGE = 'Invoiced in Square (coming)'

export function isSquareInvoiced(shipment: { revDivision?: string | null } | null | undefined): boolean {
  return shipment?.revDivision === SQUARE_INVOICED_DIVISION
}

/** Thrown wherever a CAR_SHIPPING shipment would be posted, rendered, e-mailed or queued. */
export class SquareInvoicedError extends Error {
  readonly code = SQUARE_INVOICED_CODE
  constructor(what: string) {
    super(`${SQUARE_INVOICED_CODE}: ${SQUARE_INVOICED_MESSAGE} — ${what} is not done from the standard invoice template.`)
    this.name = 'SquareInvoicedError'
  }
}

export function assertNotSquareInvoiced(shipment: { revDivision?: string | null } | null | undefined, what: string): void {
  if (isSquareInvoiced(shipment)) throw new SquareInvoicedError(what)
}

// ── The documents packet ────────────────────────────────────────────────────

/**
 * Stable order after the invoice itself (which always leads): rate confirmation, POD,
 * scale tickets, lumper receipts, everything else.
 */
const PACKET_RANK: Partial<Record<ShipmentDocumentType, number>> = {
  CUSTOMER_RATE_CON: 1,
  RATE_CON: 1,
  POD: 2,
  WEIGHT_TICKET: 3,
  LUMPER_RECEIPT: 4,
}
const PACKET_RANK_OTHER = 5

export function invoicePacketRank(type: ShipmentDocumentType): number {
  return PACKET_RANK[type] ?? PACKET_RANK_OTHER
}

/**
 * The documents a CUSTOMER may receive with an invoice, in packet order.
 *
 * `canEmailTo(doc, 'CUSTOMER')` is the public/private rule: INTERNAL (the private
 * folder), CARRIER-only, VOID, PENDING and REJECTED rows are dropped here, so every
 * caller — preview, generate, send, resend — gets the same answer. Ties keep upload
 * order, then id, so two runs never reorder a packet.
 */
export function customerPacketDocuments<T extends ShipmentDocumentRecord>(documents: readonly T[]): T[] {
  return documents
    .filter((doc) => canEmailTo(doc, 'CUSTOMER'))
    .sort(
      (a, b) =>
        invoicePacketRank(a.type) - invoicePacketRank(b.type) ||
        (a.createdAt ?? '').localeCompare(b.createdAt ?? '') ||
        a.id.localeCompare(b.id),
    )
}

/** Ids from `ids` that are customer-visible, deduplicated, in packet order. Unknown ids are dropped. */
export function customerPacketIds(documents: readonly ShipmentDocumentRecord[], ids: readonly string[]): string[] {
  const wanted = new Set(ids)
  return customerPacketDocuments(documents.filter((doc) => wanted.has(doc.id))).map((doc) => doc.id)
}

// ── What an invoice e-mail carries (Ryne, 2026-11-12) ───────────────────────

/**
 * Every invoice goes out with its POD. A rate confirmation goes only on Ivan Cartage
 * (assets) invoices, and only the CUSTOMER's — the broker's rate con to Ivan. On a BCAT
 * Logistics / brokerage load the rate con on file is ours to the carrier: it shows what
 * we pay the carrier, so it never reaches a customer. Anything our rate-con generator or
 * carrier e-sign produced (`source` GENERATED / CARRIER_PORTAL) is a carrier rate con on
 * any load and is never attached.
 */
export const RATE_CON_TYPES: readonly ShipmentDocumentType[] = ['RATE_CON', 'CUSTOMER_RATE_CON']

export function isRateConType(type: ShipmentDocumentType): boolean {
  return RATE_CON_TYPES.includes(type)
}

/**
 * A rate confirmation the customer sent us (theirs to Ivan), as opposed to ours to a carrier.
 * Same reading as the OTR submit (otr-actions `findShipmentRatecon`): `CUSTOMER_RATE_CON`, or a
 * plain `RATE_CON` filed in the Customer section (it names the order). The Carrier section
 * (`loadCarrierId` set) and anything our generator or a carrier produced is never the customer's.
 */
export function isCustomerRateCon(
  doc: Pick<ShipmentDocumentRecord, 'type' | 'source' | 'orderId' | 'loadCarrierId'>,
): boolean {
  // GENERATED / CARRIER_PORTAL: our rate-con generator or a carrier's e-sign. LEGACY: an imported Aljex carrier rate confirm.
  if (doc.source === 'GENERATED' || doc.source === 'CARRIER_PORTAL' || doc.source === 'LEGACY') return false
  if (doc.loadCarrierId != null) return false
  if (doc.type === 'CUSTOMER_RATE_CON') return true
  return doc.type === 'RATE_CON' && doc.orderId != null
}

/** Filed, live, and not waiting on (or refused by) review — audience aside. */
function isLiveDocument(doc: Pick<ShipmentDocumentRecord, 'status' | 'reviewStatus'>): boolean {
  return doc.status === 'ACTIVE' && doc.reviewStatus !== 'PENDING' && doc.reviewStatus !== 'REJECTED'
}

export interface InvoiceAttachmentScope {
  /** The documents the invoice picked when it was raised (`Invoice.attachDocumentIds`). */
  attachIds?: readonly string[] | null
  /** The order and loads the invoice bills for; omitted, every document passed in counts. */
  orderId?: string | null
  loadIds?: readonly string[] | null
  /** Bills on the Ivan Cartage letterhead (`invoiceBrandingFor(...).key === 'IVAN'`). */
  ivan: boolean
}

function inScope(doc: Pick<ShipmentDocumentRecord, 'orderId' | 'loadId'>, scope: InvoiceAttachmentScope): boolean {
  if (scope.orderId == null && scope.loadIds == null) return true
  if (scope.orderId != null && doc.orderId === scope.orderId) return true
  return doc.loadId != null && (scope.loadIds ?? []).includes(doc.loadId)
}

/**
 * The documents that travel with one invoice e-mail, in packet order (the invoice PDF
 * itself always leads and is not in this list):
 *   - whatever the invoice picked at issue that a customer may receive, minus any rate con;
 *   - every live POD on the order's loads (multi-stop: all of them), even one filed after issue;
 *   - on an Ivan Cartage invoice only, the customer's rate confirmation(s).
 */
export function invoiceEmailDocuments<T extends ShipmentDocumentRecord>(
  documents: readonly T[],
  scope: InvoiceAttachmentScope,
): T[] {
  const picked = new Set(scope.attachIds ?? [])
  const out: T[] = []
  for (const doc of documents) {
    if (isRateConType(doc.type)) {
      if (scope.ivan && isCustomerRateCon(doc) && isLiveDocument(doc) && inScope(doc, scope)) out.push(doc)
      continue
    }
    if (!canEmailTo(doc, 'CUSTOMER')) continue
    if (picked.has(doc.id) || (doc.type === 'POD' && inScope(doc, scope))) out.push(doc)
  }
  return customerPacketOrder(out)
}

function customerPacketOrder<T extends ShipmentDocumentRecord>(documents: T[]): T[] {
  return [...documents].sort(
    (a, b) =>
      invoicePacketRank(a.type) - invoicePacketRank(b.type) ||
      (a.createdAt ?? '').localeCompare(b.createdAt ?? '') ||
      a.id.localeCompare(b.id),
  )
}

/** ATTACHED: goes with the e-mail. NOT_INCLUDED: this kind of invoice never carries it. MISSING: it should, but none is on file. */
export type InvoiceAttachmentState = 'ATTACHED' | 'NOT_INCLUDED' | 'MISSING'

export interface InvoiceAttachmentItem {
  documentId: string | null
  name: string
  type: ShipmentDocumentType | 'INVOICE_PDF'
  sizeBytes: number | null
  /** A POD that travels as pages inside the invoice PDF, not as its own attachment. */
  inInvoicePdf?: boolean
}

/**
 * Whether a POD of this type can be merged into the invoice PDF (PDF, JPG, PNG). The send
 * reads the bytes and decides for certain; this lets the review flag a HEIC or a Word file
 * before anyone presses Send.
 */
export function isMergeablePodType(contentType: string | null | undefined, name: string | null | undefined): boolean {
  const type = (contentType || '').toLowerCase()
  const n = (name || '').toLowerCase()
  if (type.includes('pdf') || /jpe?g/.test(type) || type.includes('png')) return true
  if (!type || type === 'application/octet-stream' || type === 'binary/octet-stream') {
    return !/\.(heic|heif|tiff?|webp|gif|bmp|docx?|xlsx?)$/.test(n)
  }
  return false
}

/** PODs are merged into the invoice PDF whenever there is an invoice PDF to merge them into. */
export function mergesIntoInvoicePdf(doc: Pick<ShipmentDocumentRecord, 'type'>, hasInvoicePdf: boolean): boolean {
  return hasInvoicePdf && doc.type === 'POD'
}

export interface InvoiceAttachmentPlan {
  invoicePdf: InvoiceAttachmentState
  pod: InvoiceAttachmentState
  rateCon: InvoiceAttachmentState
  /** Separate files on the e-mail, the invoice PDF (with its POD pages) included. */
  count: number
  /** PODs that cannot be merged into the invoice PDF: the send is refused until each is replaced. */
  unmergeablePods?: string[]
  totalBytes: number
  items: InvoiceAttachmentItem[]
}

/** The same rule as the send, as the review screen and the list columns show it. */
export function invoiceAttachmentPlan(
  documents: readonly ShipmentDocumentRecord[],
  scope: InvoiceAttachmentScope,
  invoicePdf: { name: string; sizeBytes: number | null } | null,
): InvoiceAttachmentPlan {
  const docs = invoiceEmailDocuments(documents, scope)
  const items: InvoiceAttachmentItem[] = []
  if (invoicePdf) items.push({ documentId: null, name: invoicePdf.name, type: 'INVOICE_PDF', sizeBytes: invoicePdf.sizeBytes })
  for (const doc of docs) {
    items.push({
      documentId: doc.id, name: doc.name, type: doc.type, sizeBytes: doc.sizeBytes ?? null,
      ...(mergesIntoInvoicePdf(doc, invoicePdf != null) ? { inInvoicePdf: true } : {}),
    })
  }
  const unmergeablePods = invoicePdf
    ? docs.filter((doc) => doc.type === 'POD' && !isMergeablePodType(doc.contentType, doc.name)).map((doc) => doc.name)
    : []
  return {
    invoicePdf: invoicePdf ? 'ATTACHED' : 'MISSING',
    pod: docs.some((doc) => doc.type === 'POD') ? 'ATTACHED' : 'MISSING',
    rateCon: !scope.ivan ? 'NOT_INCLUDED' : docs.some((doc) => isRateConType(doc.type)) ? 'ATTACHED' : 'MISSING',
    count: items.filter((item) => !item.inInvoicePdf).length,
    ...(unmergeablePods.length > 0 ? { unmergeablePods } : {}),
    totalBytes: items.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0),
    items,
  }
}

/** One row of the INVOICE_ATTACHMENTS answer. */
export interface InvoiceAttachmentPlanRow extends Partial<InvoiceAttachmentPlan> {
  invoiceId: string
  ivan?: boolean
  /** Over the 10 MB an e-mail can carry: the send will be refused. */
  tooBig?: boolean
  /** Carrier-pay guard hits. `hard`: a carrier document — remove it, no override. Otherwise a content match an admin may override. */
  carrierPayFlags?: { documentId: string | null; name: string; reason: string; hard: boolean }[]
  error?: string
}
