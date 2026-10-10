/**
 * The vendor AP queue as money, for the dashboard card: what is still to pay, what is
 * overdue, what is due this week, and how many rows still have no amount at all.
 */
import type { VendorPayable } from '@/types/vendorAp'

export interface VendorApTotals {
  /** Cents across every NEED_TO_PAY row with an amount. */
  outstandingAmount: number
  outstandingCount: number
  /** NEED_TO_PAY rows whose amount nobody (or the extractor) has filled yet. */
  unvalued: number
  overdue: { count: number; amount: number }
  dueThisWeek: { count: number; amount: number }
  /** Paid in the last 30 days, cents. */
  paidLast30: number
  /** The soonest due date still open, if any. */
  nextDue: string | null
}

const DAY = 86_400_000

export function vendorApTotals(items: readonly VendorPayable[], today: string): VendorApTotals {
  const weekEnd = new Date(Date.parse(`${today}T12:00:00Z`) + 7 * DAY).toISOString().slice(0, 10)
  const since30 = new Date(Date.parse(`${today}T12:00:00Z`) - 30 * DAY).toISOString().slice(0, 10)
  const t: VendorApTotals = { outstandingAmount: 0, outstandingCount: 0, unvalued: 0, overdue: { count: 0, amount: 0 }, dueThisWeek: { count: 0, amount: 0 }, paidLast30: 0, nextDue: null }
  for (const it of items) {
    if (it.status === 'DONE') {
      if (it.paymentDate && it.paymentDate >= since30 && it.amount != null) t.paidLast30 += it.amount
      continue
    }
    t.outstandingCount += 1
    if (it.amount == null) { t.unvalued += 1 } else t.outstandingAmount += it.amount
    const due = it.dueDate ?? null
    if (due) {
      if (due < today) { t.overdue.count += 1; t.overdue.amount += it.amount ?? 0 }
      else if (due <= weekEnd) { t.dueThisWeek.count += 1; t.dueThisWeek.amount += it.amount ?? 0 }
      if (!t.nextDue || due < t.nextDue) t.nextDue = due
    }
  }
  return t
}
