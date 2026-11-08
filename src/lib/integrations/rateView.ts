/**
 * Step P4 — the market rate behind a quote, live or stubbed.
 *
 * Ryne has no DAT credentials yet, so the demo runs on a stub. A stub that invents
 * a number is worse than no stub at all unless it says so, so every answer here
 * carries `stub: true` and the UI prints "stub" beside the figure wherever it is
 * shown. The arithmetic is deterministic — the same lane asked twice gives the same
 * number — because a demo that moves under you is not a demo.
 *
 * The live path is the DAT RateView lookup behind the same shape. It is written
 * against DAT's published RateView v1 lookup contract and has never been run: no
 * credentials exist on this stack. The Connect wizard on the provider page is what
 * turns it on, and Test connection prints DAT's own answer rather than ours.
 */

export interface RateViewRequest {
  originCity: string
  originState: string
  destinationCity: string
  destinationState: string
  equipmentType: string
  pickupDate?: string | null
  /** Straight-line or routed miles when the caller already knows them. */
  miles?: number | null
}

export interface RateViewAnswer {
  /** Line-haul plus fuel, the all-in number a broker compares a carrier's ask to. */
  averageCents: number
  lowCents: number
  highCents: number
  fuelCents: number
  perMileCents: number
  miles: number
  /** How many reports the average is built from — DAT's own confidence signal. */
  reports: number
  /** The age of the data, in days. */
  days: number
  stub: boolean
  source: 'DAT_RATEVIEW'
  message: string
}

/**
 * Dollar-per-mile line-haul by equipment, before the lane and the season move it.
 * Mid-2026 national spot averages, which is what the stub is pretending to be.
 */
const BASE_PER_MILE_CENTS: Record<string, number> = {
  VAN: 232,
  REEFER: 268,
  FLATBED: 254,
  STEPDECK: 272,
  POWER_ONLY: 198,
  BOX_TRUCK: 310,
  HOTSHOT: 290,
  CONESTOGA: 286,
  RGN: 348,
  TANKER: 304,
  AUTO_CARRIER: 296,
}

const DEFAULT_PER_MILE_CENTS = 240

/** Rough centroid per state, enough to put a lane within a few per cent of its real length. */
const STATE_CENTROIDS: Record<string, [number, number]> = {
  AL: [32.8, -86.8], AK: [64.0, -152.0], AZ: [34.3, -111.7], AR: [34.9, -92.4],
  CA: [37.2, -119.5], CO: [39.0, -105.5], CT: [41.6, -72.7], DE: [39.0, -75.5],
  FL: [28.6, -82.4], GA: [32.6, -83.4], HI: [20.3, -156.4], ID: [44.4, -114.6],
  IL: [40.0, -89.2], IN: [39.9, -86.3], IA: [42.1, -93.5], KS: [38.5, -98.4],
  KY: [37.5, -85.3], LA: [31.1, -92.0], ME: [45.4, -69.2], MD: [39.0, -76.8],
  MA: [42.3, -71.8], MI: [44.3, -85.4], MN: [46.3, -94.3], MS: [32.7, -89.7],
  MO: [38.4, -92.5], MT: [47.0, -109.6], NE: [41.5, -99.8], NV: [39.3, -116.6],
  NH: [43.7, -71.6], NJ: [40.2, -74.7], NM: [34.4, -106.1], NY: [42.9, -75.5],
  NC: [35.5, -79.4], ND: [47.4, -100.5], OH: [40.3, -82.8], OK: [35.6, -97.5],
  OR: [43.9, -120.6], PA: [40.9, -77.8], RI: [41.7, -71.6], SC: [33.9, -80.9],
  SD: [44.4, -100.2], TN: [35.8, -86.4], TX: [31.5, -99.3], UT: [39.3, -111.7],
  VT: [44.1, -72.7], VA: [37.5, -78.9], WA: [47.4, -120.4], WV: [38.6, -80.6],
  WI: [44.6, -89.7], WY: [43.0, -107.6], DC: [38.9, -77.0],
}

/**
 * Great-circle miles between two state centroids, inflated by 15% for the road.
 * Only used when the caller has no better number; a routed mileage always wins.
 */
export function estimateMiles(originState: string, destinationState: string): number {
  const a = STATE_CENTROIDS[originState.toUpperCase()]
  const b = STATE_CENTROIDS[destinationState.toUpperCase()]
  if (!a || !b) return 600
  const toRad = Math.PI / 180
  const dLat = (b[0] - a[0]) * toRad
  const dLng = (b[1] - a[1]) * toRad
  const lat1 = a[0] * toRad
  const lat2 = b[0] * toRad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  const miles = 3958.8 * 2 * Math.asin(Math.min(1, Math.sqrt(h)))
  // An in-state lane is never zero: a Chicago-to-Rockford run is still 90 miles.
  return Math.max(75, Math.round(miles * 1.15))
}

/** A stable 0..1 jitter per lane, so two different lanes do not price identically. */
function laneJitter(key: string): number {
  let h = 2166136261
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 1000) / 1000
}

/**
 * The stub RateView answer for a lane.
 *
 * Shape of a real one: short lanes pay more per mile, long lanes less; a January
 * reefer costs more than a September van; the band is roughly ±12% of the average
 * and fuel is a published surcharge rather than part of the line-haul.
 */
