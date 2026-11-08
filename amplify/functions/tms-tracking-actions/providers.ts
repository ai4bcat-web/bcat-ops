/**
 * Step AO — continuous carrier tracking through a tracking provider (MacroPoint,
 * Trucker Tools, …): the start / stop actions and the dev-only sim door.
 *
 * Nothing here talks to a provider. `trackingPortFor` answers with the STUB port until
 * a LIVE port and credentials exist (none do), so a "started" subscription is an
 * honest `STUB — …` row on the TrackingLink table and nothing leaves the Lambda. The
 * webhook that would carry positions back is `tracking-api/providerTracking.ts`; the
 * sim door below drives the same parse → ingest chain without the HMAC step.
 *
 * Deps are injected so the router owns every client and this file owns only the rules.
 */
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb'
import { descriptorOf } from '../../../src/lib/integrations/registry'
import {
  trackingPortFor,
  type TrackingSubscription,
} from '../../../src/lib/integrations/trackingProvider'
import { linkExpiry } from '../../../src/lib/trackingLink'
import type { TrackingLinkSettings } from '../../../src/lib/trackingLink'
import { assertString, optionalString, type Caller } from '../_shared/actionInputs'
import { putItem, readStops, updateItemTx, type Row, type StopShape } from '../_shared/shipmentStore'
import { ingestProviderDelivery, type PingDeps } from '../_shared/trackingPings'
import { isVoided } from '../_shared/voided'
import type { TrackingLinkRecord } from '../../../src/types/tms'

export interface ProviderActionDeps {
  tables: { trackingLink: string; loadCarrier: string; load: string; shipment: string }
  getById(table: string, id: string): Promise<Row | null>
  queryIndex(table: string, index: string, keyName: string, keyValue: string): Promise<Row[]>
  transact(items: TransactWriteItem[], label: string): Promise<void>
  getSettings(): Promise<Row | null>
  writeAudit(entityType: string, entityId: string, action: string, caller: Caller, changes: Row): Promise<void>
  now(): string
  /** 24 random bytes, base64url: the token is the TrackingLink row id. */
  newToken(): string
  /** `ADD pingCount n, SET lastPingAt` on a TrackingLink row. */
  bumpLink(token: string, n: number, lastAtIso: string): Promise<void>
  /** The TruckLocationHistory writer's client + table. */
  ping: PingDeps
  isDevStack(): boolean
}

const IDX_TRACKING_LINKS_BY_LOAD = 'trackingLinksByLoadId'
const CLOSED_LOAD_STATUSES: readonly string[] = ['DELIVERED', 'INVOICING', 'CANCELED']
const MAX_SIM_FIXES = 100
const MINUTE_MS = 60_000

const numberOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** The expiry knobs `linkExpiry` reads, pulled off the settings row it does not know. */
function linkSettings(settings: Row | null): TrackingLinkSettings {
  return {
    trackingLinkExpiryHours: numberOrNull(settings?.trackingLinkExpiryHours),
    customerLinkExpiryDays: numberOrNull(settings?.customerLinkExpiryDays),
  }
}

/** City / state of a stop for the provider; the stop's address wins over its free-text city. */
function placeOf(stop: StopShape | undefined): { city: string | null; state: string | null } {
  if (!stop) return { city: null, state: null }
  const parts = String(stop.city ?? '').split(',')
  return {
    city: optionalString(stop.address?.city, 120) ?? (parts[0]?.trim() || null),
    state: optionalString(stop.address?.state, 20) ?? (parts[1]?.trim() || null),
  }
}

function lastDeliveryAppt(stops: StopShape[]): string | null {
  const appts = stops.filter((s) => s.type === 'delivery' && s.appt).map((s) => String(s.appt)).sort()
  return appts.length > 0 ? appts[appts.length - 1] : null
}

/** A tracking provider this repo can subscribe to: TRACKING, live-capable, declares `track`. */
function trackingDescriptor(provider: string) {
  const descriptor = descriptorOf(provider)
  if (!descriptor || descriptor.category !== 'TRACKING') throw new Error(`${provider} is not a tracking provider`)
  if (descriptor.applicability !== 'LIVE_CAPABLE' || !descriptor.capabilities.includes('track')) {
    throw new Error(`${descriptor.label} does not offer load tracking`)
  }
  return descriptor
}

