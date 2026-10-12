/**
 * Ordering a day's stops by appointment, where "no time" means last.
 *
 * A first-come-first-served stop, or one entered with a date and no time, is stored at
 * midnight Chicago. Sorted as a plain timestamp it jumps ahead of every timed stop of the
 * day — Zak saw a Carlyn FCFS pickup listed before his 7 AM Amazon delivery. The driver
 * runs the timed appointments first and fits the open ones around them, so the key here
 * puts an untimed stop after everything timed on its day while keeping days in order.
 */
export interface ApptLike {
  appt?: string | null
  apptType?: string | null
}

function chicagoClock(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour12: false, hour: '2-digit', minute: '2-digit' })
}

/** True for a stop with a date but no real time: FCFS, or stored at local midnight. */
export function isUntimedAppt(stop: ApptLike): boolean {
  const iso = (stop.appt ?? '').trim()
  if (!iso || Number.isNaN(Date.parse(iso))) return true
  if ((stop.apptType ?? '').toLowerCase() === 'fcfs') return true
  const clock = chicagoClock(iso)
  return clock === '00:00' || clock === '24:00'
}

/**
 * Sortable string: timed stops by their ISO, untimed ones after any time on that day, no
 * date at all last. Digits only after the date, so plain and locale-aware sorts agree
 * (ICU collates punctuation before letters, which is how a '~' key once sorted FIRST).
 */
export function apptSortKey(stop: ApptLike): string {
  const iso = (stop.appt ?? '').trim()
  if (!iso || Number.isNaN(Date.parse(iso))) return '9999-99-99T99:99:99'
  if (!isUntimedAppt(stop)) return iso
  // The Chicago calendar day at a time no real stop has: after every timed stop that day.
  const day = new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' })
  return `${day}T99:99:99`
}
