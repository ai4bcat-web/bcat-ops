/**
 * Step P8 — ETA from a driver's last known position to the delivery stop.
 *
 * One pure function so the shipment page, the Tracking page and the public link
 * all show the same number from the same last known position.
 */

const EARTH_RADIUS_MILES = 3958.8
const ROAD_FACTOR = 1.15
const AVG_SPEED_MPH = 50
const MINUTE_MS = 60_000
const METERS_PER_MILE = 1609.344

/** Great-circle distance in miles. */
function haversineMiles(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const lat1 = (a.lat * Math.PI) / 180
  const lat2 = (b.lat * Math.PI) / 180
  const sinDLat2 = Math.sin(dLat / 2)
  const sinDLng2 = Math.sin(dLng / 2)
  const hh = sinDLat2 * sinDLat2 + Math.cos(lat1) * Math.cos(lat2) * sinDLng2 * sinDLng2
  const c = 2 * Math.atan2(Math.sqrt(hh), Math.sqrt(1 - hh))
  return EARTH_RADIUS_MILES * c
}

/**
 * Shared arrival math: project `driveMinutes` from the `fromMs` fix, clamp so the
 * answer never reads as already arrived, then compare against the appointment.
 */
function arrivalFrom(
  driveMinutes: number,
  fromMs: number,
  nowMs: number,
  appt: string | null | undefined,
): { etaAt: string; lateBy: number | null } {
  let etaMs = fromMs + driveMinutes * MINUTE_MS
  if (etaMs < nowMs) etaMs = nowMs

  let lateBy: number | null = null
  const apptMs = appt ? Date.parse(appt) : Number.NaN
  if (Number.isFinite(apptMs) && etaMs > apptMs) {
    lateBy = Math.round((etaMs - apptMs) / MINUTE_MS)
  }

  return { etaAt: new Date(etaMs).toISOString(), lateBy }
}

export interface EtaToStopInput {
  lat: number
  lng: number
}

export interface EtaToStopStop {
  lat: number
  lng: number
  appt: string | null | undefined
}

export interface EtaToStopResult {
  /** Road miles from the position to the stop. */
  miles: number
  /** Minutes of driving at the average speed. */
  driveMinutes: number
  /** Estimated arrival time, never earlier than now. */
  etaAt: string
  /** Minutes past the appointment when etaAt is late; null when on time or no appointment. */
  lateBy: number | null
}

/**
 * Compute the ETA to a stop from a lat/lng fix.
 *
 * Distance is great-circle × 1.15 road factor. Drive time is that ÷ 50 mph.
 * The result is clamped so it never reads as already arrived.
 */
export function etaToStop(
  from: EtaToStopInput,
  stop: EtaToStopStop,
  now: string,
): EtaToStopResult {
  const nowMs = Date.parse(now)
  if (Number.isNaN(nowMs)) throw new Error('etaToStop needs a valid ISO timestamp for now')

  const miles = haversineMiles(from, stop) * ROAD_FACTOR
  const driveMinutes = (miles / AVG_SPEED_MPH) * 60

  return {
    miles,
    driveMinutes,
    ...arrivalFrom(driveMinutes, nowMs, nowMs, stop.appt),
  }
}

/* ── Client ETA for the tracking detail pane ──────────────────────────────────
 * The detail pane projects the driver's last ping against the final pending
 * delivery appointment. Google Distance Matrix is the better road answer when a
 * Maps key is configured; the haversine estimate is the labelled fallback.
 */

export type TrackingEtaBasis = 'GOOGLE_DISTANCE_MATRIX' | 'ESTIMATE'

export const TRACKING_ETA_BASIS_LABELS: Record<TrackingEtaBasis, string> = {
  GOOGLE_DISTANCE_MATRIX: 'Google Distance Matrix from the last ping',
  ESTIMATE: 'Estimate — straight-line × 1.15 at 50 mph from the last ping',
}

export interface ComputedTrackingEta {
  /** Road miles from the ping to the stop. */
  miles: number
  /** Minutes of driving. */
  driveMinutes: number
  /** Projected arrival: last ping + drive time, never earlier than now. */
  etaAt: string
  /** Minutes past the appointment when etaAt is late; null when on time or no appointment. */
  lateBy: number | null
  basis: TrackingEtaBasis
  /** What the UI shows next to the number so nobody mistakes an estimate for a routed answer. */
  basisLabel: string
}

/** The leg Google Distance Matrix returns for one origin/destination pair. */
export interface DistanceMatrixLeg {
  distanceMeters: number
  durationSeconds: number
}

function computedEta(
  miles: number,
  driveMinutes: number,
  pingAt: string,
  now: string,
  appt: string | null | undefined,
  basis: TrackingEtaBasis,
): ComputedTrackingEta {
  const pingMs = Date.parse(pingAt)
  if (Number.isNaN(pingMs)) throw new Error('tracking ETA needs a valid ISO timestamp for the last ping')
  const nowMs = Date.parse(now)
  if (Number.isNaN(nowMs)) throw new Error('tracking ETA needs a valid ISO timestamp for now')

  return {
    miles,
    driveMinutes,
    ...arrivalFrom(driveMinutes, pingMs, nowMs, appt),
    basis,
    basisLabel: TRACKING_ETA_BASIS_LABELS[basis],
  }
}

/**
 * Fallback ETA with no Google key: great-circle × road factor at the average
 * speed, projected from the ping. Always labelled an estimate.
 */
export function trackingEtaEstimate(
  from: EtaToStopInput,
  stop: EtaToStopStop,
  pingAt: string,
  now: string,
): ComputedTrackingEta {
  const miles = haversineMiles(from, stop) * ROAD_FACTOR
  return computedEta(miles, (miles / AVG_SPEED_MPH) * 60, pingAt, now, stop.appt, 'ESTIMATE')
}

/** ETA from a Google Distance Matrix leg, projected from the ping. */
export function trackingEtaFromMatrix(
  stop: { appt?: string | null },
  pingAt: string,
  now: string,
  leg: DistanceMatrixLeg,
): ComputedTrackingEta {
  return computedEta(
    leg.distanceMeters / METERS_PER_MILE,
    leg.durationSeconds / 60,
    pingAt,
    now,
    stop.appt,
    'GOOGLE_DISTANCE_MATRIX',
  )
}
