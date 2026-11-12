/**
 * Which bills the Payables desk works, what each row says about its load, and the reports built
 * from them. Pure: the page passes the bills, the shipment facts it has read and the masked payment
 * info; this file decides and the page renders.
 *
 * The rule (Ryne 2026-11-12): a bill is on Payables once its load was approved in Load review and
 * moved to billing — Move to billing is what creates it — and only for a load that has delivered.
 * Bills brought over from Aljex were never through Load review; they stay payable (we still owe the
 * money) but sit behind a toggle so the default view is the new flow alone.
 */
import { daysLate } from '@/lib/arAging'
import { billDueDate } from '@/lib/carrierBill'
import { payToLabel, remitEmailOf } from './apViews'
import type { CarrierPaymentInfo } from '@/lib/apiClient'
import type { CarrierBillRecord, OrderRecord, ShipmentRecord } from '@/types/tms'

/** The load facts a bill row shows, read once per shipment. */
export interface BillShipmentFacts {
  shipmentNumber: string | null
  po: string | null
  /** YYYY-MM-DD or ISO; null when the load has not delivered. */
  deliveredAt: string | null
  delivered: boolean
}

export type BillFactsIndex = ReadonlyMap<string, BillShipmentFacts>

function referenceValue(order: OrderRecord | undefined, code: string): string | null {
  const ref = order?.references?.find((r) => r.code === code && (r.value ?? '').trim() !== '')
  return ref ? ref.value.trim() : null
}

/** `shipmentId` -> what the row needs from the shipment and its order. */
export function billFactsIndex(shipments: readonly ShipmentRecord[], orders: readonly OrderRecord[]): Map<string, BillShipmentFacts> {
  const orderByShipment = new Map<string, OrderRecord>()
  for (const order of orders) if (order.shipmentId && !orderByShipment.has(order.shipmentId)) orderByShipment.set(order.shipmentId, order)
  const out = new Map<string, BillShipmentFacts>()
  for (const shipment of shipments) {
    const deliveredAt = shipment.deliveredAt ?? null
    out.set(shipment.id, {
      shipmentNumber: shipment.number ?? null,
      po: referenceValue(orderByShipment.get(shipment.id), 'PO'),
      deliveredAt,
      delivered: Boolean(deliveredAt) || shipment.status === 'DELIVERED',
    })
  }
  return out
}

/** Brought over from Aljex: written by the import, never through Load review. */
export function isAljexBill(bill: Pick<CarrierBillRecord, 'createdBy' | 'recordedBy'>): boolean {
  return bill.createdBy === 'aljex-import' || bill.recordedBy === 'aljex-import'
}

/**
 * The bills the desk works: delivered loads only, and only the Load review flow unless the Aljex
 * bills are asked for. A bill whose shipment has not been read yet is held back rather than shown
 * as undelivered and then snatched away.
 */
export function payablesQueue(
  bills: readonly CarrierBillRecord[],
  facts: BillFactsIndex,
  opts: { includeAljex: boolean },
): CarrierBillRecord[] {
  return bills.filter((bill) => {
    if (isAljexBill(bill) && !opts.includeAljex) return false
    return facts.get(bill.shipmentId)?.delivered === true
  })
}

/** The PRO a row prints: the shipment number, else the number snapshotted on the bill. */
export function proOf(bill: Pick<CarrierBillRecord, 'shipmentId' | 'shipmentNumber' | 'loadNumber'>, facts: BillFactsIndex): string {
  return facts.get(bill.shipmentId)?.shipmentNumber ?? bill.shipmentNumber ?? bill.loadNumber ?? bill.shipmentId
}

/** `2 days · 6%` or `Standard (21 days)`. */
export function termsLabel(bill: Pick<CarrierBillRecord, 'quickPay' | 'quickPayDays' | 'quickPayFeeBps' | 'termsDays'>): string {
  if (bill.quickPay === true && bill.quickPayDays) {
    const pct = (bill.quickPayFeeBps ?? 0) / 100
    return `Quick pay ${bill.quickPayDays} days · ${pct}%`
  }
  return `Standard (${bill.termsDays} days)`
}

/* ── Reports ─────────────────────────────────────────────────────────────── */

export type ApReportKind = 'expected' | 'aging' | 'selected'

export const AP_REPORT_TITLE: Record<ApReportKind, string> = {
  expected: 'Expected payables',
  aging: 'Aging payables',
  selected: 'Selected for payment',
}

