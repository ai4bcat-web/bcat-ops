/**
 * Step P8 — the check-call plan, and the ladder the tracking agent climbs.
 *
 * Ryne's answer, verbatim in behaviour: SMS to the driver every 4 h in transit
 * plus at pickup and delivery milestones, dispatcher e-mail in the thread at the
 * same points, escalation after 30 minutes with no reply — a call when voice
 * exists, and until then a repeat SMS plus a flag on the Tracking page.
 *
 * **Voice is deferred and says so.** `VOICE` is a declared, persisted channel that
 * the plan carries and the UI shows greyed out. `isChannelEnabled` is the single
 * place that answers "may this leg run?", so switching voice on later is one
 * boolean and an adapter, not a redesign. Nothing in this build sends a VOICE leg.
 */

export type CheckCallChannel = 'SMS' | 'EMAIL' | 'VOICE'

export const CHECK_CALL_CHANNELS: readonly CheckCallChannel[] = ['SMS', 'EMAIL', 'VOICE']

/** Why a channel is greyed out, in the words the UI prints. */
export const CHANNEL_DISABLED_REASON: Record<CheckCallChannel, string | null> = {
  SMS: null,
  EMAIL: null,
  VOICE: 'voice is not switched on yet',
}

export type CheckCallMilestone =
  | 'DISPATCHED'
  | 'AT_PICKUP'
  | 'DEPARTED_PICKUP'
  | 'IN_TRANSIT'
  | 'AT_DELIVERY'
  | 'DELIVERED'

export const CHECK_CALL_MILESTONES: readonly CheckCallMilestone[] = [
  'DISPATCHED', 'AT_PICKUP', 'DEPARTED_PICKUP', 'IN_TRANSIT', 'AT_DELIVERY', 'DELIVERED',
]

export const MILESTONE_LABELS: Record<CheckCallMilestone, string> = {
  DISPATCHED: 'Dispatched',
  AT_PICKUP: 'At pickup',
  DEPARTED_PICKUP: 'Loaded and rolling',
  IN_TRANSIT: 'In transit',
  AT_DELIVERY: 'At delivery',
  DELIVERED: 'Delivered',
}

export interface CheckCallPlan {
  /** How often, in hours, the driver is texted while the load is moving. */
  intervalHours: number
  /** Which channels the plan may use. VOICE may be listed and is never run. */
  channels: CheckCallChannel[]
  /** Which milestones get a message of their own, over and above the cadence. */
  milestones: CheckCallMilestone[]
  /** Minutes of silence after a request before the ladder escalates. */
  escalateAfterMinutes: number
  /** Whether the dispatcher gets the same beat by e-mail on the shipment thread. */
  emailDispatcher: boolean
  /** Whether the agent asks for the POD on a delivery confirmation. */
  requestPodOnDelivery: boolean
}

export const DEFAULT_CHECK_CALL_PLAN: CheckCallPlan = {
  intervalHours: 4,
  channels: ['SMS', 'EMAIL'],
  milestones: ['DISPATCHED', 'AT_PICKUP', 'DEPARTED_PICKUP', 'AT_DELIVERY', 'DELIVERED'],
  escalateAfterMinutes: 30,
  emailDispatcher: true,
  requestPodOnDelivery: true,
}

/**
 * Whether a channel may actually carry a message today.
 *
 * The one gate for the deferred voice leg: a plan may list VOICE, the editor may
 * show it, and nothing may send it.
 */
export function isChannelEnabled(channel: CheckCallChannel): boolean {
  return channel !== 'VOICE'
}

/**
 * Read a stored plan, dropping anything this build does not understand.
 *
 * Returns null rather than a default when there is nothing stored, so the caller
 * can fall through the customer → org chain instead of stopping at the first
 * record that merely has the column.
 */
