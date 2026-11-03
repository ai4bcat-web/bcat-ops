/**
 * Pure derivations shared by the Inbox info panel and the shipment Tracking tab:
 * where the active leg is, the ETA the tab already shows, and the order status
 * timeline (Scheduled → Confirmed → On route → Arrived → Delivered).
 *
 * Only stored facts are used. A step's time is a stored timestamp or absent;
 * "Rest stop" and "Complete" are not modelled by the data and are not shown.
 */
import type { TmsTimelineItem } from '@/features/tms/kit/TmsTimeline'
import { statusTone, type TmsTone } from '@/features/tms/kit/statusTone'
import { MOVEMENT_STATUSES } from '@/lib/brokerageCharts'
import { formatDateTime } from '@/lib/date'
import { trackingEtaEstimate, type ComputedTrackingEta } from '@/lib/trackingEta'
import type { Stop } from '@/types'
import type { LoadCarrierRecord, LoadWorkflowStatus, ShipmentBundle, ShipmentLoad } from '@/types/tms'
import type { ShipmentRow } from '../../shipmentViews'

/** A "late" pill shows only when the ETA runs this far past the appointment. */
export const LATE_PILL_MINUTES = 15
/** A ping younger than this is shown as a live (green) dot. */
export const FRESH_PING_MS = 30 * 60_000

const ARRIVED_STATUSES: readonly LoadWorkflowStatus[] = ['ARRIVED_AT_DELIVERY_TERMINAL', 'UNLOADING', 'DELIVERED', 'INVOICING']
const DELIVERED_STATUSES: readonly LoadWorkflowStatus[] = ['DELIVERED', 'INVOICING']

const PLANNING_STATUSES: readonly LoadWorkflowStatus[] = ['SOURCING', 'BOOKED', 'PLANNED']

/** ON ROUTE green · SCHEDULED gray · ARRIVED blue · DELIVERED green · anything else its own status tone. */
export function driverStatusPill(status: LoadWorkflowStatus | null | undefined): { label: string; tone: TmsTone } | null {
  if (!status) return null
  if (status === 'DELIVERED' || status === 'INVOICING') return { label: 'DELIVERED', tone: 'green' }
  if (status === 'ARRIVED_AT_DELIVERY_TERMINAL' || status === 'UNLOADING') return { label: 'ARRIVED', tone: 'blue' }
  if (MOVEMENT_STATUSES.includes(status)) return { label: 'ON ROUTE', tone: 'green' }
  if (PLANNING_STATUSES.includes(status)) return { label: 'SCHEDULED', tone: 'gray' }
  return { label: status.replace(/_/g, ' '), tone: statusTone(status) }
}

export interface LegGeometry {
  load: ShipmentLoad | null
  leg: LoadCarrierRecord | null
  lastKnown: { lat: number; lng: number } | null
  pingAt: string | null
  /** The final delivery stop that has not been arrived at yet. */
  deliveryStop: Stop | null
  destination: { lat: number; lng: number; appt: string | null } | null
}

export function legGeometry(bundle: ShipmentBundle | null | undefined, shipmentId: string): LegGeometry {
  const load = bundle?.shipment.id === shipmentId ? bundle.loads[0] ?? null : null
  const leg = load ? bundle?.loadCarriers.find((c) => c.loadId === load.id && c.status === 'ACTIVE') ?? null : null
  const lat = load?.lastKnownLat
  const lng = load?.lastKnownLng
  const lastKnown = lat == null || lng == null ? null : { lat, lng }
  let deliveryStop: Stop | null = null
  for (const stop of load?.stops ?? []) {
    if (stop.type === 'delivery' && !stop.arrivedAt && (!deliveryStop || stop.sequence > deliveryStop.sequence)) deliveryStop = stop
  }
  const address = deliveryStop?.address
  const destination = !deliveryStop || address?.lat == null || address.lng == null
    ? null
    : {
        lat: address.lat,
        lng: address.lng,
        appt: deliveryStop.apptType === 'tbd' || deliveryStop.apptType === 'fcfs'
          ? null
          : deliveryStop.apptEnd || deliveryStop.appt || null,
      }
  return { load, leg, lastKnown, pingAt: load?.lastKnownAt ?? null, deliveryStop, destination }
}

/** The labelled straight-line estimate; Google's routed answer replaces it where a key exists. */
export function estimateEta(geo: LegGeometry, now: string): ComputedTrackingEta | null {
  if (!geo.lastKnown || !geo.destination || !geo.pingAt) return null
  try { return trackingEtaEstimate(geo.lastKnown, geo.destination, geo.pingAt, now) } catch { return null }
}

/** Why there is no ETA, in the words the Tracking tab already uses. */
export function etaUnavailableReason(geo: LegGeometry): string {
  if (!geo.lastKnown || !geo.pingAt) return 'No timestamped position reported yet.'
  if (!geo.destination) return 'No pending delivery with coordinates.'
  return 'Position or timestamp is invalid.'
}

