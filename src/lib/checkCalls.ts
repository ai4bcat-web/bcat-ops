/**
 * Check calls: the per-load tracking log, and the rules that read it.
 *
 * A check call is any fact about where the freight is — what a dispatcher was told
 * on the phone, what the driver app stamped, what a tapped link pinged. Only two of
 * them are evidence of movement: ARRIVED and DEPARTED stamp a stop clock, and the
 * status that follows comes from `loadStatusFromStopTimes` in `./shipmentStatus`.
 * There is no second status ladder here, and nothing else moves a load.
 *
 * Reminders are a clock, not a state machine: a load carries `nextCheckCallAt`, and
 * where now falls relative to it (plus the grace minutes) is the whole of DUE and
 * OVERDUE. The notified stamps are compared against that same schedule, so moving
 * the next check call re-arms both notices without anybody clearing a flag.
 *
 * Imports are relative and type-only where they can be: the shipment, tracking and
 * projector Lambdas bundle this file by path, so a `@/` alias would break the
 * function build.
 */
import type {
  ChargeCodeDef,
  ChargeSide,
  CheckCallSource,
  CheckCallType,
  IncidentType,
  LastKnownSource,
  LoadChargeInput,
  LoadWorkflowStatus,
  StopEventType,
} from '../types/tms'
import type { StopTimesLike } from './shipmentStatus'
import { loadStatusFromStopTimes } from './shipmentStatus'
import { chargeAmount } from './shipmentCharges'

export type { CheckCallSource, CheckCallType, IncidentType, StopEventType } from '../types/tms'

export const CHECK_CALL_TYPES = [
  'DISPATCH',
  'LOCATION_UPDATE',
  'ARRIVED',
  'DEPARTED',
  'ETA_UPDATE',
  'INCIDENT',
  'NOTE',
  'TRACKING_LINK_SENT',
  'TRACKING_PING',
] as const satisfies readonly CheckCallType[]

/**
 * What a person may log by hand. DISPATCH, ETA_UPDATE and the two TRACKING_ rows are
 * written by the actions that cause them, never typed into the dialog.
 */
export const MANUALLY_LOGGABLE_TYPES = [
  'LOCATION_UPDATE',
  'ARRIVED',
  'DEPARTED',
  'INCIDENT',
  'NOTE',
] as const satisfies readonly CheckCallType[]

export const CHECK_CALL_SOURCES = [
  'MANUAL',
  'DRIVER_APP',
  'LINK',
  'SYSTEM',
] as const satisfies readonly CheckCallSource[]

/** MVMNT's `LoadCheckCallIncidentType`, verbatim (spec §6.1). */
export const INCIDENT_TYPES = [
  'ACCIDENT',
  'ACTUAL_CLAIM',
  'ATTEMPTED_DELIVERY',
  'BREAKDOWN',
  'DELAY',
  'DELIVERY_NOT_COMPLETED',
  'DETENTION',
  'FRAUD',
  'GENERAL_EXCEPTION',
  'LAYOVER',
  'LOAD_LOCK_ALERT',
  'OVERAGE_SHORTAGE',
  'PICKUP_EXCEPTION',
  'POTENTIAL_CLAIM',
  'REFUSED_BY_CONSIGNEE',
  'REJECTION',
  'SHIPMENT_CANCELLED',
  'SHIPMENT_DAMAGED',
  'SHIPMENT_DELAYED',
  'SHIPMENT_RECONSIGNED',
  'SHIPMENT_RETURNED_TO_SHIPPER',
  'STORAGE_IN_TRANSIT',
  'TONU',
] as const satisfies readonly IncidentType[]

export const CHECK_CALL_TYPE_LABELS: Record<CheckCallType, string> = {
  DISPATCH: 'Dispatched',
  LOCATION_UPDATE: 'Location update',
  ARRIVED: 'Arrived',
  DEPARTED: 'Departed',
  ETA_UPDATE: 'ETA update',
  INCIDENT: 'Exception',
  NOTE: 'Note',
  // Neutral on purpose: the row's own note says whether the text actually left
  // (on dev, with Twilio unconfigured, it never does).
  TRACKING_LINK_SENT: 'Tracking link',
  TRACKING_PING: 'Driver ping',
}

