/**
 * The rail's Tracking card: where the truck on this shipment is right now, in the one
 * way that fits who is hauling it (Ryne, 2026-11-13).
 *
 *   - Ivan driver (own fleet): the truck's Motive ELD fix, plus the driver's recent
 *     check-ins from the Ivan driver app (stop taps, app check calls and time-clock punches).
 *   - Owner operator (own fleet): the truck's Motive ELD fix.
 *   - Brokered (an outside carrier): whether the driver accepted the tracking link and,
 *     once they did, the link's last ping.
 *
 * Pure: no store, no network. The clock is passed in.
 */
import { isOwnerOperator } from '@/lib/driverOwnership'
import type { TruckLocation } from '@/lib/apiClient'
import type { Driver, Stop, TimeClockEntry } from '@/types'
import type { LoadCarrierRecord, LoadCheckCallRecord, ShipmentLoad, TrackingLinkRecord } from '@/types/tms'

export type TrackingCase = 'IVAN' | 'OWNER_OP' | 'BROKERED' | 'NONE'
export type Freshness = 'fresh' | 'stale' | 'old'
export type LinkState = 'NOT_SENT' | 'SENT' | 'ACCEPTED' | 'EXPIRED' | 'STOPPED'

export interface TrackingFix {
  at: string
  lat: number
  lng: number
  place: string | null
  speedMph: number | null
  moving: boolean | null
  source: 'ELD' | 'LINK' | 'CHECK_CALL'
}

export interface CheckIn {
  at: string
  label: string
  place: string | null
}

export interface RailTracking {
  kind: TrackingCase
  /** True once every stop is done: the card shows the last fix as history. */
  delivered: boolean
  deliveredAt: string | null
  driverName: string | null
  truckLabel: string | null
  carrierName: string | null
  fix: TrackingFix | null
  /** Why there is no fix, in the office's words. Null when there is one. */
  emptyReason: string | null
  checkIns: CheckIn[]
  link: { state: LinkState; at: string | null; sentTo: string | null } | null
  loadCarrierId: string | null
}

const STALE_MIN = 30
const OLD_MIN = 120

const DELIVERED = new Set(['DELIVERED', 'INVOICING'])

export function freshnessOf(atIso: string, now: Date): Freshness {
  const mins = (now.getTime() - Date.parse(atIso)) / 60000
  if (!Number.isFinite(mins) || mins > OLD_MIN) return 'old'
  return mins > STALE_MIN ? 'stale' : 'fresh'
}

/** "just now" / "12 min ago" / "3 h ago" / "2 d ago". */
export function agoText(atIso: string, now: Date): string {
  const mins = Math.max(0, Math.round((now.getTime() - Date.parse(atIso)) / 60000))
  if (!Number.isFinite(mins)) return '—'
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}

