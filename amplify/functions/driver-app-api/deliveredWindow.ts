/**
 * What a driver may see: loads delivered up to and including today. Never future work.
 *
 * A driver's page is a record of what they have run, and a load scheduled for Friday is
 * not that. On a settlement it would read as pay already earned; on the paperwork page it
 * would ask for a POD for a delivery that has not happened. Both are wrong in the same
 * way, so the rule lives here once and both endpoints call it.
 *
 * NOTE on "delivered": there is no delivery event anywhere in the data — no load carries a
 * status, and no stop carries an arrival or departure. So "delivered" can only mean the
 * delivery APPOINTMENT date is today or earlier. A load appointed for later today counts,
 * because the alternative is a driver who delivered at 08:00 not seeing it until tomorrow.
 *
 * Staff pages deliberately do NOT use this: dispatch books ahead and has to see it.
 */

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** The first day a driver may NOT see — tomorrow, as a bare YYYY-MM-DD. */
export function firstHiddenDay(now: Date): string {
  return addDays(now.toISOString().slice(0, 10), 1)
}

/**
 * Exclusive upper bound for a week query: the end of the pay week, or tomorrow, whichever
 * comes first. A past week is unaffected; the week in progress stops at today.
 *
 * Compared as bare dates against a full ISO timestamp, which works because
 * '2026-10-05T18:00:00.000Z' sorts after '2026-10-05' and before '2026-10-06'.
 */
export function deliveredWindowEnd(periodStart: string, now: Date): string {
  const weekEndEx = addDays(periodStart, 7)
  const tomorrow = firstHiddenDay(now)
  return weekEndEx < tomorrow ? weekEndEx : tomorrow
}

/** True when this delivery is one the driver may see. */
export function isDeliveredByNow(deliveryAppt: string | null | undefined, now: Date): boolean {
  const appt = (deliveryAppt ?? '').slice(0, 10)
  return !!appt && appt < firstHiddenDay(now)
}
