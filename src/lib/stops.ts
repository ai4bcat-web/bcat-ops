import type { Load, Stop, StopType, ApptType } from '@/types'

// ── Multi-stop normalization layer ──────────────────────────────────────────────
//
// `stops` is the canonical multi-stop array on a Load. The legacy single
// pickup*/delivery*/origin*/destination*/*DriverId fields are DUAL-WRITTEN mirrors
// derived from the stops (first pickup → pickup*, last delivery → delivery*), which
// keeps the calendar/schedule code and the `.required()` pickupAppt/deliveryAppt
// working unchanged. Everything reads stops through getStops(); the store writes
// legacy mirrors through deriveLegacyFields(). Nothing reads `load.stops` directly.

/** Canonical accessor: real stops if present, else 2 stops synthesized from legacy fields. */
export function getStops(load: Load): Stop[] {
  if (Array.isArray(load.stops) && load.stops.length > 0) {
    return [...load.stops].sort((a, b) => a.sequence - b.sequence)
  }
  // Legacy load (no stops yet) → synthesize pickup + delivery. Deterministic ids so
  // drag keys and audit diffs stay stable for un-migrated loads.
  return [
    {
      id: `${load.id}:pu`,
      type: 'pickup',
      name: load.originName ?? undefined,
      city: load.originCity ?? undefined,
      appt: load.pickupAppt,
      apptType: load.pickupApptType,
      apptEnd: load.pickupApptEnd ?? undefined,
      driverId: load.pickupDriverId,
      sequence: 0,
    },
    {
      id: `${load.id}:de`,
      type: 'delivery',
      name: load.destinationName ?? undefined,
      city: load.destinationCity ?? undefined,
      appt: load.deliveryAppt,
      apptType: load.deliveryApptType,
      apptEnd: load.deliveryApptEnd ?? undefined,
      driverId: load.deliveryDriverId,
      sequence: 1,
    },
  ]
}

export interface LegacyLoadFields {
  pickupAppt: string
  pickupApptEnd?: string
  pickupApptType?: ApptType
  deliveryAppt: string
  deliveryApptEnd?: string
  deliveryApptType?: ApptType
  originName?: string
  originCity?: string
  destinationName?: string
  destinationCity?: string
  pickupDriverId: string | null
  deliveryDriverId: string | null
}

/**
 * Compute the legacy mirror fields from a stops array, for dual-write. Total function:
 * always yields non-null pickupAppt/deliveryAppt (the `.required()` model fields) via
 * fallbacks, as long as there is at least one stop.
 */
export function deriveLegacyFields(stops: Stop[]): LegacyLoadFields {
  const ordered = [...stops].sort((a, b) => a.sequence - b.sequence)
  const first = ordered.find((s) => s.type === 'pickup') ?? ordered[0]
  const last  = [...ordered].reverse().find((s) => s.type === 'delivery') ?? ordered[ordered.length - 1]
  return {
    pickupAppt:       first.appt,
    pickupApptEnd:    first.apptEnd,
    pickupApptType:   first.apptType,
    originName:       first.name,
    originCity:       first.city,
    pickupDriverId:   first.driverId,
    deliveryAppt:     last.appt,
    deliveryApptEnd:  last.apptEnd,
    deliveryApptType: last.apptType,
    destinationName:  last.name,
    destinationCity:  last.city,
    deliveryDriverId: last.driverId,
  }
}

/**
 * If `patch.stops` is present, merge in the derived legacy mirror fields so any write
 * that sets stops automatically keeps the legacy fields in sync. Called in the store's
 * add/updateLoad write path — the single place dual-write is enforced.
 */
export function withDerivedLegacy<T extends Partial<Load>>(patch: T): T {
  if (!patch.stops || patch.stops.length === 0) return patch
  return { ...patch, ...deriveLegacyFields(patch.stops) }
}

/** Re-number sequence 0..n after add/remove/reorder. */
export function reorderStops(stops: Stop[]): Stop[] {
  return stops.map((s, i) => ({ ...s, sequence: i }))
}

