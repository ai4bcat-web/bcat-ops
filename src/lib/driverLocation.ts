/**
 * Where a driver is right now, for the Dashboard's driver leaderboard. Pure: the page supplies the
 * drivers, loads, equipment and the truck locations the ELD sync already keeps.
 *
 * Order of trust:
 *   1. the truck's ELD fix (Motive / BlueInk), as a city: "Gary, IN", with how old the fix is;
 *   2. the last facility event THIS driver reported (arrived / departed a stop): "last stop";
 *   3. nothing: the driver has no truck on file and has not reported a stop.
 *
 * The driver app does not store GPS pings of its own, so there is no rung for them.
 */
import type { Driver, Load } from '@/types'
import type { Equipment } from '@/types/equipment'
import type { TruckLocation } from '@/lib/apiClient'
import { canonicalUnit } from '@/lib/fleetGroups'
import { CITY_COORDS } from '@/lib/cityCoords'
import { lastStopEventForDriver } from '@/lib/driverSchedule'

export type LocationSource = 'ELD' | 'LAST_STOP'
/** MOVING / STOPPED come from the ELD; STALE is an ELD fix too old to trust as "now". */
export type LocationState = 'MOVING' | 'STOPPED' | 'STALE' | 'LAST_STOP'

export interface DriverLocation {
  /** "Gary, IN". An approximate one starts with "near ". */
  place: string
  source: LocationSource
  state: LocationState
  /** Minutes since the fix or the stop event. */
  ageMin: number
  /** ISO time of the fix or event. */
  at: string
  /** The place was worked out from coordinates, to the nearest city the app knows. */
  approximate: boolean
}

/** An ELD fix older than this no longer says where the truck is. The cron runs every 10 minutes. */
export const STALE_FIX_MIN = 120

const titleCase = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase())
/** "GARY, IN" -> "Gary, IN": the state stays upper-case. */
function prettyCity(key: string): string {
  const [city, state] = key.split(',').map((p) => p.trim())
  return state ? `${titleCase(city)}, ${state.toUpperCase()}` : titleCase(city)
}

const toRad = (d: number) => (d * Math.PI) / 180
/** Great-circle miles. */
function miles(a: [number, number], b: [number, number]): number {
  const dLat = toRad(b[0] - a[0])
  const dLon = toRad(b[1] - a[1])
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2
  return 3958.8 * 2 * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** The nearest city in the app's table of ~230 hauled-to cities, with how far away it is. */
export function nearestKnownCity(lat: number, lon: number): { place: string; miles: number } | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  let best: { key: string; miles: number } | null = null
  for (const [key, coords] of Object.entries(CITY_COORDS)) {
    const d = miles([lat, lon], coords)
    if (!best || d < best.miles) best = { key, miles: d }
  }
  return best ? { place: prettyCity(best.key), miles: best.miles } : null
}

/** "City, ST" out of a Motive description ("12.3 mi NE of Gary, IN"), else null. */
function placeFromDescription(desc: string | null | undefined): string | null {
  if (!desc) return null
  const i = desc.lastIndexOf(' of ')
  const place = (i >= 0 ? desc.slice(i + 4) : desc).trim()
  return place || null
}

/** The truck's freshest fix: matched by truck id or by the (canonical) unit number. */
function fixFor(truck: Pick<Equipment, 'id' | 'unitNumber'>, locations: readonly TruckLocation[]): TruckLocation | null {
  const unit = canonicalUnit(String(truck.unitNumber))
  return (
    locations
      .filter((l) => l.truckId === truck.id || canonicalUnit(String(l.unitNumber)) === unit)
      .sort((a, b) => (a.locatedAt < b.locatedAt ? 1 : -1))[0] ?? null
  )
}

const minutesSince = (iso: string, nowMs: number) => Math.max(0, Math.round((nowMs - new Date(iso).getTime()) / 60_000))
const validTime = (iso: string | null | undefined): iso is string => !!iso && !Number.isNaN(Date.parse(iso))

export function driverLocationOf(
  driver: Pick<Driver, 'id' | 'assignedTruckId'> | null | undefined,
  loads: readonly Load[],
  equipment: readonly Pick<Equipment, 'id' | 'unitNumber'>[],
  locations: readonly TruckLocation[],
  nowMs: number,
): DriverLocation | null {
  if (!driver) return null
  const lastStop = lastStopEventForDriver(loads, driver.id)

  const truck = driver.assignedTruckId ? equipment.find((e) => e.id === driver.assignedTruckId) : undefined
  const fix = truck ? fixFor(truck, locations) : null
  if (fix && validTime(fix.locatedAt)) {
    const ageMin = minutesSince(fix.locatedAt, nowMs)
    const fromDesc = placeFromDescription(fix.description)
    const near = fromDesc ? null : nearestKnownCity(fix.lat, fix.lon)
    const place = fromDesc ?? (near ? `near ${near.place}` : null)
    // A fix too old to be "now" gives way to a driver event that is newer than it.
    const stale = ageMin > STALE_FIX_MIN
    const stopIsNewer = !!lastStop && lastStop.at > fix.locatedAt && !!lastStop.city
    if (place && !(stale && stopIsNewer)) {
      return {
        place,
        source: 'ELD',
        state: stale ? 'STALE' : fix.motion === 'MOVING' ? 'MOVING' : 'STOPPED',
        ageMin,
        at: fix.locatedAt,
        approximate: !fromDesc,
      }
    }
  }

  if (lastStop && (lastStop.city || lastStop.stopName)) {
    return {
      place: lastStop.city ?? (lastStop.stopName as string),
      source: 'LAST_STOP',
      state: 'LAST_STOP',
      ageMin: minutesSince(lastStop.at, nowMs),
      at: lastStop.at,
      approximate: false,
    }
  }
  return null
}

/** "just now" / "4 min ago" / "3 h ago" / "2 d ago". */
export function ageLabel(ageMin: number): string {
  if (ageMin < 2) return 'just now'
  if (ageMin < 60) return `${ageMin} min ago`
  if (ageMin < 60 * 48) return `${Math.round(ageMin / 60)} h ago`
  return `${Math.round(ageMin / 1440)} d ago`
}

/** Hover text: the exact time, the source, and a note when the place was worked out from coordinates. */
export function locationTitle(loc: DriverLocation): string {
  const when = new Date(loc.at).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  const source = loc.source === 'ELD' ? 'Truck GPS/ELD' : 'Last stop the driver reported'
  const motion = loc.state === 'MOVING' ? ' · moving' : loc.state === 'STOPPED' ? ' · stopped' : loc.state === 'STALE' ? ' · signal is old' : ''
  return `${loc.place} · ${source} · ${when} Central${motion}${loc.approximate ? ' · nearest known city' : ''}`
}

/** The muted part of a location: the age, and "last stop" first when it is not a live fix. */
export function locationSubtext(loc: DriverLocation): string {
  return loc.source === 'LAST_STOP' ? `last stop · ${ageLabel(loc.ageMin)}` : ageLabel(loc.ageMin)
}
