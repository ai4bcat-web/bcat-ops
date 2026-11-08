/**
 * Step AO — the continuous-carrier-tracking port (MacroPoint / Trucker Tools style).
 *
 * The generic `Adapter` only takes a sample; tracking needs a subscription that outlives
 * the call and a webhook that comes back with positions. This is that shape, pure and
 * typed. Nothing here talks to a provider: until a LIVE port and credentials exist the
 * STUB port answers honestly ("STUB — …"), and it parses only the documented SIM
 * delivery, so a harness can run the whole consumer while a real provider body — whose
 * schema nothing in this repo states — is rejected rather than guessed at.
 */
import { modeOf } from './health'
import type { ProviderDescriptor, ProviderKey } from './types'

export interface ProviderFix {
  lat: number; lng: number; at: string
  accuracyM?: number | null; speedMph?: number | null; headingDeg?: number | null
  refId: string
}

export interface TrackingSubscription {
  reference: string                 // = TrackingLink.id; the provider echoes it back on every delivery
  loadId: string; loadCarrierId: string; shipmentId: string
  carrier: { name: string | null; dot: string | null; mc: string | null }     // MacroPoint needs the carrier DOT
  driverPhone: string | null
  origin: { city: string | null; state: string | null }
  destination: { city: string | null; state: string | null }
  pickupAppt: string | null; deliveryAppt: string | null
}

export interface PortResult { mode: 'STUB' | 'LIVE'; ok: boolean; message: string; providerRef: string | null }   // a stub message begins "STUB — "

export type DeliveryStatus = 'ACTIVE' | 'ARRIVED' | 'COMPLETE' | 'DECLINED' | 'NO_SIGNAL'

export interface ParsedDelivery { reference: string; fixes: ProviderFix[]; status: DeliveryStatus | null }

export interface RawDelivery { headers: Record<string, string | undefined>; body: string }

export interface TrackingProviderPort {
  readonly key: ProviderKey
  readonly mode: 'STUB' | 'LIVE'
  subscribe(sub: TrackingSubscription): Promise<PortResult>
  unsubscribe(providerRef: string): Promise<PortResult>
  parseDelivery(raw: RawDelivery): ParsedDelivery | null   // webhook -> fixes; null = not ours / malformed
  poll?(providerRef: string, sinceIso: string): Promise<ProviderFix[]>    // pull-style providers; unused until a LIVE port supplies it
}

export const SIM_DELIVERY_SHAPE =
  '{ "reference": "<token>", "status": "ACTIVE", "fixes": [{ "refId": "…", "at": "ISO", "lat": 0, "lng": 0, "accuracyM": 30, "speedMph": 54 }] }'

const STATUSES: readonly string[] = ['ACTIVE', 'ARRIVED', 'COMPLETE', 'DECLINED', 'NO_SIGNAL']

function finiteOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** One entry of the SIM shape, or null when it is not a usable position. */
function fixOfSim(v: unknown): ProviderFix | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const lat = finiteOrNull(o.lat)
  const lng = finiteOrNull(o.lng)
  if (lat === null || lng === null || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
  if (typeof o.at !== 'string' || Number.isNaN(Date.parse(o.at))) return null
  if (typeof o.refId !== 'string' || o.refId === '') return null
  return {
    lat, lng, at: new Date(Date.parse(o.at)).toISOString(), refId: o.refId,
    accuracyM: finiteOrNull(o.accuracyM), speedMph: finiteOrNull(o.speedMph), headingDeg: finiteOrNull(o.headingDeg),
  }
}

export function parseSimDelivery(raw: RawDelivery): ParsedDelivery | null {
  let body: unknown
  try { body = JSON.parse(raw.body) } catch { return null }
  if (!body || typeof body !== 'object') return null
  const o = body as Record<string, unknown>
  if (typeof o.reference !== 'string' || o.reference === '' || !Array.isArray(o.fixes)) return null
  const fixes = o.fixes.map(fixOfSim).filter((f): f is ProviderFix => f !== null)
  const status = typeof o.status === 'string' && STATUSES.includes(o.status) ? (o.status as DeliveryStatus) : null
  return { reference: o.reference, fixes, status }
}

/** Every method answers STUB and touches nothing: no HTTP, no record. */
export function stubTrackingPort(d: ProviderDescriptor): TrackingProviderPort {
  return {
    key: d.key,
    mode: 'STUB',
    async subscribe(sub) {
      return {
        mode: 'STUB',
        ok: true,
        message: `STUB — A live ${d.label} connection would have started ${d.label} tracking on this shipment.`,
        providerRef: `stub:${sub.reference.slice(0, 8)}`,
      }
    },
    async unsubscribe() {
      return { mode: 'STUB', ok: true, message: `STUB — A live ${d.label} connection would have stopped ${d.label} tracking on this shipment.`, providerRef: null }
    },
    parseDelivery: parseSimDelivery,
  }
}

/**
 * Same rule as `adapterFor`: live only when every required credential is present and
 * unneutered AND a live port was supplied (none is, today). Everything else is the stub.
 */
export function trackingPortFor(
  d: ProviderDescriptor,
  creds: Record<string, string>,
  live?: TrackingProviderPort,
): TrackingProviderPort {
  if (live && modeOf(d, creds) === 'LIVE') return live
  return stubTrackingPort(d)
}