let stopCounter = 0
/** Build a new Stop with a unique id and the next sequence. */
export function makeStop(partial: Partial<Stop> & { type: StopType }, sequence: number): Stop {
  // crypto.randomUUID when available (browser); fall back to a counter-based id.
  const id =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `stop-${sequence}-${stopCounter++}`
  return {
    id,
    type: partial.type,
    name: partial.name,
    city: partial.city,
    appt: partial.appt ?? '',
    apptType: partial.apptType ?? 'exact',
    apptEnd: partial.apptEnd,
    driverId: partial.driverId ?? null,
    sequence,
  }
}

/** Immutably patch a single stop within a load's stops, returning the new array. */
export function updateStop(load: Load, stopId: string, patch: Partial<Stop>): Stop[] {
  return getStops(load).map((s) => (s.id === stopId ? { ...s, ...patch } : s))
}




/**
 * Stops that have just moved INTO the NEED state — the transition, not the state.
 *
 * Matching is by stop id, so re-saving a load whose stop was already NEED returns
 * nothing. That's what keeps #appts-ivan a signal rather than a running commentary on
 * every edit: one message per time an appointment actually becomes a problem.
 *
 * On create there are no previous stops, so any stop authored as NEED counts — it does
 * genuinely need booking, and new loads default to Pending rather than NEED, so this
 * doesn't fire on ordinary load entry.
 */
export function stopsNewlyNeeding(next: Stop[], prev: Stop[] = []): Stop[] {
  const before = new Map(prev.map((s) => [s.id, s.apptType ?? 'exact']))
  return next.filter((s) => s.apptType === 'tbd' && before.get(s.id) !== 'tbd')
}

/** Legacy mirror field → the stop field it mirrors, per end of the load. */
const PICKUP_MIRROR = {
  pickupAppt: 'appt', pickupApptEnd: 'apptEnd', pickupApptType: 'apptType',
  originName: 'name', originCity: 'city', pickupDriverId: 'driverId',
} as const
const DELIVERY_MIRROR = {
  deliveryAppt: 'appt', deliveryApptEnd: 'apptEnd', deliveryApptType: 'apptType',
  destinationName: 'name', destinationCity: 'city', deliveryDriverId: 'driverId',
} as const

/**
 * The INVERSE of withDerivedLegacy: project a legacy-field write back into `stops`.
 *
 * Dual-write was only ever enforced in one direction — set `stops` and the legacy mirrors
 * follow. But several call sites still patch `pickupAppt`/`deliveryAppt` directly (the
 * scheduler's drag and resize, the appointment popover on a load with no matching stop),
 * and nothing carried those back. The result was silent divergence: the Loads grid reads
 * the legacy fields and showed the new time, while the calendar and Appts read getStops()
 * and kept showing the old one. 26 production loads had drifted this way.
 *
 * Fixing it here rather than at each call site means the next `updateLoad({ pickupAppt })`
 * someone writes is correct by construction.
 *
 * Only touches loads that actually have a stops array — for a legacy load getStops()
 * synthesizes from these same fields, so there is nothing to keep in sync.
 */
export function withStopsFromLegacy<T extends Partial<Load>>(patch: T, load: Load | undefined): T {
  if (!load || patch.stops) return patch                    // stops given → it's canonical
  if (!Array.isArray(load.stops) || load.stops.length === 0) return patch

  const touches = (m: Record<string, string>) => Object.keys(m).some((k) => k in patch)
  if (!touches(PICKUP_MIRROR) && !touches(DELIVERY_MIRROR)) return patch

  const ordered = getStops(load)
  const first = ordered.find((s) => s.type === 'pickup') ?? ordered[0]
  const last = [...ordered].reverse().find((s) => s.type === 'delivery') ?? ordered[ordered.length - 1]

  // Copy only the keys the patch actually set, so writing just an appt time doesn't
  // also blank the appointment type.
  const apply = (stop: Stop, mirror: Record<string, string>): Stop => {
    const next: Record<string, unknown> = { ...stop }
    for (const [legacyKey, stopKey] of Object.entries(mirror)) {
      if (legacyKey in patch) next[stopKey] = (patch as Record<string, unknown>)[legacyKey]
    }
    return next as unknown as Stop
  }

  const stops = ordered.map((s) => {
    let out = s
    if (s.id === first?.id) out = apply(out, PICKUP_MIRROR)
    if (s.id === last?.id) out = apply(out, DELIVERY_MIRROR)
    return out
  })
  return { ...patch, stops }
}
