// Relative, not `@/` — the tmsFinanceActions Lambda bundles this file by path for the AR
// summary it returns, and the alias does not exist in the function build.
import type { InvoiceRecord, OrderRecord, ShipmentRecord } from '../types/tms'

/**
 * AR aging: how old the open money is, how long delivery-to-invoice and invoice-to-cash
 * take, and what has delivered but hasn't been billed yet.
 *
 * Everything here is integer cents in and integer cents out; the only place a dollar
 * string appears is `agingCsv`, at the export boundary.
 *
 * Dates are compared as whole UTC calendar days. An invoice dated the 1st with 30-day
 * terms is due on the 31st and is "1 day late" on the 1st of the next month no matter
 * what hour anyone looks at it — the alternative (millisecond differences) makes the same
 * invoice move buckets between the morning and the afternoon of one day.
 */

/** Ordered youngest → oldest; the UI and the CSV both render them in this order. */
export const AGING_BUCKETS = ['CURRENT', 'D1_30', 'D31_60', 'D61_90', 'D91_PLUS'] as const

export type AgingBucket = (typeof AGING_BUCKETS)[number]

export const AGING_BUCKET_LABEL: Record<AgingBucket, string> = {
  CURRENT: 'Current',
  D1_30: '1–30',
  D31_60: '31–60',
  D61_90: '61–90',
  D91_PLUS: '90+',
}

/** One customer's column of the aging table. */
export interface AgingCustomerRow {
  customerId: string
  customerName: string
  byBucket: Record<AgingBucket, number>
  totalCents: number
  /** How many of this customer's open invoices are at least one day past due. */
  lateCount: number
  /** `daysLate` of the oldest late invoice; 0 when nothing is late. */
  oldestDays: number
}

export interface AgingSummary {
  totalCents: number
  byBucket: Record<AgingBucket, number>
  /** Everything outside CURRENT — the number the aging strip leads with. */
  lateCents: number
  /** Sorted by open balance, largest first. */
  byCustomer: AgingCustomerRow[]
}

/** One delivered order still waiting to be invoiced. */
export interface DeliveredNotInvoicedRow {
  orderId: string
  shipmentId: string
  shipmentNumber: string
  customerId: string
  customerName: string
  deliveredAt: string
  /** Whole days from delivery to `asOf`. */
  daysWaiting: number
  revenueCents: number
}

const DAY_MS = 86_400_000

/** Invoices that still carry a balance. VOID and PAID are not open money. */
const OPEN_STATUS: Partial<Record<InvoiceRecord['status'], true>> = { ISSUED: true, PARTIAL: true }

/** AR rungs that mean "delivered, nobody has billed it". LEGACY and the rest are not. */
const UNINVOICED_AR_STATUS: Partial<Record<NonNullable<OrderRecord['arStatus']>, true>> = {
  DOCS_NEEDED: true,
  UNBILLED: true,
}

/**
 * Whole days between two ISO dates or timestamps, or null when either is unusable.
 * Timestamps are truncated to their UTC date, so the time of day never counts.
 */
function dayDiff(from: string | null | undefined, to: string | null | undefined): number | null {
  const a = /^(\d{4})-(\d{2})-(\d{2})/.exec(from ?? '')
  const b = /^(\d{4})-(\d{2})-(\d{2})/.exec(to ?? '')
  if (!a || !b) return null
  const fromMs = Date.UTC(Number(a[1]), Number(a[2]) - 1, Number(a[3]))
  const toMs = Date.UTC(Number(b[1]), Number(b[2]) - 1, Number(b[3]))
  return (toMs - fromMs) / DAY_MS
}

/**
 * Whole days `asOf` is past `dueAt`. 0 on the due date itself, negative before it, so
 * callers can show "due in 3 days" from the same number.
 *
 * An unparsable date is treated as not late rather than infinitely late — a bad date
 * should never invent a 90+ bucket entry.
 */
export function daysLate(dueAt: string, asOf: string): number {
  return dayDiff(dueAt, asOf) ?? 0
}