export interface ApReportRow {
  billId: string
  pro: string
  po: string
  carrier: string
  payTo: string
  remitEmail: string
  deliveredAt: string | null
  invoiceNumber: string
  /** Null while the carrier's invoice date is still pending. */
  invoiceDate: string | null
  dueAt: string | null
  /** The due date is a guess from the delivery date and the carrier's terms. */
  dueEstimated: boolean
  terms: string
  grossCents: number
  feeCents: number
  netCents: number
  balanceCents: number
  /** Days since the carrier's invoice date; null while it is pending. */
  daysAging: number | null
}

/**
 * When a bill still waiting on its invoice date will likely be due: the delivery date plus the
 * bill's terms (quick-pay days when chosen). Falls back to the placeholder due date on the bill.
 */
export function estimatedDueAt(bill: CarrierBillRecord, facts: BillFactsIndex): string {
  const delivered = facts.get(bill.shipmentId)?.deliveredAt
  return delivered ? billDueDate(delivered.slice(0, 10), bill.termsDays) : bill.dueAt
}

export function apReportRows(
  bills: readonly CarrierBillRecord[],
  facts: BillFactsIndex,
  infos: readonly CarrierPaymentInfo[],
  asOf: string,
): ApReportRow[] {
  return bills.map((bill) => {
    const pending = bill.datesPending === true
    return {
      billId: bill.id,
      pro: proOf(bill, facts),
      po: facts.get(bill.shipmentId)?.po ?? '',
      carrier: bill.carrierName ?? '',
      payTo: payToLabel(bill),
      remitEmail: remitEmailOf(bill, infos),
      deliveredAt: facts.get(bill.shipmentId)?.deliveredAt ?? null,
      invoiceNumber: bill.billNumber ?? '',
      invoiceDate: pending ? null : bill.billDate,
      dueAt: pending ? estimatedDueAt(bill, facts) : bill.dueAt,
      dueEstimated: pending,
      terms: termsLabel(bill),
      grossCents: bill.grossCents,
      feeCents: bill.quickPayFeeCents ?? 0,
      netCents: bill.netCents,
      balanceCents: bill.balanceCents,
      daysAging: pending ? null : Math.max(0, daysLate(bill.billDate, asOf)),
    }
  })
}

export interface ApReportCarrierTotal { carrier: string; count: number; grossCents: number; feeCents: number; netCents: number; balanceCents: number }

/** One line per carrier, biggest balance first, then the grand total. */
export function apReportTotals(rows: readonly ApReportRow[]): { byCarrier: ApReportCarrierTotal[]; total: ApReportCarrierTotal } {
  const map = new Map<string, ApReportCarrierTotal>()
  const total: ApReportCarrierTotal = { carrier: 'Total', count: 0, grossCents: 0, feeCents: 0, netCents: 0, balanceCents: 0 }
  for (const row of rows) {
    const key = row.carrier || '—'
    const t = map.get(key) ?? { carrier: key, count: 0, grossCents: 0, feeCents: 0, netCents: 0, balanceCents: 0 }
    for (const sum of [t, total]) {
      sum.count += 1
      sum.grossCents += row.grossCents
      sum.feeCents += row.feeCents
      sum.netCents += row.netCents
      sum.balanceCents += row.balanceCents
    }
    map.set(key, t)
  }
  const byCarrier = [...map.values()].sort((a, b) => b.balanceCents - a.balanceCents || a.carrier.localeCompare(b.carrier))
  return { byCarrier, total }
}

const csvCell = (value: string | number | null): string => {
  const text = value == null ? '' : String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}
const dollars = (cents: number): string => (cents / 100).toFixed(2)

export function apReportCsv(rows: readonly ApReportRow[]): string {
  const header = ['PRO', 'PO', 'Carrier', 'Pay to', 'Remit e-mail', 'Delivered', 'Carrier invoice #', 'Invoice date', 'Due date', 'Due estimated', 'Terms', 'Carrier pay', 'Quick pay fee', 'Net', 'Balance', 'Days aging']
  const lines = rows.map((r) => [
    r.pro, r.po, r.carrier, r.payTo, r.remitEmail, r.deliveredAt?.slice(0, 10) ?? '', r.invoiceNumber, r.invoiceDate ?? 'Pending',
    r.dueAt ?? '', r.dueEstimated ? 'Yes' : '', r.terms, dollars(r.grossCents), dollars(r.feeCents), dollars(r.netCents), dollars(r.balanceCents),
    r.daysAging ?? '',
  ].map(csvCell).join(','))
  const { byCarrier, total } = apReportTotals(rows)
  const totals = [...byCarrier, total].map((t) => [
    `${t.carrier} (${t.count})`, '', '', '', '', '', '', '', '', '', '', dollars(t.grossCents), dollars(t.feeCents), dollars(t.netCents), dollars(t.balanceCents), '',
  ].map(csvCell).join(','))
  return [header.join(','), ...lines, '', 'Totals by carrier', ...totals].join('\n') + '\n'
}