export function stubRateView(req: RateViewRequest): RateViewAnswer {
  const equipment = (req.equipmentType || 'VAN').toUpperCase().replace(/[^A-Z]/g, '_')
  const base = BASE_PER_MILE_CENTS[equipment] ?? DEFAULT_PER_MILE_CENTS
  const miles = req.miles && req.miles > 0 ? Math.round(req.miles) : estimateMiles(req.originState, req.destinationState)

  // Short-haul premium: under 250 miles a truck still has to be paid for a day.
  const lengthFactor = miles < 250 ? 1.38 : miles < 500 ? 1.12 : miles < 1000 ? 1.0 : 0.93
  // Reefers in winter and flatbeds in spring are the two seasons every broker knows.
  const month = req.pickupDate ? new Date(req.pickupDate).getUTCMonth() : new Date().getUTCMonth()
  const season = equipment === 'REEFER'
    ? (month <= 1 || month === 11 ? 1.1 : month >= 5 && month <= 7 ? 1.06 : 1.0)
    : equipment === 'FLATBED'
      ? (month >= 2 && month <= 8 ? 1.07 : 0.96)
      : (month === 11 || month === 0 ? 1.04 : 1.0)
  const laneKey = `${req.originCity}|${req.originState}|${req.destinationCity}|${req.destinationState}|${equipment}`
  const jitter = 0.94 + laneJitter(laneKey) * 0.12

  const perMileCents = Math.round(base * lengthFactor * season * jitter)
  const lineHaul = perMileCents * miles
  const fuelCents = Math.round(miles * 48)
  const averageCents = Math.round((lineHaul + fuelCents) / 100) * 100

  return {
    averageCents,
    lowCents: Math.round((averageCents * 0.88) / 100) * 100,
    highCents: Math.round((averageCents * 1.13) / 100) * 100,
    fuelCents,
    perMileCents,
    miles,
    reports: 40 + Math.round(laneJitter(`${laneKey}:reports`) * 260),
    days: 15,
    stub: true,
    source: 'DAT_RATEVIEW',
    message:
      `STUB — no DAT call was made. A live RateView lookup would have returned a 15-day `
      + `spot average for ${req.originCity}, ${req.originState} → ${req.destinationCity}, `
      + `${req.destinationState} on ${equipment}.`,
  }
}

export interface RateViewCredentials {
  serviceAccountEmail?: string
  serviceAccountPassword?: string
  rateViewTier?: string
}

/** The DAT lookup DAT's own documentation describes. Never run — no credentials exist. */
const DAT_AUTH_URL = 'https://identity.api.dat.com/access/v1/token/organization'
const DAT_RATEVIEW_URL = 'https://analytics.api.dat.com/linehaulrates/v1/lookups'

/**
 * Ask DAT for the lane.
 *
 * Returns null — never a made-up number — when the credentials are incomplete or
 * DAT refuses, so the caller falls back to the stub and says it fell back. A live
 * path that quietly invents a price on an auth failure is how a broker loses money.
 */
export async function liveRateView(
  req: RateViewRequest,
  creds: RateViewCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<RateViewAnswer | null> {
  if (!creds.serviceAccountEmail || !creds.serviceAccountPassword) return null
  try {
    const auth = await fetchImpl(DAT_AUTH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: creds.serviceAccountEmail, password: creds.serviceAccountPassword }),
    })
    if (!auth.ok) return null
    const token = (await auth.json() as { accessToken?: string }).accessToken
    if (!token) return null

    const lookup = await fetchImpl(DAT_RATEVIEW_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify([{
        origin: { city: req.originCity, stateOrProvince: req.originState },
        destination: { city: req.destinationCity, stateOrProvince: req.destinationState },
        rateType: 'SPOT',
        equipment: (req.equipmentType || 'VAN').toUpperCase(),
        includeMyRate: false,
        targetEscalation: { escalationType: 'BEST_FIT' },
      }]),
    })
    if (!lookup.ok) return null
    const body = await lookup.json() as {
      rateResponses?: { response?: { rate?: {
        averageFuelSurchargePerTripUsd?: number
        perTrip?: { lowUsd?: number; highUsd?: number; rateUsd?: number }
        mileage?: number
        reports?: number
        standardDeviation?: number
      } } }[]
    }
    const rate = body.rateResponses?.[0]?.response?.rate
    if (!rate?.perTrip?.rateUsd) return null
    const miles = Math.round(rate.mileage ?? req.miles ?? estimateMiles(req.originState, req.destinationState))
    const fuelCents = Math.round((rate.averageFuelSurchargePerTripUsd ?? 0) * 100)
    const averageCents = Math.round(rate.perTrip.rateUsd * 100) + fuelCents
    return {
      averageCents,
      lowCents: Math.round((rate.perTrip.lowUsd ?? rate.perTrip.rateUsd * 0.88) * 100) + fuelCents,
      highCents: Math.round((rate.perTrip.highUsd ?? rate.perTrip.rateUsd * 1.13) * 100) + fuelCents,
      fuelCents,
      perMileCents: miles > 0 ? Math.round((averageCents - fuelCents) / miles) : 0,
      miles,
      reports: rate.reports ?? 0,
      days: 15,
      stub: false,
      source: 'DAT_RATEVIEW',
      message: 'DAT RateView, 15-day spot average.',
    }
  } catch {
    return null
  }
}
