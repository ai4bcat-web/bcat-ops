/**
 * When the tracking link goes to the driver by itself (Ryne 2026-11-16):
 *
 *   "if we have driver info the tracking link should automatically send to the driver the
 *    day of the pickup date. If we have an appointment it should be an hour before the
 *    pickup time. If we don't have an appointment it should be at 8am that day. If we
 *    already have them tracking or have already sent the tracking link manually then
 *    don't automatically send again."
 *
 * Pure: the tracking-automation sweep (every 5 minutes) asks `autoTrackingDecision` per
 * carrier leg, and the Track list / tracking page use `autoTrackingSendAt` and
 * `trackingLinkStatusLabel` to say what will happen. All clock maths is America/Chicago.
 */
import { apptHasTime, chicagoDateStr, fromDateTimeInput } from './date'

/** Who a tracking link was created by when the sweep sent it. */
export const AUTO_TRACKING_SENDER = 'system:auto-tracking'

/** Minutes before a timed pickup appointment. */
export const AUTO_TRACKING_LEAD_MIN = 60
/** Chicago clock time used when the pickup has a date but no time. */
export const AUTO_TRACKING_NO_APPT_TIME = '08:00'

/** Load statuses after which the pickup has happened (or the load is over). */
const PAST_PICKUP: ReadonlySet<string> = new Set([
  'PICKED_UP', 'IN_TRANSIT', 'RECOVERED', 'ARRIVED_AT_DELIVERY_TERMINAL', 'OUT_FOR_DELIVERY',
  'UNLOADING', 'DELIVERED', 'INVOICING', 'CANCELED',
])

/** Trackers that already give us positions, so a texted link would be noise. */
const TRACKING_PROVIDERS: ReadonlySet<string> = new Set(['LINK', 'DRIVER_APP', 'MOTIVE'])

export interface AutoTrackingLoad {
  status?: string | null
  pickupAppt?: string | null
  pickupApptType?: string | null
  trackingProvider?: string | null
  /** The first pickup stop's departure, when the stops are at hand. */
  pickupDepartedAt?: string | null
}

export interface AutoTrackingLeg {
  status?: string | null
  kind?: string | null
  trackingLinkId?: string | null
  trackingStartedAt?: string | null
}

export type AutoTrackingDecision =
  | { kind: 'SEND'; sendAt: string }
  | { kind: 'WAIT'; sendAt: string }
  | { kind: 'SKIP'; reason: string; sendAt: string | null }

/**
 * The moment to text the link for this pickup, or null when there is no pickup date.
 * A timed appointment (exact, FCFS or a range: its start) → one hour before. A date with
 * no time (TBD, or stored at Chicago midnight) → 08:00 Chicago that day.
 */
export function autoTrackingSendAt(load: Pick<AutoTrackingLoad, 'pickupAppt' | 'pickupApptType'>): string | null {
  const appt = load.pickupAppt ?? ''
  const day = chicagoDateStr(appt)
  if (!day) return null
  const timed = (load.pickupApptType ?? '').toLowerCase() !== 'tbd' && apptHasTime(appt)
  if (timed) return new Date(Date.parse(appt) - AUTO_TRACKING_LEAD_MIN * 60_000).toISOString()
  return fromDateTimeInput(`${day}T${AUTO_TRACKING_NO_APPT_TIME}`)
}

/**
 * Whether the sweep running at `now` should text this leg. `hasPhone` is the driver number
 * the manual Send Tracking Link would use. Never re-sends: any link on the leg (manual or
 * automatic, live or stopped) or a tracker already reporting ends it.
 */
export function autoTrackingDecision(input: {
  now: string
  load: AutoTrackingLoad
  leg: AutoTrackingLeg
  hasPhone: boolean
}): AutoTrackingDecision {
  const { now, load, leg, hasPhone } = input
  const sendAt = autoTrackingSendAt(load)
  const skip = (reason: string): AutoTrackingDecision => ({ kind: 'SKIP', reason, sendAt })
  if (leg.status !== 'ACTIVE') return skip('Carrier is not active on the load')
  if (leg.kind !== 'CARRIER') return skip('Own truck — tracks through Motive and the driver app')
  if (leg.trackingLinkId || leg.trackingStartedAt) return skip('Tracking link already sent')
  if (TRACKING_PROVIDERS.has(String(load.trackingProvider ?? ''))) return skip('Already tracking')
  if (PAST_PICKUP.has(String(load.status ?? ''))) return skip('Past pickup')
  if (load.pickupDepartedAt) return skip('Past pickup')
  if (!sendAt) return skip('No pickup date')
  if (!hasPhone) return skip('No driver phone')
  if (chicagoDateStr(load.pickupAppt ?? '') !== chicagoDateStr(now)) {
    return chicagoDateStr(load.pickupAppt ?? '') > chicagoDateStr(now) ? { kind: 'WAIT', sendAt } : skip('Pickup day has passed')
  }
  return now >= sendAt ? { kind: 'SEND', sendAt } : { kind: 'WAIT', sendAt }
}

/** "(312) ***-**67" — enough to recognise a number in a preview, not enough to dial it. */
export function maskPhone(phone: string | null | undefined): string {
  const digits = String(phone ?? '').replace(/\D/g, '').slice(-10)
  if (digits.length < 4) return digits ? '***' : '—'
  return digits.length === 10 ? `(${digits.slice(0, 3)}) ***-**${digits.slice(-2)}` : `***${digits.slice(-2)}`
}

const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' })
const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'numeric', day: 'numeric' })

/** The Track list / tracking page line: sent manually 10:02 · auto-sends at 7:00 AM · sent automatically 7:00 AM. */
export function trackingLinkStatusLabel(input: {
  now: string
  /** The org's trackingLinkAuto switch (resolved policy). Off: only what already happened is shown. */
  enabled: boolean
  load: AutoTrackingLoad
  leg: (AutoTrackingLeg & { autoTrackingClaimAt?: string | null }) | null
  hasPhone: boolean
}): string | null {
  const leg = input.leg
  const clock = (iso: string) => {
    const at = new Date(iso)
    return `${chicagoDateStr(iso) === chicagoDateStr(input.now) ? '' : `${dayFmt.format(at)} `}${timeFmt.format(at)}`
  }
  if (leg?.trackingStartedAt) {
    // The sweep starts the link seconds after its claim; a later start is a person re-sending.
    const auto = leg.autoTrackingClaimAt != null
      && Math.abs(Date.parse(leg.trackingStartedAt) - Date.parse(leg.autoTrackingClaimAt)) < 5 * 60_000
    return auto
      ? `Tracking link: sent automatically ${clock(leg.trackingStartedAt)}`
      : `Tracking link: sent manually ${clock(leg.trackingStartedAt)}`
  }
  if (leg?.autoTrackingClaimAt) return 'Tracking link: automatic send failed — send it by hand'
  if (!input.enabled || !leg) return null
  const decision = autoTrackingDecision({ now: input.now, load: input.load, leg, hasPhone: input.hasPhone })
  if (decision.kind === 'SKIP') return decision.reason === 'No driver phone' ? 'Tracking link: no driver phone to auto-send' : null
  if (decision.kind === 'SEND') return 'Tracking link: auto-sending now'
  const at = new Date(decision.sendAt)
  const day = chicagoDateStr(decision.sendAt) === chicagoDateStr(input.now) ? '' : `${dayFmt.format(at)} `
  return `Tracking link: auto-sends ${day}at ${timeFmt.format(at)}`
}
