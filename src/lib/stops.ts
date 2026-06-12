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

export interface StopEntry {
  load: Load
  stop: Stop
  key: string // `${load.id}:${stop.id}`
}

/** Flatten loads into one entry per stop (for per-stop calendar rendering in Phase 2). */
export function flattenLoadsToStopEntries(loads: Load[]): StopEntry[] {
  return loads.flatMap((load) =>
    getStops(load).map((stop) => ({ load, stop, key: `${load.id}:${stop.id}` })),
  )
}
