/**
 * Dispatch > GPS: where every driver is right now, and whether they are on a load or empty
 * (Ryne 2026-11-28). Pure: the page supplies drivers, loads, equipment and the truck fixes.
 *
 * Where a driver is: the last ELD fix of the truck on their file (same match as the
 * conversation list: by truck id or unit number, newest fix wins). A driver with no truck, or a
 * truck with no fix, is listed under "No GPS" with the reason, never dropped. A fix more than
 * NOT_REPORTING_MINUTES old gets no pin at all: the ELD has stopped reporting, so the driver is
 * listed under "Not reporting" with where they were last seen (Ryne 2026-11-28, Michael Bodle's
 * truck went quiet near Lake Charles and the pin sat there for three days).
 *
 * On a load: the driver has a live load they have started and not finished. Started = they
 * arrived at or left one of their pickups. Finished = every one of their deliveries has been
 * left. A load nobody has tapped on yet still counts once its first pickup time has passed and
 * its last delivery time is no more than SCHEDULE_GRACE_HOURS behind us (owner operators do not
 * tap stops), and the popup says "per schedule" so nobody mistakes it for a driver report.
 * Everything else is Empty.
 */
import type { Driver, Load, Stop } from '@/types'
import type { Equipment } from '@/types/equipment'
import type { TruckLocation } from '@/lib/apiClient'
import { driverIsOnLoad, laneLabel } from '@/lib/driverJourney'
import { getStops } from '@/lib/stops'
import { isUnitActive } from '@/lib/fleetActive'
import { placeOf } from './driverWhereabouts'

/** How long past its last delivery time an untapped load still counts as under way. */
export const SCHEDULE_GRACE_HOURS = 12
/** A fix older than this is drawn faded and called out as old. */
export const STALE_FIX_MINUTES = 180
/** A fix strictly older than this (24 hours) gets no pin: the truck is "Not reporting". */
export const NOT_REPORTING_MINUTES = 24 * 60

export type FixState = 'FRESH' | 'STALE' | 'NOT_REPORTING'
/** Fresh up to 3 h, faded up to and including 24 h, not reporting beyond that. */
export function fixState(ageMin: number): FixState {
  if (ageMin > NOT_REPORTING_MINUTES) return 'NOT_REPORTING'
  if (ageMin > STALE_FIX_MINUTES) return 'STALE'
  return 'FRESH'
}

export type GpsStatus = 'LOAD' | 'EMPTY'
/** Pin and legend colours: blue on a load, orange empty. */
export const GPS_COLOR = { LOAD: 'var(--tms-primary)', EMPTY: 'var(--tms-badge-orange)', NOT_REPORTING: 'var(--tms-muted)' } as const
export type GpsFilter = 'ALL' | GpsStatus | 'NOT_REPORTING'

export interface GpsLoadInfo {
  loadId: string
  pro: string
  lane: string
  /** 'stops' = the driver's own taps say so; 'schedule' = inferred from the appointment times. */
  basis: 'stops' | 'schedule'
}

export interface GpsDriver {
  driverId: string
  name: string
  truck: string | null
  status: GpsStatus
  load: GpsLoadInfo | null
  lat: number | null
  lng: number | null
  place: string | null
  locatedAt: string | null
  fixAgeMin: number | null
  stale: boolean
  /** The last fix is more than a day old: no pin, listed under "Not reporting". */
  notReporting: boolean
  moving: boolean | null
  /** Why a driver has no pin: only set when lat/lng are null. */
  noGpsReason: 'NO_TRUCK' | 'NO_FIX' | null
}

export interface GpsResult {
  /** Drivers with a fix of the last 24 hours: these get a pin. */
  located: GpsDriver[]
  /** Drivers whose last fix is more than 24 hours old: last known place only, no pin by default. */
  notReporting: GpsDriver[]
  noGps: GpsDriver[]
  counts: { onLoad: number; empty: number; notReporting: number; noGps: number; total: number }
}

