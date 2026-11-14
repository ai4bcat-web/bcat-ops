/**
 * The Pending with OTR and OTR rejected cards on Invoicing → Factored (Ryne 2026-11-14). Pure:
 * the page passes the queue rows it already holds.
 *
 * Rejection dates: a queue row carries no "rejected at", so "the last 30 days" reads the row's
 * last change (`updatedAt`) — the sync or the refusal that put it there. "Moved to manual this
 * month" counts the rows Move to manual invoice archived this month: that action archives the
 * row and writes the customer's change (billing method + reason) in the same step, so it is the
 * same set as the customer History entries, without reading the audit log.
 */
import type { FactoringItem } from '@/types'
import { isOtrRejected, otrRejection, otrRejectionReason } from '@/lib/otrRejection'
import { invoiceAmountOf } from './factoringTotals'

const DAY_MS = 86_400_000
const dayNum = (iso: string | null | undefined): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '')
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS : null
}

/** Dollars on the invoice: what readiness assembled, else what was sent to OTR. */
export const amountOf = (item: FactoringItem): number => invoiceAmountOf(item) ?? item.otrAmount ?? 0

export interface PendingOtrStats {
  count: number
  dollars: number
  avgDaysWaiting: number | null
  oldest: { proNumber: string; days: number } | null
}

export function pendingOtrStats(items: readonly FactoringItem[], asOf: string): PendingOtrStats {
  const today = dayNum(asOf) ?? 0
  const pending = items.filter((i) => i.status === 'PENDING_WITH_OTR')
  const waits: number[] = []
  let oldest: PendingOtrStats['oldest'] = null
  for (const i of pending) {
    const from = dayNum(i.otrSubmittedAt)
    if (from == null) continue
    const d = Math.max(0, today - from)
    waits.push(d)
    if (!oldest || d > oldest.days) oldest = { proNumber: i.proNumber, days: d }
  }
  return {
    count: pending.length,
    dollars: pending.reduce((s, i) => s + amountOf(i), 0),
    avgDaysWaiting: waits.length ? Math.round((waits.reduce((a, b) => a + b, 0) / waits.length) * 10) / 10 : null,
    oldest,
  }
}

export interface OtrRejectedStats {
  count: number
  dollars: number
  /** The three commonest reasons among rows that changed in the last 30 days. */
  topReasons: { reason: string; count: number }[]
  movedToManual: { count: number; customers: string[] }
}

/** "OTR refused it: Invalid PO 123" and "… Invalid PO 456" count as one reason. */
function reasonKey(reason: string): string {
  return reason.replace(/\s+#?\d[\d,.-]*/g, ' #').replace(/\s+/g, ' ').trim().slice(0, 90)
}

export function otrRejectedStats(items: readonly FactoringItem[], asOf: string, customerName: (item: FactoringItem) => string): OtrRejectedStats {
  const today = dayNum(asOf) ?? 0
  const rejected = items.filter((i) => isOtrRejected(i))
  const counts = new Map<string, number>()
  for (const i of rejected) {
    const changed = dayNum(i.updatedAt)
    if (changed == null || today - changed > 30) continue
    const r = otrRejection(i)
    if (!r) continue
    const key = reasonKey(r.reason)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const month = asOf.slice(0, 7)
  const moved = items.filter((i) => i.status === 'ARCHIVED' && (i.updatedAt ?? '').slice(0, 7) === month && otrRejectionReason(i) != null)
  return {
    count: rejected.length,
    dollars: rejected.reduce((s, i) => s + amountOf(i), 0),
    topReasons: [...counts.entries()].map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)).slice(0, 3),
    movedToManual: {
      count: moved.length,
      customers: [...new Set(moved.map((i) => customerName(i)).filter(Boolean))].sort(),
    },
  }
}
