/**
 * Pure projections behind the Vendors page (`/tms/vendors`): the stat row, the source
 * filter and the by-vendor grouping. The queue itself, its write paths and the duplicate
 * rules are untouched; this only reads the rows the page already holds.
 */
import { normVendor } from '@/lib/vendorApDuplicates'
import type { VendorPayable, VendorPayableSource } from '@/types/vendorAp'

export const UNKNOWN_VENDOR = 'Unknown vendor'

const DAY_MS = 86_400_000

/** Whole days from `today` (YYYY-MM-DD) to `date` (YYYY-MM-DD); negative once it has passed. */
function daysFrom(today: string, date: string): number {
  return Math.round((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / DAY_MS)
}

function isOpen(item: VendorPayable): boolean {
  return item.status !== 'DONE'
}

function isOverdue(item: VendorPayable, today: string): boolean {
  return isOpen(item) && !!item.dueDate && daysFrom(today, item.dueDate) < 0
}

export interface VendorApTotals {
  outstandingCents: number
  outstandingCount: number
  overdueCount: number
  /** Open rows due today or within the next 7 days. */
  dueThisWeekCount: number
  /** Sum of rows paid in the last 30 days. */
  paidLast30Cents: number
  /** Open rows nobody has put an amount on yet. */
  unvaluedCount: number
}

export function vendorApTotals(items: readonly VendorPayable[], today: string): VendorApTotals {
  const totals: VendorApTotals = {
    outstandingCents: 0, outstandingCount: 0, overdueCount: 0, dueThisWeekCount: 0, paidLast30Cents: 0, unvaluedCount: 0,
  }
  for (const item of items) {
    if (isOpen(item)) {
      totals.outstandingCount += 1
      if (item.amount == null) totals.unvaluedCount += 1
      else totals.outstandingCents += item.amount
      if (item.dueDate) {
        const days = daysFrom(today, item.dueDate)
        if (days < 0) totals.overdueCount += 1
        else if (days <= 7) totals.dueThisWeekCount += 1
      }
    } else {
      const paidOn = (item.paidAt ?? item.paymentDate ?? '').slice(0, 10)
      if (paidOn && item.amount != null) {
        const ago = -daysFrom(today, paidOn)
        if (ago >= 0 && ago <= 30) totals.paidLast30Cents += item.amount
      }
    }
  }
  return totals
}

export type VendorSourceFilter = 'ALL' | VendorPayableSource

export function filterBySource(items: readonly VendorPayable[], source: VendorSourceFilter): VendorPayable[] {
  return source === 'ALL' ? [...items] : items.filter((item) => item.source === source)
}

export function sourceCounts(items: readonly VendorPayable[]): Record<VendorSourceFilter, number> {
  const counts: Record<VendorSourceFilter, number> = { ALL: items.length, MAINTENANCE: 0, EMAIL: 0 }
  for (const item of items) counts[item.source] += 1
  return counts
}

export interface VendorGroup {
  /** Normalised key; '' for rows with no vendor. */
  key: string
  /** The spelling on the most recent bill, or "Unknown vendor". */
  vendor: string
  openCount: number
  owedCents: number
  overdueCount: number
  lastBillAt: string
}

/** One row per payee; spellings that normalise the same (case, punctuation, "Inc"/"LLC") merge. */
export function groupByVendor(items: readonly VendorPayable[], today: string): VendorGroup[] {
  const groups = new Map<string, VendorGroup>()
  for (const item of items) {
    const key = normVendor(item.vendor)
    const group = groups.get(key) ?? { key, vendor: UNKNOWN_VENDOR, openCount: 0, owedCents: 0, overdueCount: 0, lastBillAt: '' }
    if (item.receivedAt >= group.lastBillAt) {
      group.lastBillAt = item.receivedAt
      group.vendor = key === '' ? UNKNOWN_VENDOR : (item.vendor ?? '').trim() || UNKNOWN_VENDOR
    }
    if (isOpen(item)) {
      group.openCount += 1
      group.owedCents += item.amount ?? 0
      if (isOverdue(item, today)) group.overdueCount += 1
    }
    groups.set(key, group)
  }
  return [...groups.values()].sort(
    (a, b) => b.owedCents - a.owedCents || b.openCount - a.openCount || a.vendor.localeCompare(b.vendor),
  )
}