/** Pin and dot colour of a row: grey when the truck is not reporting, else blue/orange by status. */
export const gpsPinColor = (d: Pick<GpsDriver, 'status' | 'notReporting'>): string =>
  d.notReporting ? GPS_COLOR.NOT_REPORTING : GPS_COLOR[d.status]

const HOUR = 3_600_000

const isDone = (s: Stop) => !!s.departedAt
const apptMs = (s: Stop): number | null => {
  const t = Date.parse(s.appt)
  return Number.isNaN(t) ? null : t
}

/** The driver's open work on this load, or null when they are not on it or it is finished. */
function startedOn(load: Load, driverId: string, now: number): GpsLoadInfo | null {
  if (!driverIsOnLoad(load, driverId)) return null
  const stops = getStops(load)
  const mine = stops.filter((s) => s.driverId === driverId)
  // Legacy loads carry the driver on the mirrored fields only: judge by the whole route.
  const mineStops = mine.length ? mine : stops
  const pickups = mineStops.filter((s) => s.type === 'pickup')
  const deliveries = mineStops.filter((s) => s.type === 'delivery')
  if (!deliveries.length) return null
  if (deliveries.every(isDone)) return null

  const info = (basis: GpsLoadInfo['basis']): GpsLoadInfo => ({
    loadId: load.id,
    pro: load.aljexId?.trim() || load.id.slice(0, 8),
    lane: laneLabel(load),
    basis,
  })

  const tapped = pickups.some((s) => !!s.arrivedAt || !!s.departedAt)
  if (tapped) return info('stops')

  // No taps at all anywhere on the load: lean on the schedule.
  const anyTap = mineStops.some((s) => !!s.arrivedAt || !!s.departedAt)
  if (anyTap) return null
  const firstPickup = pickups.map(apptMs).filter((n): n is number => n != null).sort((a, b) => a - b)[0]
  const lastDelivery = deliveries.map(apptMs).filter((n): n is number => n != null).sort((a, b) => b - a)[0]
  if (firstPickup == null || lastDelivery == null) return null
  if (firstPickup <= now && lastDelivery + SCHEDULE_GRACE_HOURS * HOUR >= now) return info('schedule')
  return null
}

/** The driver's current load: the one under way, soonest delivery first when two overlap. */
export function currentOpenLoad(loads: readonly Load[], driverId: string, now: number): GpsLoadInfo | null {
  let best: { info: GpsLoadInfo; at: number } | null = null
  for (const load of loads) {
    const info = startedOn(load, driverId, now)
    if (!info) continue
    const next = getStops(load)
      .filter((s) => s.type === 'delivery' && !isDone(s))
      .map(apptMs)
      .filter((n): n is number => n != null)
      .sort((a, b) => a - b)[0] ?? Number.MAX_SAFE_INTEGER
    if (!best || next < best.at) best = { info, at: next }
  }
  return best?.info ?? null
}

const finite = (n: number) => Number.isFinite(n)