export function mapsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(5)},${lng.toFixed(5)}`
}

/** The carrier leg this card follows: the only live one, else the primary (first booked). */
function activeLeg(loadCarriers: readonly LoadCarrierRecord[], loadId: string | null): LoadCarrierRecord | null {
  const live = loadCarriers.filter((c) => c.status === 'ACTIVE' && (!loadId || c.loadId === loadId))
  return live[0] ?? null
}

function eldFix(loc: TruckLocation): TrackingFix {
  return {
    at: loc.locatedAt,
    lat: loc.lat,
    lng: loc.lon,
    place: loc.description?.trim() || null,
    speedMph: typeof loc.speed === 'number' ? Math.round(loc.speed) : null,
    moving: loc.motion ? loc.motion === 'MOVING' : (typeof loc.speed === 'number' ? loc.speed > 1 : null),
    source: 'ELD',
  }
}

const STOP_LABEL = (s: Stop, ev: 'ARRIVED' | 'DEPARTED') => {
  const delivery = s.type === 'delivery'
  if (ev === 'ARRIVED') return delivery ? 'On site at delivery' : 'On site at pickup'
  return delivery ? 'Delivered' : 'Departed pickup'
}

const CHECK_CALL_LABEL: Partial<Record<LoadCheckCallRecord['type'], string>> = {
  DISPATCH: 'Dispatched',
  LOCATION_UPDATE: 'Location update',
  ARRIVED: 'Arrived',
  DEPARTED: 'Departed',
  ETA_UPDATE: 'ETA update',
  INCIDENT: 'Incident',
  NOTE: 'Note',
}

export type Punch = Pick<TimeClockEntry, 'kind' | 'clockInAt' | 'clockOutAt'>

/** The driver's own check-ins: stop taps from the driver app, app-sourced check calls and time-clock punches. */
export function checkInsOf(stops: readonly Stop[], checkCalls: readonly LoadCheckCallRecord[], limit = 5, punches: readonly Punch[] = []): CheckIn[] {
  const out: CheckIn[] = []
  for (const p of punches) {
    if (p.kind && p.kind !== 'WORK') continue
    if (p.clockInAt) out.push({ at: p.clockInAt, label: 'Clocked in (time clock)', place: null })
    if (p.clockOutAt) out.push({ at: p.clockOutAt, label: 'Clocked out (time clock)', place: null })
  }
  for (const s of stops) {
    const place = [s.name?.trim(), s.city?.trim()].filter(Boolean).join(', ') || null
    if (s.arrivedAt && s.arrivedSource === 'DRIVER_APP') out.push({ at: s.arrivedAt, label: STOP_LABEL(s, 'ARRIVED'), place })
    if (s.departedAt && s.departedSource === 'DRIVER_APP') out.push({ at: s.departedAt, label: STOP_LABEL(s, 'DEPARTED'), place })
  }
  for (const c of checkCalls) {
    if (c.source !== 'DRIVER_APP') continue
    const label = CHECK_CALL_LABEL[c.type]
    if (!label) continue
    const place = [c.city?.trim(), c.state?.trim()].filter(Boolean).join(', ') || null
    out.push({ at: c.at, label, place })
  }
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit)
}

export function linkStateOf(link: TrackingLinkRecord | null, leg: LoadCarrierRecord | null, now: Date): { state: LinkState; at: string | null } {
  if (!link) return { state: 'NOT_SENT', at: null }
  if (link.status === 'REVOKED') return { state: 'STOPPED', at: link.revokedAt ?? null }
  const accepted = link.consentAt ?? leg?.trackingAcceptedAt ?? null
  if (link.status === 'EXPIRED' || Date.parse(link.expiresAt) < now.getTime()) return { state: 'EXPIRED', at: link.expiresAt }
  if (accepted) return { state: 'ACCEPTED', at: accepted }
  return { state: 'SENT', at: link.sentAt ?? null }
}

export interface RailTrackingInput {
  load: ShipmentLoad | null
  loadCarriers: readonly LoadCarrierRecord[]
  drivers: readonly Pick<Driver, 'id' | 'name' | 'fleetGroup' | 'driverType' | 'type' | 'assignedTruckId'>[]
  equipment: readonly { id: string; type: string; unitNumber: string }[]
  truckLocations: readonly TruckLocation[]
  checkCalls: readonly LoadCheckCallRecord[]
  trackingLinks: readonly TrackingLinkRecord[]
  /** The Ivan driver's time-clock rows around this load. Owner operators do not clock. */
  punches?: readonly Punch[]
  now: Date
}

export function railTracking(input: RailTrackingInput): RailTracking {
  const { load, loadCarriers, drivers, equipment, truckLocations, checkCalls, trackingLinks, punches = [], now } = input
  const stops = (load?.stops ?? []) as Stop[]
  const delivered = DELIVERED.has(String(load?.status ?? ''))
  const lastDelivery = [...stops].reverse().find((s) => s.type === 'delivery')
  const deliveredAt = delivered ? (load?.deliveredAt ?? lastDelivery?.departedAt ?? lastDelivery?.arrivedAt ?? null) : null
  const leg = activeLeg(loadCarriers, load?.id ?? null)
  const base: RailTracking = {
    kind: 'NONE', delivered, deliveredAt, driverName: null, truckLabel: null, carrierName: null,
    fix: null, emptyReason: null, checkIns: [], link: null, loadCarrierId: leg?.id ?? null,
  }
  if (!leg) return { ...base, emptyReason: 'No carrier or driver is on this load yet.' }

  if (leg.kind === 'OWN_ASSET') {
    const loose = load as (ShipmentLoad & { pickupDriverId?: string | null; truckId?: string | null }) | null
    const driverId = leg.driverId ?? loose?.pickupDriverId ?? null
    const driver = driverId ? drivers.find((d) => d.id === driverId) : undefined
    const kind: TrackingCase = driver && isOwnerOperator(driver) ? 'OWNER_OP' : 'IVAN'
    const truckId = leg.truckId ?? loose?.truckId ?? driver?.assignedTruckId ?? null
    const truck = truckId ? equipment.find((e) => e.id === truckId) : undefined
    const unit = truck?.unitNumber ?? leg.truckNumber ?? null
    const loc = (truckId ? truckLocations.find((l) => l.truckId === truckId) : undefined)
      ?? (unit ? truckLocations.find((l) => l.unitNumber === unit || l.truckId === `motive:${unit}`) : undefined)
    const fix = loc ? eldFix(loc) : null
    return {
      ...base,
      kind,
      driverName: driver?.name ?? leg.driverName ?? null,
      truckLabel: unit ? `Truck ${unit}` : null,
      fix,
      emptyReason: fix ? null
        : !unit ? 'No truck is assigned, so there is no ELD to read.'
        : `Truck ${unit} has no ELD position. Check that its unit number matches Motive.`,
      checkIns: checkInsOf(stops, checkCalls, 5, kind === 'IVAN' ? punches : []),
    }
  }

  const link = (leg.trackingLinkId ? trackingLinks.find((l) => l.id === leg.trackingLinkId) : undefined)
    ?? [...trackingLinks].filter((l) => l.kind === 'CARRIER_PING' && l.loadCarrierId === leg.id)
      .sort((a, b) => (b.sentAt ?? '').localeCompare(a.sentAt ?? ''))[0]
    ?? null
  const { state, at } = linkStateOf(link, leg, now)
  const pinged = link?.lastPingAt && typeof link.lastPingLat === 'number' && typeof link.lastPingLng === 'number'
  const fix: TrackingFix | null = pinged
    ? { at: link!.lastPingAt!, lat: link!.lastPingLat!, lng: link!.lastPingLng!, place: null, speedMph: null, moving: null, source: 'LINK' }
    : load?.lastKnownAt && typeof load.lastKnownLat === 'number' && typeof load.lastKnownLng === 'number' && load.lastKnownSource !== 'MOTIVE'
      ? {
          at: load.lastKnownAt, lat: load.lastKnownLat, lng: load.lastKnownLng,
          place: [load.lastKnownCity, load.lastKnownState].filter(Boolean).join(', ') || null,
          speedMph: null, moving: null, source: load.lastKnownSource === 'LINK' ? 'LINK' : 'CHECK_CALL',
        }
      : null
  return {
    ...base,
    kind: 'BROKERED',
    carrierName: leg.carrierName ?? null,
    driverName: leg.driverName ?? null,
    truckLabel: leg.truckNumber ? `Truck ${leg.truckNumber}` : null,
    link: { state, at, sentTo: link?.sentTo ?? null },
    fix,
    emptyReason: fix ? null
      : state === 'NOT_SENT' ? 'No tracking link has been sent to the driver.'
      : state === 'SENT' ? 'Waiting for the driver to accept the tracking link.'
      : state === 'ACCEPTED' ? 'The driver accepted, but no location has come in yet.'
      : 'The tracking link is no longer active.',
  }
}
