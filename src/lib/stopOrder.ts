/**
 * Stop appointments run forwards: a later stop may not be booked before the stop ahead
 * of it. One exception (Ryne, 2026-11-13): when either stop is first-come-first-served,
 * the two windows can overlap on the same day (a 6am–3pm FCFS delivery after a 7am
 * pickup). An earlier *day* is still refused — that is a typo, not a window.
 *
 * Shared by the shipment form (local `YYYY-MM-DDTHH:mm` input values) and
 * tms-shipment-actions (ISO UTC instants).
 */

const FCFS = /\bfcfs\b/i

export interface StopOrderInput {
  appt?: string | null
  apptType?: string | null
  hours?: string | null
  contact?: { hours?: unknown } | null
}

/** FCFS from the appointment type or the stop's hours text ("FCFS 06:00 TO 15:00"). */
export function isFcfsStop(s: StopOrderInput): boolean {
  if ((s.apptType ?? '').toLowerCase() === 'fcfs') return true
  const contactHours = typeof s.contact?.hours === 'string' ? s.contact.hours : ''
  return FCFS.test(s.hours ?? '') || FCFS.test(contactHours)
}

const CHICAGO_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
})

/**
 * Calendar day of an appointment. An instant with a zone (`Z` / `±hh:mm`) is read in
 * America/Chicago so an evening time doesn't roll into tomorrow; a zone-less wall-clock
 * value (the form's datetime-local input) is already local, so its date part is the day.
 */
export function apptDay(value: string): string | null {
  const v = value.trim()
  if (!v) return null
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(v)) {
    const t = Date.parse(v)
    return Number.isFinite(t) ? CHICAGO_DAY.format(new Date(t)) : null
  }
  return /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null
}

function instant(value: string): number {
  const v = value.trim()
  // Zone-less wall-clock values compare as strings of the same shape; parse them as UTC
  // so both sides of a pair move together.
  return Date.parse(/(Z|[+-]\d{2}:?\d{2})$/i.test(v) ? v : `${v.length === 10 ? `${v}T00:00` : v}Z`)
}

/** True when `next` is booked before `prev` in a way the order rule refuses. */
export function stopsOutOfOrder(prev: StopOrderInput, next: StopOrderInput): boolean {
  if (!prev.appt || !next.appt) return false
  const a = instant(prev.appt)
  const b = instant(next.appt)
  if (!Number.isFinite(a) || !Number.isFinite(b) || b >= a) return false
  if (isFcfsStop(prev) || isFcfsStop(next)) {
    const da = apptDay(prev.appt)
    const db = apptDay(next.appt)
    if (da && db && db >= da) return false
  }
  return true
}