export async function startProviderTracking(deps: ProviderActionDeps, input: Row, caller: Caller): Promise<Row> {
  const loadCarrierId = assertString(input.loadCarrierId, 'loadCarrierId')
  const descriptor = trackingDescriptor(assertString(input.provider, 'provider').toUpperCase())

  const loadCarrier = await deps.getById(deps.tables.loadCarrier, loadCarrierId)
  if (!loadCarrier) throw new Error(`Load carrier not found: ${loadCarrierId}`)
  if (loadCarrier.status !== 'ACTIVE') throw new Error('Only the carrier currently on the load can be tracked')
  if (loadCarrier.kind !== 'CARRIER') {
    throw new Error('Own trucks track through Motive and the driver app — a tracking provider is for outside carriers')
  }

  const loadId = String(loadCarrier.loadId)
  const shipmentId = String(loadCarrier.shipmentId)
  const [load, shipment] = await Promise.all([
    deps.getById(deps.tables.load, loadId),
    deps.getById(deps.tables.shipment, shipmentId),
  ])
  if (!load) throw new Error(`Load not found: ${loadId}`)
  if (!shipment) throw new Error(`Shipment not found: ${shipmentId}`)
  if (isVoided(shipment)) throw new Error(`Shipment ${optionalString(shipment.number, 60) ?? shipmentId} is voided`)
  const loadStatus = String(load.status ?? '')
  if (CLOSED_LOAD_STATUSES.includes(loadStatus)) {
    throw new Error(`This load is ${loadStatus.toLowerCase()}; there is nothing left to track`)
  }

  const stops = readStops(load)
  const pickups = stops.filter((s) => s.type === 'pickup')
  const deliveries = stops.filter((s) => s.type === 'delivery')
  const now = deps.now()
  const token = deps.newToken()
  const expiresAt = linkExpiry('CARRIER_PING', lastDeliveryAppt(stops), linkSettings(await deps.getSettings()), now)

  const subscription: TrackingSubscription = {
    reference: token,
    loadId, loadCarrierId, shipmentId,
    carrier: {
      name: optionalString(loadCarrier.carrierName, 200),
      dot: optionalString(loadCarrier.carrierDot, 20),
      mc: optionalString(loadCarrier.carrierMc, 20),
    },
    driverPhone: optionalString(loadCarrier.driverPhone, 40),
    origin: placeOf(pickups[0]),
    destination: placeOf(deliveries[deliveries.length - 1]),
    pickupAppt: pickups[0]?.appt ?? null,
    deliveryAppt: lastDeliveryAppt(stops),
  }
  // Subscribe before anything is written: a refusal leaves no half-started row behind.
  const port = trackingPortFor(descriptor, {})
  const result = await port.subscribe(subscription)
  if (!result.ok) throw new Error(result.message)

  const previous = (await deps.queryIndex(deps.tables.trackingLink, IDX_TRACKING_LINKS_BY_LOAD, 'loadId', loadId))
    .filter((r) => r.kind === 'PROVIDER_TRACK' && r.status === 'ACTIVE' && r.loadCarrierId === loadCarrierId)

  const link: Row = {
    id: token,
    __typename: 'TrackingLink',
    kind: 'PROVIDER_TRACK',
    provider: descriptor.key,
    providerRef: result.providerRef,
    shipmentId, loadId, loadCarrierId,
    status: 'ACTIVE',
    expiresAt,
    sentVia: 'COPY',
    sentAt: now,
    openCount: 0, requestCount: 0, pingCount: 0,
    createdBy: caller.email, createdAt: now, updatedAt: now,
  }
  await deps.transact(
    [
      ...previous.map((p) => updateItemTx(deps.tables.trackingLink, String(p.id), {
        status: 'REVOKED', revokedAt: now, revokedBy: caller.email, updatedAt: now,
      }, null)),
      putItem(deps.tables.trackingLink, link),
    ],
    'provider tracking',
  )
  // The provider is told the old subscription is over; a failure there cannot undo the swap.
  for (const p of previous) {
    const ref = optionalString(p.providerRef, 200)
    if (ref) await port.unsubscribe(ref).catch((err: unknown) => console.warn('[tms-tracking-actions] unsubscribe failed', String(err)))
  }

  await deps.writeAudit('TRACKING_LINK', token, 'START_PROVIDER_TRACKING', caller, {
    loadId, loadCarrierId, provider: descriptor.key, mode: result.mode, expiresAt,
    revoked: previous.map((p) => String(p.id)),
  })
  return { link, mode: result.mode, message: result.message }
}

