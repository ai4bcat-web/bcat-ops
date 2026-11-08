/**
 * Pure facts behind the one-line tracking strip: who is driving what, where the freight was
 * last seen, when it should land, when the next check call is due, where the POD stands
 * and who to call at the carrier. No React, no I/O; the caller owns the clock.
 */
import { checkCallState, type CheckCallState } from '@/lib/checkCalls'
import { formatBoardDateTime } from '@/lib/date'
import type { LastKnownFix } from '@/lib/trackingTimeline'
import type { DriverPhones } from '@/lib/workPhone'
import type { ShipmentBundle } from '@/types/tms'
import type { ShipmentRow } from '../../shipmentViews'
import { estimateEta, lateMinutes, legGeometry } from './statusTimeline'
import { podStateOf, type PodState } from './trackingTable'

export interface TrackingSummary {
  driver: { name: string | null; truckNumber: string | null }
  phones: DriverPhones
  lastKnown: { place: string; ageMinutes: number | null; source: string | null } | null
  eta: { at: string; estimated: boolean; lateMinutes: number | null } | null
  /** `minutes` is always positive: minutes until due (SCHEDULED) or since due (DUE/OVERDUE). */
  nextCheck: { state: CheckCallState; minutes: number | null; at: string | null }
  /** null = not due yet (not delivered) or unknowable. */
  pod: Exclude<PodState, 'NOT_DUE'> | null
  carrier: { label: string; contactName: string | null; phone: string | null; email: string | null }
}

/** "Nov 4, 3:00 PM" / "Nov 4, 3:00 PM (est.)": the strip's ETA, which the map header repeats verbatim. */
export function etaText(eta: NonNullable<TrackingSummary['eta']>): string {
  return `${formatBoardDateTime(eta.at)}${eta.estimated ? ' (est.)' : ''}`
}

const MINUTE_MS = 60_000

function minutesBetween(fromIso: string | null | undefined, nowMs: number): number | null {
  const at = Date.parse(fromIso ?? '')
  return Number.isFinite(at) ? Math.max(0, Math.round((nowMs - at) / MINUTE_MS)) : null
}

/** "Joliet, IL": the fix's own description when it is the newer one, else the load row's city; coordinates last. */
function placeOf(
  load: { lastKnownAt?: string | null; lastKnownCity?: string | null; lastKnownState?: string | null } | null,
  fix: LastKnownFix | null,
): string {
  const named = [load?.lastKnownCity, load?.lastKnownState].filter(Boolean).join(', ')
  const fixIsNewer = fix != null && !(Date.parse(load?.lastKnownAt ?? '') > Date.parse(fix.at))
  if (fix?.description && (fixIsNewer || !named)) return fix.description
  if (named) return named
  return fix ? `${fix.lat.toFixed(3)}, ${fix.lng.toFixed(3)}` : 'position unknown'
}

/**
 * POD state from the documents on the bundle when the board row is not at hand.
 * A POD is "received" once any live POD document is not awaiting review or rejected.
 */
function podFromBundle(bundle: ShipmentBundle, delivered: boolean): PodState | null {
  if (!delivered) return null
  const pods = (bundle.documents ?? []).filter((d) => d.type === 'POD' && d.status === 'ACTIVE')
  if (pods.some((d) => d.reviewStatus === 'PENDING')) return 'IN_REVIEW'
  if (pods.some((d) => d.reviewStatus !== 'REJECTED')) return 'RECEIVED'
  const leg = bundle.loadCarriers.find((c) => c.status === 'ACTIVE')
  return leg?.podRequestedAt ? 'REQUESTED' : 'NEEDED'
}

export function summaryOf(i: {
  bundle: ShipmentBundle
  /** A board row, when the caller has one: its POD projection beats re-deriving from documents. */
  row?: ShipmentRow | null
  phones: DriverPhones
  lastKnown: LastKnownFix | null
  nowMs: number
  graceMinutes?: number | null
}): TrackingSummary {
  const { bundle, row, phones, nowMs } = i
  const geo = legGeometry(bundle, bundle.shipment.id)
  const { load, leg } = geo

  // Last known: the check-call log's newest fix, else what the load row already carries.
  const fixAt = i.lastKnown?.at ?? load?.lastKnownAt ?? null
  const lastKnown = fixAt || load?.lastKnownCity || load?.lastKnownState
    ? {
        place: placeOf(load, i.lastKnown),
        ageMinutes: minutesBetween(fixAt, nowMs),
        source: (i.lastKnown?.source ?? load?.lastKnownSource ?? null),
      }
    : null

  // ETA: the carrier's stored one, then the estimate from the last ping, then the appointment.
  const appt = bundle.shipment.deliveryAppt ?? geo.destination?.appt ?? null
  let eta: TrackingSummary['eta'] = null
  if (leg?.deliveryEtaAt) {
    eta = { at: leg.deliveryEtaAt, estimated: false, lateMinutes: lateMinutes(appt, leg.deliveryEtaAt) }
  } else {
    const estimate = estimateEta(geo, new Date(nowMs).toISOString())
    if (estimate) eta = { at: estimate.etaAt, estimated: true, lateMinutes: lateMinutes(appt, estimate.etaAt) }
    else if (appt) eta = { at: appt, estimated: false, lateMinutes: null }
  }

  const state = checkCallState(load ?? {}, nowMs, i.graceMinutes)
  const due = Date.parse(load?.nextCheckCallAt ?? '')
  const nextCheck = {
    state,
    at: state === 'NONE' ? null : load?.nextCheckCallAt ?? null,
    minutes: state === 'NONE' || !Number.isFinite(due) ? null : Math.abs(Math.round((due - nowMs) / MINUTE_MS)),
  }

  const delivered = load?.status === 'DELIVERED' || load?.status === 'INVOICING'
  const pod = row && row.docsMissing != null ? podStateOf(row) : podFromBundle(bundle, delivered)

  const own = leg?.kind === 'OWN_ASSET'
  return {
    driver: { name: leg?.driverName?.trim() || null, truckNumber: phones.truckNumber ?? leg?.truckNumber ?? null },
    phones,
    lastKnown,
    eta,
    nextCheck,
    pod: pod === 'NOT_DUE' ? null : pod,
    carrier: {
      label: own ? 'Own fleet' : leg?.carrierName ?? 'No carrier',
      contactName: own ? null : leg?.dispatcherName ?? null,
      phone: own ? null : leg?.dispatcherPhone ?? null,
      email: own ? null : leg?.dispatcherEmail ?? null,
    },
  }
}
