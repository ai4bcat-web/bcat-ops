// Amazon pay periods run Sunday–Saturday. The driver portal stores a period as its
// Sunday (YYYY-MM-DD); rows from the old Google Form carry free text like "4/19 - 4/25".

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function addDays(d: Date, n: number): Date {
  const next = new Date(d)
  next.setDate(d.getDate() + n)
  next.setHours(0, 0, 0, 0)
  return next
}

export function toLocalDateString(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

const monthDay = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
const monthDayYear = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

/** "Sep 6 – Sep 12, 2026" for the Sunday–Saturday week starting at `start`. */
export function formatWeekLabel(start: Date): string {
  const end = addDays(start, 6)
  return start.getFullYear() === end.getFullYear()
    ? `${monthDay(start)} – ${monthDay(end)}, ${end.getFullYear()}`
    : `${monthDayYear(start)} – ${monthDayYear(end)}`
}

/** Week label for an ISO Sunday; any other stored value (legacy free text) is returned as-is. */
export function formatPayPeriod(value: string): string {
  if (!ISO_DATE.test(value)) return value
  const start = new Date(`${value}T00:00:00`)
  return Number.isNaN(start.getTime()) ? value : formatWeekLabel(start)
}

/**
 * Newest-period-first ordering for dispute lists. ISO Sundays compare by date;
 * legacy free text has no reliable year, so it sorts after every ISO period,
 * and a missing period sorts last. Ties fall through to the caller.
 */
export function comparePayPeriodDesc(a: string | null | undefined, b: string | null | undefined): number {
  const rank = (v: string | null | undefined) => (!v ? 0 : ISO_DATE.test(v) ? 2 : 1)
  const ra = rank(a)
  const rb = rank(b)
  if (ra !== rb) return rb - ra
  return ra === 2 ? b!.localeCompare(a!) : 0
}
