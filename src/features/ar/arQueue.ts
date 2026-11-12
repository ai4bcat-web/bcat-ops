/**
 * The Invoicing queue: one row per released shipment, wherever it is on the way to paid.
 *
 * Three statuses, derived — never stored:
 * - READY: released to billing from Load Review (Order.arStatus UNBILLED) and delivered,
 *   no invoice yet. A shipment that has not delivered never appears, whatever its order says.
 * - INVOICED: an invoice is out with a balance (ISSUED or PARTIAL). A PARTIAL one is short paid.
 * - PAID: the invoice's balance is zero (Invoice.status PAID).
 *
 * Pure: the page passes the worklist rows, the invoices, the shipments it has read and the
 * name lookups; this file decides and the page renders.
 */
import { daysLate } from '@/lib/arAging'
import type { ArWorklistRow } from '@/hooks/useArWorklist'
import type { InvoiceRecord, ShipmentRecord } from '@/types/tms'

export type ArQueueStatus = 'READY' | 'INVOICED' | 'PAID'

export const AR_QUEUE_STATUS_LABEL: Record<ArQueueStatus, string> = {
  READY: 'Ready to invoice',
  INVOICED: 'Invoiced',
  PAID: 'Paid',
}

export interface ArQueueRow {
  key: string
  status: ArQueueStatus
  orderId: string
  shipmentId: string
  shipmentNumber: string | null
  invoiceId: string | null
  invoiceNumber: string | null
  customerId: string | null
  customerName: string
  /** OwnershipDivision code, or null when the shipment is untagged. */
  revDivision: string | null
  revDivisionName: string
  salesRepId: string | null
  salesRepName: string
  deliveredAt: string | null
  /** When it was moved to billing from Load Review. */
  releasedAt: string | null
  invoiceDate: string | null
  dueAt: string | null
  amountCents: number
  paidCents: number
  balanceCents: number
  sentAt: string | null
  sentTo: string | null
  sentCount: number
  /** Positive when past due; null when there is no due date or nothing is owed. */
  daysPastDue: number | null
  /** Invoiced, something was paid, and a balance is still open. */
  shortPaid: boolean
  paidAt: string | null
  /** The cached-field blockers from the worklist (READY only). */
  reasons: string[]
  invoice: InvoiceRecord | null
  worklist: ArWorklistRow | null
}

export interface ArQueueLookups {
  shipmentsById: Map<string, ShipmentRecord>
  divisionName: (code: string | null | undefined) => string
  repName: (id: string | null | undefined) => string
  /** YYYY-MM-DD, the page's one clock. */
  asOf: string
}

const UNTAGGED = 'No division'
const NO_REP = 'No sales rep'

/** Delivered by stamp or by status. A released order whose freight has not delivered is not billable. */
export function isDelivered(row: ArWorklistRow): boolean {
  return Boolean(row.deliveredAt || row.shipment?.deliveredAt || row.shipment?.status === 'DELIVERED')
}

function common(shipment: ShipmentRecord | null | undefined, l: ArQueueLookups) {
  const revDivision = shipment?.revDivision ?? null
  const salesRepId = shipment?.salesRepId ?? null
  return {
    revDivision,
    revDivisionName: revDivision ? l.divisionName(revDivision) : UNTAGGED,
    salesRepId,
    salesRepName: salesRepId ? l.repName(salesRepId) : NO_REP,
  }
}

export function readyRow(row: ArWorklistRow, l: ArQueueLookups): ArQueueRow {
  const shipment = row.shipment ?? l.shipmentsById.get(row.shipmentId) ?? null
  return {
    key: `order:${row.orderId}`,
    status: 'READY',
    orderId: row.orderId,
    shipmentId: row.shipmentId,
    shipmentNumber: row.shipmentNumber,
    invoiceId: null,
    invoiceNumber: null,
    customerId: row.customerId,
    customerName: row.customerName || '—',
    ...common(shipment, l),
    deliveredAt: row.deliveredAt ?? shipment?.deliveredAt ?? null,
    releasedAt: row.order.readyToInvoiceAt ?? row.arStatusChangedAt ?? null,
    invoiceDate: null,
    dueAt: null,
    amountCents: row.revenueCents,
    paidCents: 0,
    balanceCents: row.revenueCents,
    sentAt: null,
    sentTo: null,
    sentCount: 0,
    daysPastDue: null,
    shortPaid: false,
    paidAt: null,
    reasons: row.reasons,
    invoice: null,
    worklist: row,
  }
}

