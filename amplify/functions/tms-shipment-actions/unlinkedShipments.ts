/**
 * LIST_UNLINKED_SHIPMENTS (Ryne 2026-11-16: "i'll do the customer links manually … can i do it in the customer profiles?").
 * Shipments that carry the customer's typed name but no customer record. Pure: the handler scans the table
 * (projecting only UNLINKED_SHIPMENT_FIELDS) and this picks and shapes the rows.
 *
 * A blank or whitespace `customerId` is not an id, and DynamoDB NULL-typed void/delete markers (DUPLICATE_SHIPMENT wrote
 * them before #510) are not voids: only a real timestamp string counts.
 */
export const UNLINKED_SHIPMENT_FIELDS = [
  'id', 'number', 'customerId', 'customerName', 'originCity', 'destinationCity', 'pickupAppt', 'deliveryAppt', 'status',
  'voidedAt', 'deletedAt', 'loadReviewPushedAt', 'updatedAt',
] as const

export interface UnlinkedShipmentRow {
  id: string
  number: string | null
  customerName: string
  originCity: string | null
  destinationCity: string | null
  pickupAppt: string | null
  deliveryAppt: string | null
  status: string | null
  inLoadReview: boolean
  updatedAt: string | null
}

type Row = Record<string, unknown>

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const orNull = (v: unknown): string | null => text(v) || null

/** At most this many rows go back in one response (newest PRO first); `total` says how many there are. */
export const UNLINKED_ROW_CAP = 1000

export function unlinkedShipments(rows: readonly Row[]): { rows: UnlinkedShipmentRow[]; total: number } {
  const live = rows.filter((r) => !text(r.customerId) && text(r.customerName) && !text(r.voidedAt) && !text(r.deletedAt))
  const sorted = live
    .map((r): UnlinkedShipmentRow => ({
      id: String(r.id),
      number: orNull(r.number),
      customerName: text(r.customerName),
      originCity: orNull(r.originCity),
      destinationCity: orNull(r.destinationCity),
      pickupAppt: orNull(r.pickupAppt),
      deliveryAppt: orNull(r.deliveryAppt),
      status: orNull(r.status),
      inLoadReview: Boolean(text(r.loadReviewPushedAt)),
      updatedAt: orNull(r.updatedAt),
    }))
    .sort((a, b) => String(b.number ?? '').localeCompare(String(a.number ?? ''), undefined, { numeric: true }))
  return { rows: sorted.slice(0, UNLINKED_ROW_CAP), total: sorted.length }
}
