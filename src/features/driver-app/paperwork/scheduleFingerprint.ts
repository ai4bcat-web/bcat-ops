/**
 * Whether the day's sheet changed under the driver.
 *
 * Dispatch moves loads, swaps drivers and changes times while the driver is out on the
 * day. The app re-reads the week quietly and compares this fingerprint of the day on
 * screen: the stops, who they belong to, their times and their order. The driver's own
 * taps (arrived, departed, POD) are deliberately not in it — those the app already knows.
 */
import type { PaperworkLoad } from '../driverApi'

export function scheduleFingerprint(loads: readonly PaperworkLoad[], day: string): string {
  const parts: string[] = []
  for (const load of loads) {
    for (const stop of load.stops) {
      if (stop.date !== day || !stop.yours) continue
      parts.push([load.id, stop.id, stop.type, stop.appt ?? '', stop.apptType ?? '', stop.name ?? '', stop.city ?? '', String(stop.sequence), String(load.sortOrder ?? '')].join('|'))
    }
  }
  return parts.sort().join('\n')
}

/** How often the sheet is re-read while the app is on screen. */
export const SCHEDULE_CHECK_MS = 2 * 60_000

/** A buzz and, where the driver allowed it, a system notification — the phone is usually in a cradle. */
export function announceScheduleChange(): void {
  try { if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate([150, 80, 150]) } catch { /* not supported */ }
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification('Your schedule changed', { body: 'Dispatch updated today’s loads. Open the app and tap Refresh.', tag: 'bcat-schedule' })
    }
  } catch { /* not supported */ }
}