export function normalizeCheckCallPlan(raw: unknown): CheckCallPlan | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const row = raw as Record<string, unknown>
  const interval = Number(row.intervalHours)
  const escalate = Number(row.escalateAfterMinutes)
  const channels = Array.isArray(row.channels)
    ? CHECK_CALL_CHANNELS.filter((c) => (row.channels as unknown[]).includes(c))
    : []
  const milestones = Array.isArray(row.milestones)
    ? CHECK_CALL_MILESTONES.filter((m) => (row.milestones as unknown[]).includes(m))
    : []
  return {
    intervalHours: Number.isFinite(interval) && interval >= 1 && interval <= 24
      ? Math.round(interval)
      : DEFAULT_CHECK_CALL_PLAN.intervalHours,
    channels: channels.length ? [...channels] : [...DEFAULT_CHECK_CALL_PLAN.channels],
    milestones: milestones.length ? [...milestones] : [...DEFAULT_CHECK_CALL_PLAN.milestones],
    escalateAfterMinutes: Number.isFinite(escalate) && escalate >= 5 && escalate <= 24 * 60
      ? Math.round(escalate)
      : DEFAULT_CHECK_CALL_PLAN.escalateAfterMinutes,
    emailDispatcher: row.emailDispatcher == null ? true : Boolean(row.emailDispatcher),
    requestPodOnDelivery: row.requestPodOnDelivery == null ? true : Boolean(row.requestPodOnDelivery),
  }
}

/** The load statuses the cadence runs through — before and after, the plan is quiet. */
const IN_MOTION: Record<string, true> = {
  DISPATCHED: true,
  LOADING: true,
  PICKED_UP: true,
  IN_TRANSIT: true,
  RECOVERED: true,
  ARRIVED_AT_DELIVERY_TERMINAL: true,
  OUT_FOR_DELIVERY: true,
  UNLOADING: true,
}

/** The milestone a load status is, when it is one at all. */
export function milestoneForStatus(status: string | null | undefined): CheckCallMilestone | null {
  switch (status) {
    case 'DISPATCHED': return 'DISPATCHED'
    case 'LOADING': return 'AT_PICKUP'
    case 'PICKED_UP': return 'DEPARTED_PICKUP'
    case 'IN_TRANSIT': return 'IN_TRANSIT'
    case 'ARRIVED_AT_DELIVERY_TERMINAL':
    case 'OUT_FOR_DELIVERY':
    case 'UNLOADING':
      return 'AT_DELIVERY'
    case 'DELIVERED': return 'DELIVERED'
    default: return null
  }
}

export interface CheckCallTickInput {
  plan: CheckCallPlan
  status: string | null | undefined
  /** When the last check call of any kind landed. */
  lastCheckCallAt?: string | null
  /** When the plan last sent a message for this milestone, keyed by milestone. */
  milestonesSent?: readonly string[] | null
  /** When a request went out with no answer yet. */
  awaitingSince?: string | null
  /** When the ladder last emailed the dispatcher, so it escalates once per silence. */
  escalatedAt?: string | null
  /** When the ladder last raised the Tracking-page exception, so it flags once per silence. */
  checkCallFlaggedAt?: string | null
  now: string
}

export type CheckCallActionKind = 'MILESTONE' | 'CADENCE' | 'ESCALATE_DISPATCHER' | 'ESCALATE_EXCEPTION' | 'NONE'

export interface CheckCallTick {
  kind: CheckCallActionKind
  milestone: CheckCallMilestone | null
  /** The channels this step actually uses — VOICE is never among them. */
  channels: CheckCallChannel[]
  /** When the next tick is due, so the Load's `nextCheckCallAt` stays honest. */
  nextDueAt: string | null
  reason: string
}

const HOUR_MS = 60 * 60 * 1000

/**
 * What the tracking agent should do for this leg right now.
 *
 * Pure, and deliberately so: the sweep, the per-shipment "Run now" button and the
 * tests all ask the same function, so what the Tracking page predicts is what the
 * agent does. Escalation wins over cadence — a driver who has not answered is a
 * bigger fact than a clock that has come round again.
 */