/** Which aging column an invoice due on `dueAt` sits in on `asOf`. */
export function agingBucket(dueAt: string, asOf: string): AgingBucket {
  const d = daysLate(dueAt, asOf)
  if (d <= 0) return 'CURRENT'
  if (d <= 30) return 'D1_30'
  if (d <= 60) return 'D31_60'
  if (d <= 90) return 'D61_90'
  return 'D91_PLUS'
}

const emptyBuckets = (): Record<AgingBucket, number> => ({
  CURRENT: 0,
  D1_30: 0,
  D31_60: 0,
  D61_90: 0,
  D91_PLUS: 0,
})

/**
 * Age a set of invoices as of a date.
 *
 * Only ISSUED and PARTIAL rows count: callers pass the `arOpen` index, but a row that was
 * paid or voided between the query and the render would otherwise show up as money owed.
 * The balance — not the total — is what is aged, so a part-paid invoice ages its
 * remainder.
 */
export function ageInvoices(openInvoices: InvoiceRecord[], asOf: string): AgingSummary {
  const byBucket = emptyBuckets()
  const byCustomerId = new Map<string, AgingCustomerRow>()
  let totalCents = 0
  let lateCents = 0

  for (const inv of openInvoices) {
    if (!OPEN_STATUS[inv.status]) continue
    const balance = inv.balanceCents
    const late = daysLate(inv.dueAt, asOf)
    const bucket = agingBucket(inv.dueAt, asOf)

    totalCents += balance
    byBucket[bucket] += balance
    if (late > 0) lateCents += balance

    let row = byCustomerId.get(inv.customerId)
    if (!row) {
      row = {
        customerId: inv.customerId,
        customerName: inv.customerName ?? '',
        byBucket: emptyBuckets(),
        totalCents: 0,
        lateCount: 0,
        oldestDays: 0,
      }
      byCustomerId.set(inv.customerId, row)
    }
    if (!row.customerName && inv.customerName) row.customerName = inv.customerName
    row.byBucket[bucket] += balance
    row.totalCents += balance
    if (late > 0) {
      row.lateCount += 1
      if (late > row.oldestDays) row.oldestDays = late
    }
  }

  const byCustomer = [...byCustomerId.values()].sort(
    (a, b) =>
      b.totalCents - a.totalCents ||
      a.customerName.localeCompare(b.customerName) ||
      a.customerId.localeCompare(b.customerId),
  )

  return { totalCents, byBucket, lateCents, byCustomer }
}

/**
 * How many days late the oldest open invoice is, or null when nothing is open or
 * everything is still inside terms. Null means "no late money", which is what the credit
 * check's `maxDaysLate` rule and the AR strip both want — not 0, which reads as "late by
 * nothing".
 */
export function oldestOpenInvoiceDays(openInvoices: InvoiceRecord[], asOf: string): number | null {
  let oldest = 0
  for (const inv of openInvoices) {
    if (!OPEN_STATUS[inv.status]) continue
    const late = daysLate(inv.dueAt, asOf)
    if (late > oldest) oldest = late
  }
  return oldest > 0 ? oldest : null
}

/** Mean of whole-day gaps, rounded to one decimal; null when nothing qualifies. */
function meanDays(days: number[]): number | null {
  if (days.length === 0) return null
  const sum = days.reduce((a, b) => a + b, 0)
  return Math.round((sum / days.length) * 10) / 10
}

/**
 * Average days from delivery to invoice — the billing lag.
 *
 * VOID invoices are excluded (a voided bill measures a mistake, not a lag) and so is any
 * invoice whose shipment has no delivery date: invoice-early customers are billed before
 * delivery and would otherwise report a lag that never happened.
 */
