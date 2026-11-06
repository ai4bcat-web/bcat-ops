/**
 * Which stops each carrier of a load covers, and how far along each one is.
 *
 * `LoadCarrier.legStopIds` names `Stop.id`s of the load. Empty or absent = ALL stops
 * (AT-plan D9): two carriers with no legs are split freight, both on the whole
 * route. Legs only narrow. Stops keep their route order; order is never stored.
 * A stop covered by nobody is a warning, never a block; a shared stop (transload)
 * is allowed.
 *
 * Imports are relative: the Lambdas and the browser share this file.
 */
import type { LoadCarrierRecord } from '../types/tms'

/** The stop fields these helpers read; `Stop` from types/index is assignable. */
export interface LegStop {
  id: string
  sequence?: number | null
  arrivedAt?: string | null
  departedAt?: string | null
}

type LegCarrier = Pick<LoadCarrierRecord, 'id' | 'legStopIds'> & Partial<Pick<LoadCarrierRecord, 'carrierName'>>

export type CarrierPhase = 'NOT_STARTED' | 'AT_PICKUP' | 'IN_TRANSIT' | 'AT_DELIVERY' | 'DONE'

function inRouteOrder<S extends LegStop>(stops: readonly S[]): S[] {
  return stops.slice().sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
}

/** The stops this carrier covers, in route order. Empty/absent legs = every stop. */
export function legStopsOf<S extends LegStop>(loadCarrier: Pick<LoadCarrierRecord, 'legStopIds'>, stops: readonly S[]): S[] {
  const ordered = inRouteOrder(stops)
  const ids = loadCarrier.legStopIds
  if (!ids || ids.length === 0) return ordered
  return ordered.filter((stop) => ids.includes(stop.id))
}

export interface LegValidation {
  errors: string[]
  warnings: string[]
}

/**
 * Unknown stop ids are errors. A stop no carrier covers is a warning (only checked
 * when at least one carrier narrowed its legs; with all-stops carriers every stop is
 * covered). Shared stops are fine.
 */
export function validateLegs(carriers: readonly LegCarrier[], stops: readonly LegStop[]): LegValidation {
  const errors: string[] = []
  const warnings: string[] = []
  const known = new Set(stops.map((stop) => stop.id))
  for (const lc of carriers) {
    const unknown = (lc.legStopIds ?? []).filter((id) => !known.has(id))
    if (unknown.length > 0) {
      errors.push(`${lc.carrierName?.trim() || 'Carrier'}: unknown stop ${unknown.join(', ')}`)
    }
  }
  if (errors.length === 0 && carriers.length > 0) {
    const covered = new Set<string>()
    for (const lc of carriers) for (const stop of legStopsOf(lc, stops)) covered.add(stop.id)
    inRouteOrder(stops).forEach((stop, index) => {
      if (!covered.has(stop.id)) warnings.push(`Stop ${index + 1} is not covered by any carrier`)
    })
  }
  return { errors, warnings }
}

/**
 * NOT_STARTED (nothing arrived), AT_PICKUP (at the first covered stop),
 * AT_DELIVERY (at the last covered stop), IN_TRANSIT (between), DONE (every covered
 * stop departed). A carrier covering a single stop is AT_PICKUP while there.
 */
export function carrierPhase(loadCarrier: Pick<LoadCarrierRecord, 'legStopIds'>, stops: readonly LegStop[]): CarrierPhase {
  const covered = legStopsOf(loadCarrier, stops)
  if (covered.length === 0) return 'NOT_STARTED'
  if (covered.every((stop) => stop.departedAt)) return 'DONE'
  const last = covered.length - 1
  const here = covered.findIndex((stop) => stop.arrivedAt && !stop.departedAt)
  if (here >= 0) return here === 0 ? 'AT_PICKUP' : here === last ? 'AT_DELIVERY' : 'IN_TRANSIT'
  return covered.some((stop) => stop.departedAt) ? 'IN_TRANSIT' : 'NOT_STARTED'
}

/**
 * The carrier whose legs hold the earliest un-departed stop of the route — who is
 * moving the freight now. Null when every stop has departed or there are no carriers.
 * `now` is accepted for the caller's clock; the answer rests on recorded events only.
 */
export function coveringCarrier<C extends LegCarrier>(
  carriers: readonly C[],
  stops: readonly LegStop[],
  _now?: Date | number | string,
): C | null {
  for (const stop of inRouteOrder(stops)) {
    if (stop.departedAt) continue
    const holder = carriers.find((lc) => legStopsOf(lc, stops).some((s) => s.id === stop.id))
    if (holder) return holder
  }
  return null
}

/** D7: the most live carriers one load carries. */
export const MAX_LIVE_CARRIERS = 4

/**
 * Why another carrier may not be added next to the live ones, or null (AT-plan D2,
 * D7). Own fleet never mixes with outside carriers (driver pay is a percentage of
 * the whole load); the same directory carrier twice needs disjoint, non-empty legs.
 */
export function validateCarrierAdd(
  live: readonly (LegCarrier & Partial<Pick<LoadCarrierRecord, 'kind' | 'carrierId'>>)[],
  adding: { kind?: LoadCarrierRecord['kind'] | null; carrierId?: string | null; legStopIds?: readonly string[] | null },
): string | null {
  if (live.some((lc) => lc.kind === 'OWN_ASSET') || adding.kind === 'OWN_ASSET') {
    return 'Own fleet cannot share a load with outside carriers'
  }
  if (live.length >= MAX_LIVE_CARRIERS) return `A load can have at most ${MAX_LIVE_CARRIERS} carriers`
  const same = adding.carrierId ? live.filter((lc) => lc.carrierId === adding.carrierId) : []
  if (same.length > 0) {
    const mine = adding.legStopIds ?? []
    const overlap = same.some((lc) => !(lc.legStopIds?.length) || mine.length === 0 || mine.some((id) => lc.legStopIds?.includes(id)))
    if (overlap) return 'The same carrier can be added twice only with separate stops for each'
  }
  return null
}
