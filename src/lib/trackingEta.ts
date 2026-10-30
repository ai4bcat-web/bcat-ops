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
  let etaMs = nowMs + driveMinutes * MINUTE_MS
  if (etaMs < nowMs) etaMs = nowMs

  const etaAt = new Date(etaMs).toISOString()

  let lateBy: number | null = null
  const apptMs = stop.appt ? Date.parse(stop.appt) : Number.NaN
  if (Number.isFinite(apptMs) && etaMs > apptMs) {
    lateBy = Math.round((etaMs - apptMs) / MINUTE_MS)
  }

  return {
    miles,
    driveMinutes,
    etaAt,
    lateBy,
  }
}