export async function stopProviderTracking(deps: ProviderActionDeps, input: Row, caller: Caller): Promise<Row> {
  const linkId = assertString(input.linkId, 'linkId')
  const link = await deps.getById(deps.tables.trackingLink, linkId)
  if (!link) throw new Error('That tracking link no longer exists')
  if (link.kind !== 'PROVIDER_TRACK') throw new Error('That is not a provider tracking subscription')
  if (link.status !== 'ACTIVE') return { link, mode: 'STUB', message: 'Already stopped' }

  const descriptor = trackingDescriptor(String(link.provider ?? '').toUpperCase())
  const now = deps.now()
  const result = await trackingPortFor(descriptor, {}).unsubscribe(optionalString(link.providerRef, 200) ?? '')
  const patch = { status: 'REVOKED', revokedAt: now, revokedBy: caller.email, updatedAt: now }
  await deps.transact([updateItemTx(deps.tables.trackingLink, linkId, patch, null)], 'provider tracking')
  await deps.writeAudit('TRACKING_LINK', linkId, 'STOP_PROVIDER_TRACKING', caller, {
    loadId: link.loadId ?? null, provider: descriptor.key, mode: result.mode,
  })
  return { link: { ...link, ...patch }, mode: result.mode, message: result.message }
}

/**
 * Dev only. Builds the SIM-shaped delivery a provider would post and runs the very same
 * parse → ingest the webhook runs; only the HMAC step (Step J's tests) is skipped.
 */
export async function simProviderDelivery(deps: ProviderActionDeps, input: Row, caller: Caller): Promise<Row> {
  if (!deps.isDevStack()) throw new Error('This action only exists on the dev stack')
  if (!caller.isAdmin) throw new Error('Forbidden: TRACKING_SIM_PROVIDER requires owner or ADMIN')
  const linkId = assertString(input.linkId, 'linkId')
  const link = (await deps.getById(deps.tables.trackingLink, linkId)) as TrackingLinkRecord | null
  if (!link || link.kind !== 'PROVIDER_TRACK' || !link.provider) throw new Error('That is not a provider tracking subscription')
  if (!Array.isArray(input.fixes) || input.fixes.length === 0 || input.fixes.length > MAX_SIM_FIXES) {
    throw new Error(`fixes must be a list of 1 to ${MAX_SIM_FIXES} positions`)
  }

  const now = deps.now()
  const fixes = (input.fixes as Row[]).map((f) => {
    const minutesAgo = numberOrNull(f.minutesAgo) ?? 0
    const at = new Date(Date.parse(now) - minutesAgo * MINUTE_MS).toISOString()
    return {
      refId: `sim:${at}`, at, lat: f.lat, lng: f.lng,
      ...(f.accuracyM != null ? { accuracyM: f.accuracyM } : {}),
      ...(f.speedMph != null ? { speedMph: f.speedMph } : {}),
    }
  })
  const outcome = await ingestProviderDelivery(
    {
      ...deps.ping,
      getLink: (token) => deps.getById(deps.tables.trackingLink, token) as Promise<TrackingLinkRecord | null>,
      bumpLink: deps.bumpLink,
      loadClosed: async (loadId) => {
        const load = await deps.getById(deps.tables.load, loadId)
        return !load || CLOSED_LOAD_STATUSES.includes(String(load.status ?? ''))
      },
    },
    link.provider.toLowerCase(),
    { headers: {}, body: JSON.stringify({ reference: linkId, status: 'ACTIVE', fixes }) },
    now,
  )
  return { ...outcome }
}