/* ── Cash requirements ───────────────────────────────────────────────────── */

export interface CashBucket {
  key: string
  label: string
  /** YYYY-MM-DD inclusive; null for the past-due bucket. */
  from: string | null
  to: string | null
  count: number
  cents: number
  /** Of `cents`, the part whose due date is an estimate (invoice date still pending). */
  estimatedCents: number
  rows: ApReportRow[]
}

export interface CashRequirements {
  asOf: string
  pastDue: CashBucket
  weeks: CashBucket[]
  /** Past due plus every week in the 30 days. */
  totalCents: number
  totalCount: number
  estimatedCents: number
  /** Due after the 30-day window; not counted in the total. */
  laterCents: number
  laterCount: number
}

const addDays = (day: string, n: number): string => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

const fmtDay = (day: string): string =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

/**
 * What we expect to pay over the next 30 days, from every open bill (Expected, Aging and Selected)
 * by its due date: what is already past due, then week by week from today (four 7-day weeks and the
 * last two days), then the 30-day total. A bill still waiting on its invoice date is placed by its
 * estimated due date and counted as estimated. Amounts are the balance still owed (net of quick pay).
 */
export function cashRequirements(rows: readonly ApReportRow[], asOf: string): CashRequirements {
  const end = addDays(asOf, 29)
  const bucket = (key: string, label: string, from: string | null, to: string | null): CashBucket =>
    ({ key, label, from, to, count: 0, cents: 0, estimatedCents: 0, rows: [] })
  const pastDue = bucket('past-due', 'Past due', null, addDays(asOf, -1))
  const weeks: CashBucket[] = []
  for (let start = asOf, n = 1; start <= end; start = addDays(start, 7), n += 1) {
    const stop = addDays(start, 6) > end ? end : addDays(start, 6)
    weeks.push(bucket(`week-${n}`, `Week ${n} · ${fmtDay(start)}–${fmtDay(stop)}`, start, stop))
  }
  let laterCents = 0
  let laterCount = 0
  const put = (b: CashBucket, row: ApReportRow) => {
    b.count += 1
    b.cents += row.balanceCents
    if (row.dueEstimated) b.estimatedCents += row.balanceCents
    b.rows.push(row)
  }
  for (const row of rows) {
    if (row.balanceCents <= 0) continue
    const due = row.dueAt ?? asOf
    if (due < asOf) { put(pastDue, row); continue }
    const week = weeks.find((w) => w.from! <= due && due <= w.to!)
    if (week) put(week, row)
    else { laterCents += row.balanceCents; laterCount += 1 }
  }
  for (const b of [pastDue, ...weeks]) b.rows.sort((a, c) => String(a.dueAt).localeCompare(String(c.dueAt)))
  const all = [pastDue, ...weeks]
  return {
    asOf,
    pastDue,
    weeks,
    totalCents: all.reduce((s, b) => s + b.cents, 0),
    totalCount: all.reduce((s, b) => s + b.count, 0),
    estimatedCents: all.reduce((s, b) => s + b.estimatedCents, 0),
    laterCents,
    laterCount,
  }
}

export function cashRequirementsCsv(cash: CashRequirements): string {
  const lines = ['Period,From,To,Bills,Amount,Of which estimated']
  for (const b of [cash.pastDue, ...cash.weeks]) {
    lines.push([b.label, b.from ?? '', b.to ?? '', b.count, dollars(b.cents), dollars(b.estimatedCents)].map(csvCell).join(','))
  }
  lines.push(['Next 30 days', cash.asOf, addDays(cash.asOf, 29), cash.totalCount, dollars(cash.totalCents), dollars(cash.estimatedCents)].map(csvCell).join(','))
  lines.push(['Due after 30 days (not included)', '', '', cash.laterCount, dollars(cash.laterCents), ''].map(csvCell).join(','))
  lines.push('', 'Bills')
  lines.push('Period,PRO,Carrier,Pay to,Due date,Due estimated,Balance')
  for (const b of [cash.pastDue, ...cash.weeks]) {
    for (const r of b.rows) lines.push([b.label, r.pro, r.carrier, r.payTo, r.dueAt ?? '', r.dueEstimated ? 'Yes' : '', dollars(r.balanceCents)].map(csvCell).join(','))
  }
  return lines.join('\n') + '\n'
}