export function nextCheckCallAction(input: CheckCallTickInput): CheckCallTick {
  const { plan, now } = input
  const nowMs = Date.parse(now)
  const usable = plan.channels.filter(isChannelEnabled)
  const quiet: CheckCallTick = { kind: 'NONE', milestone: null, channels: [], nextDueAt: null, reason: '' }

  if (!usable.length) return { ...quiet, reason: 'The plan has no channel that is switched on' }
  if (!IN_MOTION[String(input.status ?? '')]) {
    const milestone = milestoneForStatus(input.status)
    if (milestone && plan.milestones.includes(milestone) && !(input.milestonesSent ?? []).includes(milestone)) {
      return { kind: 'MILESTONE', milestone, channels: usable, nextDueAt: null, reason: MILESTONE_LABELS[milestone] }
    }
    return { ...quiet, reason: 'The load is not moving' }
  }

  const awaitingMs = input.awaitingSince ? Date.parse(input.awaitingSince) : NaN
  if (Number.isFinite(awaitingMs)) {
    const silentMin = (nowMs - awaitingMs) / 60000
    const alreadyEmailedDispatcher = input.escalatedAt ? Date.parse(input.escalatedAt) >= awaitingMs : false
    const alreadyFlagged = input.checkCallFlaggedAt ? Date.parse(input.checkCallFlaggedAt) >= awaitingMs : false

    if (silentMin >= plan.escalateAfterMinutes && !alreadyEmailedDispatcher) {
      return {
        kind: 'ESCALATE_DISPATCHER',
        milestone: null,
        channels: usable.filter((c) => c === 'EMAIL'),
        nextDueAt: new Date(nowMs + plan.escalateAfterMinutes * 60000).toISOString(),
        reason: `No reply for ${Math.floor(silentMin)} minutes`,
      }
    }
    if (silentMin >= plan.escalateAfterMinutes * 2 && !alreadyFlagged) {
      return {
        kind: 'ESCALATE_EXCEPTION',
        milestone: null,
        channels: [],
        nextDueAt: new Date(nowMs + plan.intervalHours * HOUR_MS).toISOString(),
        reason: `No reply for ${Math.floor(silentMin)} minutes — tracking team notified`,
      }
    }
  }

  const milestone = milestoneForStatus(input.status)
  if (milestone && plan.milestones.includes(milestone) && !(input.milestonesSent ?? []).includes(milestone)) {
    return {
      kind: 'MILESTONE',
      milestone,
      channels: usable,
      nextDueAt: new Date(nowMs + plan.intervalHours * HOUR_MS).toISOString(),
      reason: MILESTONE_LABELS[milestone],
    }
  }

  const lastMs = input.lastCheckCallAt ? Date.parse(input.lastCheckCallAt) : NaN
  const dueMs = Number.isFinite(lastMs) ? lastMs + plan.intervalHours * HOUR_MS : nowMs
  if (nowMs >= dueMs) {
    return {
      kind: 'CADENCE',
      milestone: null,
      channels: usable,
      nextDueAt: new Date(nowMs + plan.intervalHours * HOUR_MS).toISOString(),
      reason: `Every ${plan.intervalHours} h in transit`,
    }
  }
  return { ...quiet, nextDueAt: new Date(dueMs).toISOString(), reason: 'Not due yet' }
}

/** The text a driver gets, with the tracking link Step D already mints. */
export function checkCallSmsBody(input: {
  shipmentNumber: string
  kind: CheckCallActionKind
  milestone: CheckCallMilestone | null
  trackingUrl: string | null
  originCity?: string | null
  destinationCity?: string | null
}): string {
  const lane = [input.originCity, input.destinationCity].filter(Boolean).join(' → ')
  const head = input.kind === 'ESCALATE_DISPATCHER' || input.kind === 'ESCALATE_EXCEPTION'
    ? `Following up on load ${input.shipmentNumber}`
    : input.milestone === 'AT_PICKUP'
      ? `Load ${input.shipmentNumber}: are you loaded?`
      : input.milestone === 'AT_DELIVERY' || input.milestone === 'DELIVERED'
        ? `Load ${input.shipmentNumber}: are you unloaded?`
        : `Check call for load ${input.shipmentNumber}`
  const lines = [head]
  if (lane) lines.push(lane)
  lines.push('Reply with your location, or tap the link to send it:')
  if (input.trackingUrl) lines.push(input.trackingUrl)
  return lines.join('\n')
}
