/**
 * One timeline out of three sources.
 *
 * A load's tracking story is told by its check calls (what people and links
 * reported), by Motive's breadcrumbs for our own trucks, and by the tracking links
 * themselves (sent, opened). None of them is copied into another table — six Motive
 * fixes an hour per truck would swamp the check-call log — so the merge happens
 * here, in memory, every time the page polls.
 *
 * Imports are relative and type-only: the tracking Lambdas bundle this file by path,
 * so a `@/` alias would break the function build.
 */
import type { LastKnownSource, LoadCheckCallRecord, TrackingLinkRecord } from '../types/tms'

/** One Motive fix, as `TruckLocationHistory` stores it. A `TruckLocation` satisfies it. */
export interface TrackPosition {
  truckId: string
  lat: number
  lon: number
  locatedAt: string
  description?: string | null
  speed?: number | null
  /** `MOVING` / `STATIONARY` when Motive reported it; otherwise read from `speed`. */
  motion?: string | null
}

export type TimelineItem =
  | { kind: 'check_call'; at: string; row: LoadCheckCallRecord }
  | {
      kind: 'position'
      at: string
      truckId: string
      lat: number
      lon: number
      locatedAt: string
      description: string | null
      speed: number | null
    }
  | { kind: 'link'; at: string; row: TrackingLinkRecord }

export interface TrackingWindow {
  from: string
  to: string
}

/** The load fields the window is cut from. */
export interface TrackingWindowLoad {
  pickupAppt?: string | null
  deliveredAt?: string | null
}

/** The assignment the window is cut from. */
export interface TrackingWindowCarrier {
  dispatchedAt?: string | null
}

const HOUR_MS = 3_600_000
const MINUTE_MS = 60_000
/** How long before the first appointment a truck is interesting, when it was never dispatched. */
const PRE_PICKUP_HOURS = 2
/** How long after delivery positions still belong to this load. */
const POST_DELIVERY_HOURS = 2
/** A load with no dates at all still gets a day of history rather than nothing. */
const FALLBACK_WINDOW_HOURS = 24

/**
 * The slice of time this load owns.
 *
 * Dispatch is the honest start — before that the truck was somebody else's problem —
 * and delivery plus a couple of hours the end, so the drop itself is still on screen.
 * An undispatched load falls back to its pickup appointment.
 */
export function trackingWindow(
  load: TrackingWindowLoad | null | undefined,
  loadCarrier: TrackingWindowCarrier | null | undefined,
  nowIso: string,
): TrackingWindow {
  const now = Date.parse(nowIso)
  if (Number.isNaN(now)) throw new Error('trackingWindow needs a valid timestamp')

  const dispatched = Date.parse(loadCarrier?.dispatchedAt ?? '')
  const pickup = Date.parse(load?.pickupAppt ?? '')
  const delivered = Date.parse(load?.deliveredAt ?? '')

  let from: number
  if (!Number.isNaN(dispatched)) from = dispatched
  else if (!Number.isNaN(pickup)) from = pickup - PRE_PICKUP_HOURS * HOUR_MS
  else from = now - FALLBACK_WINDOW_HOURS * HOUR_MS

  const to = Number.isNaN(delivered) ? now : delivered + POST_DELIVERY_HOURS * HOUR_MS
  return { from: new Date(from).toISOString(), to: new Date(Math.max(from, to)).toISOString() }
}

/**
 * Motive's firehose, cut down to what a human reads.
 *
 * The first fix is always kept, then one every `minGapMin`, plus every fix where the
 * truck started or stopped moving — a two-hour wait at a shipper is the point of the
 * trail, and dropping it because it fell between gaps would hide the story.
 */
export function thinPositions(positions: TrackPosition[], minGapMin = 15): TrackPosition[] {
  const gapMs = Math.max(0, minGapMin) * MINUTE_MS
  const ordered = positions
    .filter((p) => !Number.isNaN(Date.parse(p.locatedAt)))
    .sort((a, b) => Date.parse(a.locatedAt) - Date.parse(b.locatedAt))

  const kept: TrackPosition[] = []
  let keptAt = 0
  let keptMoving = false
  for (const position of ordered) {
    const at = Date.parse(position.locatedAt)
    const moving =
      typeof position.motion === 'string'
        ? position.motion.toUpperCase() === 'MOVING'
        : (position.speed ?? 0) > 0
    if (kept.length === 0 || moving !== keptMoving || at - keptAt >= gapMs) {
      kept.push(position)
      keptAt = at
      keptMoving = moving
    }
  }
  return kept
}

export interface TimelineInput {
  checkCalls?: LoadCheckCallRecord[] | null
  positions?: TrackPosition[] | null
  links?: TrackingLinkRecord[] | null
  /** Rows outside it are dropped. Omit to keep everything handed over. */
  window?: TrackingWindow | null
}

/** Same instant, different sources: what somebody reported outranks what a box emitted. */
const TIE_RANK: Record<TimelineItem['kind'], number> = { check_call: 0, link: 1, position: 2 }

/** Every source on one list, newest first. */
export function buildTimeline(input: TimelineInput): TimelineItem[] {
  const from = Date.parse(input.window?.from ?? '')
  const to = Date.parse(input.window?.to ?? '')
  const items: TimelineItem[] = []

  const within = (ms: number): boolean =>
    !Number.isNaN(ms) && (Number.isNaN(from) || ms >= from) && (Number.isNaN(to) || ms <= to)

  for (const row of input.checkCalls ?? []) {
    if (within(Date.parse(row.at))) items.push({ kind: 'check_call', at: row.at, row })
  }
  for (const position of input.positions ?? []) {
    if (!within(Date.parse(position.locatedAt))) continue
    items.push({
      kind: 'position',
      at: position.locatedAt,
      truckId: position.truckId,
      lat: position.lat,
      lon: position.lon,
      locatedAt: position.locatedAt,
      description: position.description ?? null,
      speed: position.speed ?? null,
    })
  }
  for (const row of input.links ?? []) {
    const at = row.sentAt ?? row.createdAt ?? null
    if (at != null && within(Date.parse(at))) items.push({ kind: 'link', at, row })
  }

  return items.sort((a, b) => {
    const diff = Date.parse(b.at) - Date.parse(a.at)
    return diff !== 0 ? diff : TIE_RANK[a.kind] - TIE_RANK[b.kind]
  })
}

/** Where the freight was last seen, and who said so. */
export interface LastKnownFix {
  at: string
  lat: number
  lng: number
  description: string | null
  source: LastKnownSource
}

/**
 * The newest fix on the timeline, whichever source it came from.
 *
 * A driver's tapped ping five minutes ago beats the truck's hour-old Motive
 * breadcrumb, and the other way round: only the clock decides.
 */
export function lastKnownPosition(items: TimelineItem[]): LastKnownFix | null {
  let best: LastKnownFix | null = null
  let bestAt = Number.NEGATIVE_INFINITY

  for (const item of items) {
    const at = Date.parse(item.at)
    if (Number.isNaN(at) || at <= bestAt) continue
    if (item.kind === 'position') {
      best = {
        at: item.at,
        lat: item.lat,
        lng: item.lon,
        description: item.description,
        source: 'MOTIVE',
      }
      bestAt = at
      continue
    }
    if (item.kind !== 'check_call') continue
    const { lat, lng } = item.row
    if (typeof lat !== 'number' || typeof lng !== 'number') continue
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
    best = {
      at: item.at,
      lat,
      lng,
      description: [item.row.city, item.row.state].filter(Boolean).join(', ') || null,
      source: item.row.source,
    }
    bestAt = at
  }
  return best
}