export function invoiceRow(inv: InvoiceRecord, l: ArQueueLookups, releasedAt?: string | null): ArQueueRow {
  const shipment = l.shipmentsById.get(inv.shipmentId) ?? null
  const status: ArQueueStatus = inv.status === 'PAID' ? 'PAID' : 'INVOICED'
  const late = status === 'INVOICED' && inv.dueAt ? daysLate(inv.dueAt, l.asOf) : null
  const revDivision = shipment?.revDivision ?? inv.divisionKey ?? null
  return {
    key: `invoice:${inv.id}`,
    status,
    orderId: inv.orderId,
    shipmentId: inv.shipmentId,
    shipmentNumber: inv.shipmentNumber ?? shipment?.number ?? null,
    invoiceId: inv.id,
    invoiceNumber: inv.number,
    customerId: inv.customerId,
    customerName: inv.customerName || '—',
    ...common(shipment, l),
    revDivision,
    revDivisionName: revDivision ? l.divisionName(revDivision) : UNTAGGED,
    deliveredAt: shipment?.deliveredAt ?? null,
    releasedAt: releasedAt ?? null,
    invoiceDate: inv.invoiceDate ?? null,
    dueAt: inv.dueAt ?? null,
    amountCents: inv.totalCents,
    paidCents: inv.paidCents,
    balanceCents: inv.balanceCents,
    sentAt: inv.sentAt ?? inv.markedSentAt ?? null,
    sentTo: inv.sentTo ?? null,
    sentCount: inv.sentCount ?? 0,
    daysPastDue: late,
    shortPaid: status === 'INVOICED' && inv.paidCents > 0 && inv.balanceCents > 0,
    paidAt: inv.paidAt ?? null,
    reasons: [],
    invoice: inv,
    worklist: null,
  }
}

/** READY rows: released (UNBILLED) and delivered. Undelivered orders are dropped, not flagged. */
export function buildReadyRows(unbilled: ArWorklistRow[], l: ArQueueLookups): ArQueueRow[] {
  return unbilled.filter(isDelivered).map((row) => readyRow(row, l))
}

/** INVOICED rows: open invoices (ISSUED / PARTIAL). */
export function buildInvoicedRows(open: InvoiceRecord[], l: ArQueueLookups, releasedByOrder?: Map<string, string | null>): ArQueueRow[] {
  return open
    .filter((inv) => inv.status === 'ISSUED' || inv.status === 'PARTIAL')
    .map((inv) => invoiceRow(inv, l, releasedByOrder?.get(inv.orderId)))
}

/** PAID rows: invoices whose balance is zero. */
export function buildPaidRows(invoices: InvoiceRecord[], l: ArQueueLookups): ArQueueRow[] {
  return invoices.filter((inv) => inv.status === 'PAID').map((inv) => invoiceRow(inv, l))
}

export type ArGroupBy = 'none' | 'division' | 'customer' | 'rep'

export const AR_GROUP_BY_LABEL: Record<ArGroupBy, string> = {
  none: 'None',
  division: 'Rev division',
  customer: 'Customer',
  rep: 'Sales rep',
}

export function groupKeyOf(row: ArQueueRow, by: ArGroupBy): string {
  if (by === 'division') return row.revDivisionName
  if (by === 'customer') return row.customerName
  if (by === 'rep') return row.salesRepName
  return ''
}

export interface ArGroupTotals {
  count: number
  amountCents: number
  balanceCents: number
}

export function groupTotals(rows: ArQueueRow[]): ArGroupTotals {
  let amountCents = 0
  let balanceCents = 0
  for (const r of rows) {
    amountCents += r.amountCents
    balanceCents += r.balanceCents
  }
  return { count: rows.length, amountCents, balanceCents }
}

/** Stable: rows keep their order inside a group; groups are alphabetical, the "No …" bucket last. */
export function orderByGroup(rows: ArQueueRow[], by: ArGroupBy): ArQueueRow[] {
  if (by === 'none') return rows
  const keys = [...new Set(rows.map((r) => groupKeyOf(r, by)))].sort((a, b) => {
    const aNo = a === UNTAGGED || a === NO_REP || a === '—'
    const bNo = b === UNTAGGED || b === NO_REP || b === '—'
    if (aNo !== bNo) return aNo ? 1 : -1
    return a.localeCompare(b)
  })
  const rank = new Map(keys.map((k, i) => [k, i]))
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => (rank.get(groupKeyOf(a.row, by))! - rank.get(groupKeyOf(b.row, by))!) || a.i - b.i)
    .map((x) => x.row)
}
