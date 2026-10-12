/**
 * How far along a load's route the driver is, as a strip of stops with the truck between
 * them and a percent to completion.
 *
 * Two sources, used together when both exist: the stops the driver has tapped as done
 * (Ivan's drivers), and the truck's position (every truck with a gateway). Between two
 * stops, the truck's share of the leg comes from distance when both ends have
 * coordinates, by city at least; otherwise the truck sits at the last stop it left.
 * Owner operators do not tap stops, so for them position is the whole story.
 */
import type { Load, Stop } from '@/types'
import { getStops } from './stops'
import { airMiles, locateCity } from './eldRadius'
import { stopState, type StopState } from './driverSchedule'

export interface LatLng { lat: number; lng: number }

/** Within this many straight-line miles of a stop, the truck is at it. City coordinates are coarse, so generous. */
export const AT_STOP_MILES = 8

export interface RouteStop {
  id: string
  type: Stop['type']
  label: string
  city: string | null
  state: StopState
  appt: string | null
  etaAt: string | null
}

export interface RouteProgress {
  stops: RouteStop[]
  /** 0..100 along the whole route. */
  percent: number
  /** Position of the truck marker in stop units: 0 = at first stop, 1.5 = halfway to the second. */
  position: number
  /** Index of the next stop still to be worked, or null when the route is complete. */
  nextIndex: number | null
  /** Straight-line miles from the truck to the next stop, when both are known. */
  milesToNext: number | null
  complete: boolean
  /** How the position was decided. */
  basis: 'taps' | 'taps+location' | 'location' | 'none'
}

/** Coordinates for a stop: the stop's own, else its city. */
export function stopLatLng(stop: Pick<Stop, 'city'> & { address?: { lat?: number | null; lng?: number | null } | null }): LatLng | null {
  const a = stop.address
  if (a && typeof a.lat === 'number' && typeof a.lng === 'number') return { lat: a.lat, lng: a.lng }
  return locateCity(stop.city)
}

function clamp01(n: number): number { return Math.max(0, Math.min(1, n)) }

/** Fraction of the leg from `from` to `to` that the truck has covered, by distance. */
export function legFraction(truck: LatLng, from: LatLng, to: LatLng): number {
  const total = airMiles(from, to)
  if (total < 1) return 1
  return clamp01(1 - airMiles(truck, to) / total)
}

export function routeProgress(load: Load, truck: LatLng | null, opts: { useTaps?: boolean } = {}): RouteProgress | null {
  const raw = getStops(load)
  // getStops synthesises legacy stops for a load with none; a route with no places is no route.
  if (raw.length === 0 || raw.every((s) => !s.name?.trim() && !s.city?.trim())) return null
  return routeProgressForStops(raw, truck, opts)
}

/**
 * The same reading over any ordered list of stops: a day's run across several loads for
 * an Ivan driver, or one load's stops.
 */
