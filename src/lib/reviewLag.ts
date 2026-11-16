/**
 * Delivery → Load review (Ryne 2026-11-15): how fast delivered loads are pushed into Load Review, week over week.
 *
 * Delivery date = when the freight was actually delivered (deliveredTimeOf), else the scheduled delivery
 * (the last delivery stop's appointment, or the end of its window). A load counts in the week (Monday–Sunday,
 * Chicago time) its Load Review push stamp falls in. A load released to billing without ever being pushed has no
 * push stamp and is left out of both the averages and "still waiting". The push stamp only exists since Load
 * Review launched, so earlier weeks have no data and read null (shown as "—"), never 0.
 */
import { chicagoDateStr } from './date'
import { deliveredTimeOf, type DeliveredFacts } from './deliveredAt'
import { isReleasedToInvoicing, type ListRow } from './shipmentLists'

export interface ReviewLagRow extends ListRow, Omit<DeliveredFacts, 'status'> {
  deliveryAppt?: string | null
  deliveryApptEnd?: string | null
  loadReviewPushedAt?: string | null
}

const DAY = 86_400_000

/** When the freight was (or was due to be) delivered; null with neither. */
export function deliveryDateOf(row: ReviewLagRow): string | null {
  const actual = deliveredTimeOf(row)
  if (actual) return actual
  const scheduled = [row.deliveryApptEnd, row.deliveryAppt].filter((v): v is string => !!v).sort()
  return scheduled.length ? scheduled[scheduled.length - 1] : null
}

function dayNum(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number)
  return Date.UTC(y, m - 1, d) / DAY
}

/** The Monday (YYYY-MM-DD, Chicago calendar) of the week an instant falls in. */
export function weekOf(iso: string | Date): string {
  const ymd = chicagoDateStr(iso)
  const n = dayNum(ymd)
  const dow = (new Date(n * DAY).getUTCDay() + 6) % 7 // Monday = 0
  return new Date((n - dow) * DAY).toISOString().slice(0, 10)
}

const live = (r: ReviewLagRow) => !r.voidedAt && !r.deletedAt && r.status !== 'CANCELED' && r.status !== 'DRAFT'

export interface WeekLag {
  /** Monday of the week. */
  week: string
  /** Average days from delivery to the push; null when nothing was pushed that week. */
  avgDays: number | null
  count: number
}

/** The last `weeks` weeks, oldest first, ending with the current week. */
export function weeklyReviewLag(rows: readonly ReviewLagRow[], nowMs: number, weeks = 8): WeekLag[] {
  const current = weekOf(new Date(nowMs))
  const keys = Array.from({ length: weeks }, (_, i) => new Date((dayNum(current) - 7 * (weeks - 1 - i)) * DAY).toISOString().slice(0, 10))
  const sums = new Map(keys.map((k) => [k, { total: 0, count: 0 }]))
  for (const r of rows) {
    if (!live(r) || !r.loadReviewPushedAt) continue
    const delivered = deliveryDateOf(r)
    if (!delivered) continue
    const slot = sums.get(weekOf(r.loadReviewPushedAt))
    if (!slot) continue
    slot.total += Math.max(0, (Date.parse(r.loadReviewPushedAt) - Date.parse(delivered)) / DAY)
    slot.count += 1
  }
  return keys.map((week) => {
    const s = sums.get(week)!
    return { week, count: s.count, avgDays: s.count > 0 ? s.total / s.count : null }
  })
}

/** Delivered (or past their delivery date) and not pushed into Load Review yet: how many, and how long on average. */
export function waitingForReview(rows: readonly ReviewLagRow[], nowMs: number): { count: number; avgDays: number | null } {
  let count = 0
  let total = 0
  for (const r of rows) {
    if (!live(r) || r.loadReviewPushedAt || isReleasedToInvoicing(r)) continue
    const delivered = deliveryDateOf(r)
    if (!delivered || Date.parse(delivered) > nowMs) continue
    count += 1
    total += (nowMs - Date.parse(delivered)) / DAY
  }
  return { count, avgDays: count > 0 ? total / count : null }
}