export function avgDaysToInvoice(invoices: InvoiceRecord[], shipments: ShipmentRecord[]): number | null {
  const deliveredAtById = new Map<string, string>()
  for (const s of shipments) {
    if (s.deliveredAt) deliveredAtById.set(s.id, s.deliveredAt)
  }
  const days: number[] = []
  for (const inv of invoices) {
    if (inv.status === 'VOID') continue
    const delivered = deliveredAtById.get(inv.shipmentId)
    if (!delivered) continue
    const d = dayDiff(delivered, inv.issuedAt)
    if (d !== null) days.push(d)
  }
  return meanDays(days)
}

/**
 * Average days from invoice to payment (DSO on what has actually been collected).
 * Only PAID invoices have a `paidAt`; open ones are still accruing and VOID ones never
 * will, so both are excluded.
 */
export function avgDaysToPay(invoices: InvoiceRecord[]): number | null {
  const days: number[] = []
  for (const inv of invoices) {
    if (inv.status !== 'PAID') continue
    const d = dayDiff(inv.issuedAt, inv.paidAt)
    if (d !== null) days.push(d)
  }
  return meanDays(days)
}

/**
 * Delivered freight nobody has billed: orders on a delivered, live shipment whose AR rung
 * is still DOCS_NEEDED or UNBILLED.
 *
 * LEGACY (Aljex-era, billed outside the TMS), INVOICE_NOT_NEEDED, UNPAID and PAID are all
 * excluded — the first two are never going to be invoiced here and the last two already
 * were. Deleted shipments are excluded with them.
 *
 * Newest delivery first, so the list reads as a to-do with the freshest work on top.
 */
export function deliveredNotInvoiced(
  orders: OrderRecord[],
  shipments: ShipmentRecord[],
  asOf: string = new Date().toISOString(),
): DeliveredNotInvoicedRow[] {
  const byId = new Map<string, { shipment: ShipmentRecord; deliveredAt: string }>()
  for (const s of shipments) {
    if (s.status !== 'DELIVERED' || s.deletedAt || !s.deliveredAt) continue
    byId.set(s.id, { shipment: s, deliveredAt: s.deliveredAt })
  }

  const rows: DeliveredNotInvoicedRow[] = []
  for (const o of orders) {
    if (!o.arStatus || !UNINVOICED_AR_STATUS[o.arStatus]) continue
    const hit = byId.get(o.shipmentId)
    if (!hit) continue
    const { shipment, deliveredAt } = hit
    rows.push({
      orderId: o.id,
      shipmentId: shipment.id,
      shipmentNumber: shipment.number,
      customerId: o.customerId,
      customerName: o.customerName ?? shipment.customerName ?? '',
      deliveredAt,
      daysWaiting: dayDiff(deliveredAt, asOf) ?? 0,
      revenueCents: o.revenueCents ?? 0,
    })
  }

  return rows.sort(
    (a, b) => (a.deliveredAt < b.deliveredAt ? 1 : a.deliveredAt > b.deliveredAt ? -1 : a.orderId.localeCompare(b.orderId)),
  )
}

/**
 * Quote every field, doubling embedded quotes per RFC 4180 — the `apptCsv` convention.
 * Always quoting means a customer name with a comma, a quote or a newline in it can't
 * shift the money columns one to the left.
 */
const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`

/** Integer cents → a plain `1234.50` a spreadsheet will parse as a number. */
const dollars = (cents: number) => {
  const abs = Math.abs(Math.round(cents))
  return `${cents < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

export const AGING_CSV_HEADER = [
  'Customer',
  ...AGING_BUCKETS.map((b) => AGING_BUCKET_LABEL[b]),
  'Total',
  'Late invoices',
  'Oldest days',
] as const

/** The aging table as a CSV, in the order given (i.e. `ageInvoices` order). */
export function agingCsv(rows: AgingCustomerRow[]): string {
  const lines = [AGING_CSV_HEADER.map(q).join(',')]
  for (const r of rows) {
    lines.push(
      [
        r.customerName,
        ...AGING_BUCKETS.map((b) => dollars(r.byBucket[b])),
        dollars(r.totalCents),
        r.lateCount,
        r.oldestDays,
      ]
        .map(q)
        .join(','),
    )
  }
  return lines.join('\n')
}
