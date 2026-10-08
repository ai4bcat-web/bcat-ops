/**
 * Which recent runs left the 150 air-mile radius — the ones that needed ELD logs — and
 * whether somebody confirmed the logs were kept.
 *
 * The same rule the driver app shows the driver (src/lib/eldRadius.ts), run over the
 * office's loads so the fleet manager sees the other side of it: every run in the window
 * that required logs, who drove it, and a tick for "logs handled" that records who
 * ticked it and when. UNKNOWN (a stop that could not be placed) is listed too — the point
 * of surfacing it is that somebody looks.
 *
 * Pure: loads in, rows out; the clock is passed in.
 */
import { assessEld, type EldStatus } from './eldRadius'
import { getStops } from './stops'
import { lastApptAt } from './driverJourney'
import { chicagoDateStr } from './date'
import type { Load, Stop } from '../types'

export interface EldRunRow {
  load: Load
  /** Who drove it: the delivery stop's driver, else the first driver on the load. */
  driverId: string | null
  /** The Chicago calendar day of the run's last appointment. */
  day: string
  status: Exclude<EldStatus, 'NOT_REQUIRED'>
  farthestMiles: number | null
  farthestCity: string | null
  unplaceable: string[]
  reviewed: { at: string; by: string | null } | null
}

/** The cities the ELD rule is judged on — the same inputs the driver app uses. */
export function eldCitiesOf(load: Load): Array<string | null | undefined> {
  const stops = getStops(load) as Stop[]
  return [
    ...stops.map((s) => (s.address?.city && s.address?.state ? `${s.address.city}, ${s.address.state}` : s.city)),
    load.originCity,
    load.destinationCity,
  ]
}

export function driverOfRun(load: Load): string | null {
  const stops = getStops(load) as Stop[]
  const delivery = [...stops].reverse().find((s) => s.type === 'delivery' && s.driverId)
  return delivery?.driverId ?? stops.find((s) => s.driverId)?.driverId ?? load.deliveryDriverId ?? load.pickupDriverId ?? null
}

/** Runs in the last `sinceDays` days (inclusive of today) that needed, or may have needed, logs. Newest first. */
export function eldRunsOutsideRadius(loads: Load[], opts: { sinceDays: number; now: Date }): EldRunRow[] {
  const today = chicagoDateStr(opts.now)
  const from = chicagoDateStr(new Date(opts.now.getTime() - (opts.sinceDays - 1) * 86_400_000))
  const out: EldRunRow[] = []
  for (const load of loads) {
    const last = lastApptAt(load)
    const day = last ? chicagoDateStr(last) : ''
    if (!day || day < from || day > today) continue
    const a = assessEld(eldCitiesOf(load))
    if (a.status === 'NOT_REQUIRED') continue
    out.push({
      load,
      driverId: driverOfRun(load),
      day,
      status: a.status,
      farthestMiles: a.farthestMiles,
      farthestCity: a.farthestCity,
      unplaceable: a.unplaceable,
      reviewed: load.eldLogsReviewedAt ? { at: load.eldLogsReviewedAt, by: load.eldLogsReviewedBy ?? null } : null,
    })
  }
  return out.sort((x, y) => y.day.localeCompare(x.day) || (y.farthestMiles ?? 0) - (x.farthestMiles ?? 0))
}