export function routeProgressForStops(raw: readonly Stop[], truck: LatLng | null, opts: { useTaps?: boolean } = {}): RouteProgress | null {
  if (raw.length === 0) return null
  const useTaps = opts.useTaps !== false
  const stops: RouteStop[] = raw.map((s) => ({
    id: s.id, type: s.type, label: s.name?.trim() || s.city?.trim() || (s.type === 'delivery' ? 'Delivery' : 'Pickup'),
    city: s.city ?? null, state: useTaps ? stopState(s) : 'UPCOMING', appt: s.appt ?? null, etaAt: s.etaAt ?? null,
  }))
  const legs = Math.max(1, stops.length - 1)

  // Where the taps put the truck: after the last stop it left, at a stop it is on site at.
  let lastDone = -1
  let onSite = -1
  if (useTaps) {
    raw.forEach((s, i) => {
      if (s.departedAt) lastDone = i
      else if (s.arrivedAt && onSite === -1) onSite = i
    })
  }
  if (onSite >= 0) {
    const pos = onSite
    return { stops, percent: Math.round((pos / legs) * 100), position: pos, nextIndex: onSite, milesToNext: 0, complete: false, basis: 'taps' }
  }
  if (lastDone >= raw.length - 1) {
    return { stops, percent: 100, position: raw.length - 1, nextIndex: null, milesToNext: 0, complete: true, basis: 'taps' }
  }
  const nextIndex = lastDone + 1
  const prevIndex = lastDone   // -1 before the first stop

  // The truck parked at a stop still to come says more than a missed tap: a driver who
  // texted "here at delivery" instead of tapping is at the delivery, and the strip
  // should say so. Within AT_STOP_MILES of any untapped stop counts as being there.
  if (truck) {
    for (let i = nextIndex; i < raw.length; i += 1) {
      const at = stopLatLng(raw[i])
      if (at && airMiles(truck, at) <= AT_STOP_MILES) {
        const marked = stops.map((st, j) => (j === i ? { ...st, state: 'IN_PROGRESS' as StopState } : j < i && st.state === 'UPCOMING' ? { ...st, state: 'DONE' as StopState } : st))
        return { stops: marked, percent: Math.round((i / legs) * 100), position: i, nextIndex: i, milesToNext: 0, complete: false, basis: useTaps ? 'taps+location' : 'location' }
      }
    }
  }

  const next = stopLatLng(raw[nextIndex])
  const prev = prevIndex >= 0 ? stopLatLng(raw[prevIndex]) : null

  let fraction = 0
  let basis: RouteProgress['basis'] = useTaps ? 'taps' : 'none'
  let milesToNext: number | null = null
  if (truck && next) {
    milesToNext = Math.round(airMiles(truck, next))
    if (prev) {
      fraction = legFraction(truck, prev, next)
      basis = useTaps ? 'taps+location' : 'location'
    } else {
      // Nothing tapped yet (or an owner operator, who never taps): where the truck sits
      // between the first and last stops of the route is the honest reading, including
      // a driver past the pickup who never tapped it.
      const last = stopLatLng(raw[raw.length - 1])
      if (last && raw.length > 1) {
        const whole = legFraction(truck, next, last)
        return { stops, percent: Math.round(whole * 100), position: whole * legs, nextIndex: whole >= 0.999 ? null : nextIndex, milesToNext: Math.round(airMiles(truck, last)), complete: false, basis: 'location' }
      }
      basis = 'location'
    }
  }
  const position = prevIndex >= 0 ? prevIndex + fraction : 0
  const percent = Math.round((position / legs) * 100)
  return { stops, percent, position, nextIndex, milesToNext, complete: false, basis }
}

/**
 * The same strip for the driver app, where there is no truck position: today's stops in
 * order, the marker after the last one left (or at the one they are on site at).
 */
export function routeFromStops(stops: ReadonlyArray<{ id: string; type: string; name: string | null; city: string | null; appt: string | null; etaAt?: string | null; arrivedAt?: string | null; departedAt?: string | null }>): RouteProgress | null {
  if (stops.length === 0) return null
  const rs: RouteStop[] = stops.map((s) => ({
    id: s.id, type: (s.type.toLowerCase() === 'delivery' ? 'delivery' : 'pickup') as Stop['type'],
    label: s.name?.trim() || s.city?.trim() || (s.type.toLowerCase() === 'delivery' ? 'Delivery' : 'Pickup'),
    city: s.city, state: stopState(s), appt: s.appt, etaAt: s.etaAt ?? null,
  }))
  const legs = Math.max(1, rs.length - 1)
  const onSite = rs.findIndex((s) => s.state === 'IN_PROGRESS')
  let lastDone = -1
  rs.forEach((s, i) => { if (s.state === 'DONE') lastDone = i })
  if (onSite >= 0) return { stops: rs, percent: Math.round((onSite / legs) * 100), position: onSite, nextIndex: onSite, milesToNext: 0, complete: false, basis: 'taps' }
  if (lastDone >= rs.length - 1) return { stops: rs, percent: 100, position: rs.length - 1, nextIndex: null, milesToNext: 0, complete: true, basis: 'taps' }
  const position = Math.max(0, lastDone)
  return { stops: rs, percent: Math.round((position / legs) * 100), position, nextIndex: lastDone + 1, milesToNext: null, complete: false, basis: 'taps' }
}