export const INCIDENT_TYPE_LABELS: Record<IncidentType, string> = {
  ACCIDENT: 'Accident',
  ACTUAL_CLAIM: 'Actual claim',
  ATTEMPTED_DELIVERY: 'Attempted delivery',
  BREAKDOWN: 'Breakdown',
  DELAY: 'Delay',
  DELIVERY_NOT_COMPLETED: 'Delivery not completed',
  DETENTION: 'Detention',
  FRAUD: 'Fraud',
  GENERAL_EXCEPTION: 'General exception',
  LAYOVER: 'Layover',
  LOAD_LOCK_ALERT: 'Load lock alert',
  OVERAGE_SHORTAGE: 'Overage / shortage',
  PICKUP_EXCEPTION: 'Pickup exception',
  POTENTIAL_CLAIM: 'Potential claim',
  REFUSED_BY_CONSIGNEE: 'Refused by consignee',
  REJECTION: 'Rejection',
  SHIPMENT_CANCELLED: 'Shipment cancelled',
  SHIPMENT_DAMAGED: 'Shipment damaged',
  SHIPMENT_DELAYED: 'Shipment delayed',
  SHIPMENT_RECONSIGNED: 'Shipment reconsigned',
  SHIPMENT_RETURNED_TO_SHIPPER: 'Returned to shipper',
  STORAGE_IN_TRANSIT: 'Storage in transit',
  TONU: 'Truck ordered not used',
}

/** Hours to the next check call when nobody picks a time. */
export const DEFAULT_CHECK_CALL_INTERVAL_HOURS = 4
/** How long a due check call has before it counts as overdue. */
export const DEFAULT_CHECK_CALL_GRACE_MINUTES = 15

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000

/**
 * The id of a stop event, derived rather than random.
 *
 * Both the staff action and the driver-app projector write the same row for the same
 * stamp; an id built from the stop and the event means the second writer's
 * conditional Put fails instead of logging the arrival twice.
 */
export function stopEventId(loadId: string, stopId: string, event: StopEventType): string {
  return `evt:${loadId}:${stopId}:${event}`
}

/** The minimum of a stop this module writes to. A `Stop` satisfies it. */
export interface StopStampLike {
  id: string
  arrivedAt?: string | null
  departedAt?: string | null
}

/**
 * Stamp a stop's in or out time, once.
 *
 * An existing stamp is never overwritten: the first report of an arrival is the one
 * that counts, whoever made it. Nothing changed means `stamped: false` and the same
 * array back, so the caller can skip the write entirely.
 */
export function stampStopEvent<S extends StopStampLike>(
  stops: S[],
  stopId: string,
  event: StopEventType,
  atIso: string,
): { stops: S[]; stamped: boolean } {
  const index = stops.findIndex((s) => s.id === stopId)
  if (index < 0) return { stops, stamped: false }
  const stop = stops[index]
  const already = (event === 'ARRIVED' ? stop.arrivedAt : stop.departedAt) ?? ''
  if (already.trim()) return { stops, stamped: false }

  const next = stops.slice()
  next[index] = event === 'ARRIVED' ? { ...stop, arrivedAt: atIso } : { ...stop, departedAt: atIso }
  return { stops: next, stamped: true }
}

/**
 * The status a check call just proved, or null when it proved nothing new.
 *
 * Everything is delegated to the stop clock: first pickup and last delivery only,
 * never backwards, and a canceled load stays canceled.
 */
export function statusAfterCheckCall(
  stops: StopTimesLike[],
  current?: LoadWorkflowStatus | null,
): LoadWorkflowStatus | null {
  const derived = loadStatusFromStopTimes(stops, current)
  return derived === (current ?? 'SOURCING') ? null : derived
}