/** "4 min ago"-style freshness: green dot only for a ping younger than 30 minutes. */
export function isFreshPing(pingAt: string | null | undefined, nowMs: number): boolean {
  const at = Date.parse(pingAt ?? '')
  return Number.isFinite(at) && nowMs - at >= 0 && nowMs - at < FRESH_PING_MS
}

export function formatMiles(miles: number | null | undefined): string {
  return miles == null || !Number.isFinite(miles) ? '—' : `${Math.round(miles).toLocaleString('en-US')} mi`
}

export function formatDriveTime(minutes: number | null | undefined): string {
  if (minutes == null || !Number.isFinite(minutes)) return '—'
  const total = Math.max(0, Math.round(minutes))
  const h = Math.floor(total / 60)
  const m = total % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

export interface StatusTimelineInput {
  row: Pick<ShipmentRow, 'loadStatus' | 'deliveredAt'>
  bundle: ShipmentBundle | null | undefined
  /** Caller clock; reserved so the signature matches the other derivations. */
  nowMs: number
  /** The ETA to the pending delivery, when one can be computed. */
  eta?: Pick<ComputedTrackingEta, 'etaAt'> | null
}

function isConfirmed(leg: LoadCarrierRecord | null): boolean {
  if (!leg) return false
  if (leg.kind === 'OWN_ASSET') return Boolean(leg.driverId || leg.driverName)
  return leg.rateConStatus === 'SENT' || leg.rateConStatus === 'OPENED' || leg.rateConStatus === 'SIGNED'
    || Boolean(leg.rateConSignedAt || leg.rateConSentAt)
}

/** Minutes the ETA runs past the delivery appointment; null when on time, unknown, or under the pill threshold. */
export function lateMinutes(appt: string | null | undefined, etaAt: string | null | undefined): number | null {
  const a = Date.parse(appt ?? '')
  const e = Date.parse(etaAt ?? '')
  if (!Number.isFinite(a) || !Number.isFinite(e)) return null
  const minutes = Math.round((e - a) / 60_000)
  return minutes >= LATE_PILL_MINUTES ? minutes : null
}

export function buildStatusTimeline({ row, bundle, eta }: StatusTimelineInput): TmsTimelineItem[] {
  const load = bundle?.loads[0] ?? null
  const leg = load ? bundle?.loadCarriers.find((c) => c.loadId === load.id && c.status === 'ACTIVE') ?? null : null
  const stops = [...(load?.stops ?? [])].sort((a, b) => a.sequence - b.sequence)
  const pickup = stops.find((s) => s.type === 'pickup')
  const finalDelivery = [...stops].reverse().find((s) => s.type === 'delivery')
  const status = row.loadStatus ?? load?.status ?? null

  const onRoute = status != null && (MOVEMENT_STATUSES.includes(status) || DELIVERED_STATUSES.includes(status))
  const arrived = status != null && ARRIVED_STATUSES.includes(status)
  const delivered = status != null && DELIVERED_STATUSES.includes(status)
  // A shipment that moved or arrived was necessarily confirmed, even if the rate con rung says otherwise.
  const confirmed = isConfirmed(leg) || onRoute

  const deliveredTime = load?.deliveredAt ?? row.deliveredAt ?? null
  const arrivedTime = finalDelivery?.arrivedAt ?? null
  const deliveryAppt = finalDelivery && finalDelivery.apptType !== 'tbd' && finalDelivery.apptType !== 'fcfs'
    ? finalDelivery.apptEnd || finalDelivery.appt
    : null
  const late = onRoute && !arrived ? lateMinutes(deliveryAppt, eta?.etaAt) : null

  const steps: Array<{ id: string; title: string; done: boolean; time: string | null; tag?: string }> = [
    { id: 'scheduled', title: 'Scheduled', done: true, time: pickup?.appt ?? null },
    { id: 'confirmed', title: 'Confirmed', done: confirmed, time: leg ? leg.rateConSignedAt ?? leg.rateConSentAt ?? leg.bookedAt ?? null : null },
    { id: 'on-route', title: 'On route', done: onRoute, time: leg?.dispatchedAt ?? null, tag: late != null ? `${late} min late` : undefined },
    { id: 'arrived', title: 'Arrived', done: arrived, time: arrivedTime },
    { id: 'delivered', title: 'Delivered', done: delivered, time: deliveredTime },
  ]

  let currentAssigned = false
  return steps.map((step) => {
    let state: TmsTimelineItem['state'] = 'done'
    if (!step.done) {
      state = currentAssigned ? 'upcoming' : 'current'
      currentAssigned = true
    }
    return {
      id: step.id,
      title: step.title,
      state,
      ...(step.tag ? { tag: step.tag } : {}),
      ...(step.time ? { at: formatDateTime(step.time) } : {}),
      testId: `status-step-${step.id}`,
    }
  })
}
