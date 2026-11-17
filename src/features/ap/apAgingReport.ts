/**
 * The "Aging by carrier" report: one row per carrier we owe with what they are owed in each aging column, and
 * under each carrier (the twisty) every open bill behind those numbers. The AP twin of the AR aging report.
 *
 * It ages the same bills, the same way, as `useOpenBills` (IN_REVIEW, TO_BE_PAID and PARTIAL, each by its
 * remaining balance, bucketed by due date through `agingBucket`), so the totals row equals the open AP total
 * the rest of the page leads with.
 */
import { AGING_BUCKETS, agingBucket, daysLate, type AgingBucket } from '@/lib/arAging'
import type { CarrierBillRecord, CarrierBillStatus } from '@/types/tms'

const OPEN: Partial<Record<CarrierBillStatus, true>> = { IN_REVIEW: true, TO_BE_PAID: true, PARTIAL: true }

export interface ApAgingBill {
  id: string
  pro: string
  shipmentId: string
  billNumber: string | null
  payTo: string
  /** Where this payee's remittance is e-mailed; empty when none is on file. */
  remitEmail: string
  dueAt: string
  /** Days past the due date; 0 when not yet due. */
  daysPastDue: number
  balanceCents: number
  bucket: AgingBucket
  status: CarrierBillStatus
  quickPay: boolean
}

export interface ApAgingCarrier {
  carrierId: string
  carrierName: string
  byBucket: Record<AgingBucket, number>
  totalCents: number
  pastDueCents: number
  count: number
  /** Days past due of the oldest late bill; 0 when nothing is late. */
  oldestDays: number
  bills: ApAgingBill[]
}

export interface ApAgingReport {
  carriers: ApAgingCarrier[]
  byBucket: Record<AgingBucket, number>
  totalCents: number
  pastDueCents: number
  count: number
}

const emptyBuckets = (): Record<AgingBucket, number> =>
  Object.fromEntries(AGING_BUCKETS.map((b) => [b, 0])) as Record<AgingBucket, number>

export function buildApAgingReport(
  bills: readonly CarrierBillRecord[],
  asOf: string,
  lookups: { proOf: (bill: CarrierBillRecord) => string; payToOf: (bill: CarrierBillRecord) => string; remitEmailOf?: (bill: CarrierBillRecord) => string },
): ApAgingReport {
  const byCarrier = new Map<string, ApAgingCarrier>()
  const report: ApAgingReport = { carriers: [], byBucket: emptyBuckets(), totalCents: 0, pastDueCents: 0, count: 0 }

  for (const bill of bills) {
    if (!OPEN[bill.status]) continue
    const late = daysLate(bill.dueAt, asOf)
    const bucket = agingBucket(bill.dueAt, asOf)
    let row = byCarrier.get(bill.carrierId)
    if (!row) {
      row = { carrierId: bill.carrierId, carrierName: bill.carrierName ?? '', byBucket: emptyBuckets(), totalCents: 0, pastDueCents: 0, count: 0, oldestDays: 0, bills: [] }
      byCarrier.set(bill.carrierId, row)
    }
    if (!row.carrierName && bill.carrierName) row.carrierName = bill.carrierName
    row.byBucket[bucket] += bill.balanceCents
    row.totalCents += bill.balanceCents
    row.count += 1
    if (late > 0) {
      row.pastDueCents += bill.balanceCents
      if (late > row.oldestDays) row.oldestDays = late
    }
    row.bills.push({
      id: bill.id,
      pro: lookups.proOf(bill),
      shipmentId: bill.shipmentId,
      billNumber: bill.billNumber ?? null,
      payTo: lookups.payToOf(bill),
      remitEmail: lookups.remitEmailOf?.(bill) ?? '',
      dueAt: bill.dueAt,
      daysPastDue: late,
      balanceCents: bill.balanceCents,
      bucket,
      status: bill.status,
      quickPay: bill.quickPay === true,
    })
    report.byBucket[bucket] += bill.balanceCents
    report.totalCents += bill.balanceCents
    if (late > 0) report.pastDueCents += bill.balanceCents
    report.count += 1
  }

  for (const row of byCarrier.values()) row.bills.sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.pro.localeCompare(b.pro))
  report.carriers = [...byCarrier.values()].sort(
    (a, b) => b.totalCents - a.totalCents || a.carrierName.localeCompare(b.carrierName) || a.carrierId.localeCompare(b.carrierId),
  )
  return report
}