export function computeGps(input: {
  drivers: readonly Driver[]
  loads: readonly Load[]
  equipment: readonly Pick<Equipment, 'id' | 'unitNumber'>[]
  locations: readonly TruckLocation[]
  now: number
}): GpsResult {
  const { drivers, loads, equipment, locations, now } = input
  const located: GpsDriver[] = []
  const notReporting: GpsDriver[] = []
  const noGps: GpsDriver[] = []

  for (const driver of drivers) {
    if (driver.active === false) continue
    const truck = driver.assignedTruckId ? equipment.find((e) => e.id === driver.assignedTruckId) : undefined
    // A retired truck on a driver's file is no truck.
    const truckOk = truck && isUnitActive(truck as Equipment)
    const loc = truckOk
      ? locations
          .filter((l) => l.truckId === truck.id || l.unitNumber === String(truck.unitNumber))
          .sort((a, b) => (a.locatedAt < b.locatedAt ? 1 : -1))[0]
      : undefined
    const load = currentOpenLoad(loads, driver.id, now)
    const hasFix = !!loc && finite(loc.lat) && finite(loc.lon)
    const ageMin = loc ? Math.max(0, Math.round((now - Date.parse(loc.locatedAt)) / 60_000)) : null
    const age = hasFix && ageMin != null && !Number.isNaN(ageMin) ? ageMin : null
    const state = age == null ? 'FRESH' : fixState(age)
    const row: GpsDriver = {
      driverId: driver.id,
      name: driver.name,
      truck: truck ? String(truck.unitNumber) : null,
      status: load ? 'LOAD' : 'EMPTY',
      load,
      lat: hasFix ? (loc as TruckLocation).lat : null,
      lng: hasFix ? (loc as TruckLocation).lon : null,
      place: hasFix ? placeOf(loc) : null,
      locatedAt: hasFix ? (loc as TruckLocation).locatedAt : null,
      fixAgeMin: age,
      stale: state !== 'FRESH',
      notReporting: state === 'NOT_REPORTING',
      moving: hasFix ? movingOf(loc as TruckLocation) : null,
      noGpsReason: hasFix ? null : truckOk ? 'NO_FIX' : 'NO_TRUCK',
    }
    ;(!hasFix ? noGps : row.notReporting ? notReporting : located).push(row)
  }

  const byName = (a: GpsDriver, b: GpsDriver) => a.name.localeCompare(b.name)
  located.sort(byName)
  notReporting.sort(byName)
  noGps.sort(byName)
  const onLoad = located.filter((r) => r.status === 'LOAD').length
  const emptyN = located.length - onLoad
  return {
    located, notReporting, noGps,
    counts: { onLoad, empty: emptyN, notReporting: notReporting.length, noGps: noGps.length, total: located.length + notReporting.length + noGps.length },
  }
}

function movingOf(loc: TruckLocation): boolean | null {
  const m = (loc.motion ?? '').toLowerCase()
  if (m === 'moving' || m === 'driving') return true
  if (m === 'stationary' || m === 'stopped') return false
  if (typeof loc.speed === 'number') return loc.speed > 1
  return null
}

/** The pinned rows to show for a filter. "Not reporting" has no pinned rows: those drivers live in their own panel. */
export function filterGps(rows: readonly GpsDriver[], filter: GpsFilter): GpsDriver[] {
  if (filter === 'ALL') return [...rows]
  if (filter === 'NOT_REPORTING') return []
  return rows.filter((r) => r.status === filter)
}

/** "12 on a load · 5 empty" (the pinned trucks), then the not-reporting and no-GPS counts when there are any. */
export function gpsCountsLine(c: GpsResult['counts']): string {
  let line = `${c.onLoad} on a load · ${c.empty} empty`
  if (c.notReporting) line += ` · ${c.notReporting} not reporting`
  if (c.noGps) line += ` · ${c.noGps} no GPS`
  return line
}

/** "Last seen 3 d ago near Lake Charles, LA" (the place part is left out when there is none). */
export function lastSeenText(d: Pick<GpsDriver, 'fixAgeMin' | 'place'>): string {
  const when = `last seen ${ageText(d.fixAgeMin)}`
  return d.place ? `${when} near ${d.place}` : when
}

/** "5 min ago", "3 h ago", "2 d ago". */
export function ageText(min: number | null): string {
  if (min == null) return 'unknown'
  if (min < 2) return 'just now'
  if (min < 90) return `${min} min ago`
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`
  return `${Math.round(min / 1440)} d ago`
}

export const NO_GPS_TEXT: Record<NonNullable<GpsDriver['noGpsReason']>, string> = {
  NO_TRUCK: 'No truck on file',
  NO_FIX: 'Truck has no GPS fix',
}