/** The next check call an interval away from now, as an ISO timestamp. */
export function nextCheckCallDefault(nowIso: string, intervalHours?: number | null): string {
  const now = Date.parse(nowIso)
  if (Number.isNaN(now)) throw new Error('nextCheckCallDefault needs a valid timestamp')
  const hours =
    typeof intervalHours === 'number' && Number.isFinite(intervalHours) && intervalHours > 0
      ? intervalHours
      : DEFAULT_CHECK_CALL_INTERVAL_HOURS
  return new Date(now + hours * HOUR_MS).toISOString()
}

/** NONE: no reminder set. SCHEDULED: not yet. DUE: now. OVERDUE: past the grace. */
export type CheckCallState = 'NONE' | 'SCHEDULED' | 'DUE' | 'OVERDUE'

/** The check-call clock as the sweep reads it. A `Load` satisfies it. */
export interface CheckCallScheduleLike {
  nextCheckCallAt?: string | null
  /** When the DUE notice for the current `nextCheckCallAt` went out. */
  checkCallDueNotifiedAt?: string | null
  checkCallOverdueNotifiedAt?: string | null
}

/**
 * Where a load's reminder stands. Exactly at the due time is DUE; exactly at the due
 * time plus the grace is already OVERDUE, so a notifier that fires on the minute
 * never has to wait another cycle.
 */
export function checkCallState(
  load: CheckCallScheduleLike,
  nowMs: number,
  graceMinutes?: number | null,
): CheckCallState {
  const due = Date.parse(load.nextCheckCallAt ?? '')
  if (Number.isNaN(due)) return 'NONE'
  if (nowMs < due) return 'SCHEDULED'
  const grace =
    typeof graceMinutes === 'number' && Number.isFinite(graceMinutes) && graceMinutes >= 0
      ? graceMinutes
      : DEFAULT_CHECK_CALL_GRACE_MINUTES
  return nowMs >= due + grace * MINUTE_MS ? 'OVERDUE' : 'DUE'
}

export interface CheckCallSweepLoad extends CheckCallScheduleLike {
  id: string
  /** Who gets the nudge: the rep who owns the carrier relationship on this load. */
  carrierRepId?: string | null
}

export interface CheckCallSweepRow {
  loadId: string
  state: 'DUE' | 'OVERDUE'
  carrierRepId: string | null
  /** Whole minutes between the due time and now. */
  minutesLate: number
}

/**
 * The loads that need a nudge right now.
 *
 * A notice is "already sent" only when it was stamped at or after the check call it
 * was about, so rescheduling a check call re-arms both the due and the overdue
 * notice without anybody clearing a flag.
 */
export function sweepCheckCalls(
  loads: CheckCallSweepLoad[],
  nowMs: number,
  graceMinutes?: number | null,
): CheckCallSweepRow[] {
  const rows: CheckCallSweepRow[] = []
  for (const load of loads) {
    const state = checkCallState(load, nowMs, graceMinutes)
    if (state !== 'DUE' && state !== 'OVERDUE') continue
    const due = Date.parse(load.nextCheckCallAt ?? '')
    const notified =
      state === 'DUE' ? load.checkCallDueNotifiedAt : load.checkCallOverdueNotifiedAt
    const notifiedAt = Date.parse(notified ?? '')
    if (!Number.isNaN(notifiedAt) && notifiedAt >= due) continue
    rows.push({
      loadId: load.id,
      state,
      carrierRepId: load.carrierRepId ?? null,
      minutesLate: Math.floor((nowMs - due) / MINUTE_MS),
    })
  }
  return rows
}

/** What a check call says about where the load is. */
export interface CheckCallFact {
  at: string
  type: CheckCallType
  source: CheckCallSource
  city?: string | null
  state?: string | null
  lat?: number | null
  lng?: number | null
}

/** The Load columns a check call refreshes. Only the keys it actually knows are set. */
export interface LoadTrackingPatch {
  lastCheckCallAt: string
  lastCheckCallType: CheckCallType
  lastKnownAt?: string
  lastKnownCity?: string | null
  lastKnownState?: string | null
  lastKnownLat?: number | null
  lastKnownLng?: number | null
  lastKnownSource?: LastKnownSource
}

/**
 * The Load patch one event implies.
 *
 * Every event refreshes `lastCheckCall*`; only one that actually carries a place
 * touches `lastKnown*`, and when it does it replaces the lot — a ping with
 * coordinates must not leave yesterday's city sitting beside it.
 */
