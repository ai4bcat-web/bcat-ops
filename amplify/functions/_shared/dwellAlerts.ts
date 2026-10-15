/**
 * A driver who has sat at a stop too long.
 *
 * On site at a pickup and not departed, or on site at a delivery and not delivered, for
 * two hours: a note lands in the driver's dispatch conversation (internal — the driver is
 * not texted) so whoever is watching the board can call. Once per stop: the stop records
 * that it was flagged, so the five-minute sweep never says it twice.
 */
import type { Load, Stop } from '../../../src/types'
import { getStops } from '../../../src/lib/stops'

export const DWELL_ALERT_MIN = 120

export interface DwellAlert {
  load: Load
  stop: Stop
  driverId: string
  /** Minutes on site when the sweep noticed. */
  minutes: number
  text: string
}

/** Every stop on these loads that is overdue and not yet flagged. */
export function dwellAlerts(loads: readonly Load[], nowMs: number): DwellAlert[] {
  const out: DwellAlert[] = []
  for (const load of loads) {
    for (const stop of getStops(load)) {
      if (!stop.arrivedAt || stop.departedAt || !stop.driverId) continue
      if ((stop as Stop & { dwellAlertedAt?: string | null }).dwellAlertedAt) continue
      const at = Date.parse(stop.arrivedAt)
      if (Number.isNaN(at)) continue
      const minutes = Math.floor((nowMs - at) / 60_000)
      if (minutes < DWELL_ALERT_MIN) continue
      const place = [stop.name?.trim(), stop.city?.trim()].filter(Boolean).join(', ')
      const pro = (load.aljexId ?? '').trim()
      const hours = (minutes / 60).toFixed(1).replace(/\.0$/, '')
      const text = stop.type === 'delivery'
        ? `⏱ On site at delivery ${hours} h and not marked delivered${place ? ` · ${place}` : ''}${pro ? ` · PRO ${pro}` : ''} — check on the driver, and ask for the POD.`
        : `⏱ On site at pickup ${hours} h and not departed${place ? ` · ${place}` : ''}${pro ? ` · PRO ${pro}` : ''} — check on the driver; detention may apply.`
      out.push({ load, stop, driverId: stop.driverId, minutes, text })
    }
  }
  return out
}

/** The load's stops with this one marked as flagged, so it is never flagged again. */
export function markDwellAlerted(load: Load, stopId: string, atIso: string): Stop[] {
  return getStops(load).map((s) => (s.id === stopId ? { ...s, dwellAlertedAt: atIso } as Stop : s))
}
