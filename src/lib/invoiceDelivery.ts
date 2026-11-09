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