export function lastKnownPatch(event: CheckCallFact): LoadTrackingPatch {
  const patch: LoadTrackingPatch = {
    lastCheckCallAt: event.at,
    lastCheckCallType: event.type,
  }
  const city = (event.city ?? '').trim() || null
  const state = (event.state ?? '').trim() || null
  const lat = typeof event.lat === 'number' && Number.isFinite(event.lat) ? event.lat : null
  const lng = typeof event.lng === 'number' && Number.isFinite(event.lng) ? event.lng : null
  if (city == null && state == null && (lat == null || lng == null)) return patch

  patch.lastKnownAt = event.at
  patch.lastKnownCity = city
  patch.lastKnownState = state
  patch.lastKnownLat = lat
  patch.lastKnownLng = lng
  patch.lastKnownSource = event.source
  return patch
}

/** A charge the incident dialog asked for. BOTH bills the customer and pays the carrier. */
export interface IncidentChargeRequest {
  side: ChargeSide | 'BOTH'
  code: string
  label?: string | null
  rateCents: number
  count?: number | null
}

export interface IncidentChargeContext {
  charges: IncidentChargeRequest[]
  /** The charge lines already on the shipment; only their `sortOrder` is read. */
  existing?: { sortOrder?: number | null }[] | null
  orderId?: string | null
  loadId: string
  /** The ACTIVE assignment. Required before anything may be charged to a carrier. */
  loadCarrierId?: string | null
  /** The org catalog, for the label when the dialog did not type one. */
  codes?: ChargeCodeDef[] | null
}

/** A charge line ready to store, with the amount the FLAT math gives it. */
export interface IncidentChargeLine extends LoadChargeInput {
  amountCents: number
}

/**
 * The charge lines an incident creates.
 *
 * Incident money is always FLAT × count — detention is three hours at a rate, not a
 * percentage of anything — and never part of the Rate, so these lines add to revenue
 * and cost without disturbing the linehaul the margin is measured against. New lines
 * land after everything already on the shipment, in the order they were entered.
 */
export function incidentChargeLines(ctx: IncidentChargeContext): IncidentChargeLine[] {
  const carrierId = ctx.loadCarrierId?.trim() || null
  const existing = ctx.existing ?? []
  let sortOrder = existing.reduce((max, line) => Math.max(max, Number(line.sortOrder ?? 0) + 1), 0)

  const lines: IncidentChargeLine[] = []
  for (const charge of ctx.charges) {
    const code = (charge.code ?? '').trim().toUpperCase()
    if (!code) throw new Error('A charge line needs a code')
    if (typeof charge.rateCents !== 'number' || !Number.isFinite(charge.rateCents)) {
      throw new Error(`${code}: amount must be a number of cents`)
    }
    const count = charge.count ?? 1
    if (!Number.isFinite(count) || count <= 0) throw new Error(`${code}: count must be above zero`)

    const sides: ChargeSide[] =
      charge.side === 'BOTH' ? ['CUSTOMER', 'CARRIER'] : [charge.side]
    for (const side of sides) {
      if (side === 'CARRIER' && carrierId == null) {
        throw new Error(`${code}: a carrier charge needs an active carrier on the load`)
      }
      if (side === 'CARRIER' && charge.rateCents < 0) {
        throw new Error(`${code}: a carrier charge cannot be negative`)
      }
      const line: IncidentChargeLine = {
        side,
        orderId: ctx.orderId ?? null,
        loadId: ctx.loadId,
        loadCarrierId: side === 'CARRIER' ? carrierId : null,
        code,
        label:
          (charge.label ?? '').trim() ||
          ctx.codes?.find((c) => c.code.toUpperCase() === code)?.label ||
          code,
        calculatedBy: 'FLAT',
        rateCents: charge.rateCents,
        count,
        isRate: false,
        release: null,
        sortOrder: sortOrder++,
        note: null,
        amountCents: 0,
      }
      line.amountCents = chargeAmount(line)
      lines.push(line)
    }
  }
  return lines
}
