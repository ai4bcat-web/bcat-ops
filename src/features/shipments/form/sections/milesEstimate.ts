/**
 * Auto Customer Miles / Truck Miles (Ryne's feedback #2). Pure pieces: which stops can be
 * measured, the signature that tells the section the route changed, and the "did the person
 * override it" rule. The measuring itself is the GET_ROUTE_MILES action (`routeMilesApi.ts`).
 */
import type { FormStop } from '../model'

export interface RoutePointInput { address: string; lat?: number; lng?: number }

const STATE = /^[A-Za-z]{2}$/

/** One line a distance service can geocode: street, city, state zip. */
export function addressLine(s: FormStop): string {
  const cityState = [s.city.trim(), [s.state.trim(), s.zip.trim()].filter(Boolean).join(' ')].filter(Boolean).join(', ')
  return [s.address1.trim(), cityState].filter(Boolean).join(', ')
}

/** Every stop in order, or null when any stop lacks a city and two-letter state (nothing to measure yet). */
export function routePointsFromStops(stops: readonly FormStop[]): RoutePointInput[] | null {
  if (stops.length < 2) return null
  const points: RoutePointInput[] = []
  for (const s of stops) {
    if (!s.city.trim() || !STATE.test(s.state.trim())) return null
    const lat = s.geo?.lat
    const lng = s.geo?.lng
    points.push({
      address: addressLine(s),
      ...(typeof lat === 'number' && typeof lng === 'number' ? { lat, lng } : {}),
    })
  }
  return points
}

/** Stable string of the measurable route; '' = not measurable. The section reacts to this, not to the stops array. */
export function routeSignature(stops: readonly FormStop[]): string {
  const points = routePointsFromStops(stops)
  return points ? JSON.stringify(points) : ''
}

/**
 * A miles field may be overwritten by a fresh estimate only while it is blank or still holds the
 * last number we wrote ourselves; anything else was typed (or saved earlier) and stays.
 */
export function mayAutoFill(current: string, lastAuto: string): boolean {
  return current.trim() === '' || current === lastAuto
}
