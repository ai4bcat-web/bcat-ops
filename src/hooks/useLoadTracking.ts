/**
 * One load's tracking log, as the Tracking tab reads it.
 *
 * Three sources — the check calls somebody logged, the pings a tapped link sent, and
 * Motive's breadcrumbs for an own-fleet truck — merged by `buildTimeline` into the one
 * list the tab renders. Step AO adds the map's view of the same facts: every position
 * (ELD rows by the leg's truck, load-keyed pings by load, the `Load.lastKnown*`
 * fallback) merged into `fixes`, and the one `current` marker `currentFix` picks. Nothing here decides anything: the ordering, the window and the
 * last-known fix all come from `src/lib/trackingTimeline.ts`, which the Lambdas share.
 *
 * Polled every 60 s while the tab is visible. These models have no subscriptions (the
 * shipment layer polls throughout), and a check call logged by a colleague is worth
 * seeing within a minute, not instantly.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { listCheckCallsByLoad, listLoadBreadcrumbs, listTrackingLinksByShipment, listTruckPositions } from '@/lib/apiClient'
import { currentFix, fixOfRow, isPingSource, mergeFixes, type CurrentFix, type TrackingFix } from '@/lib/trackingPings'
import {
  buildTimeline, lastKnownPosition, thinPositions, trackingWindow,
  type LastKnownFix, type TimelineItem, type TrackPosition, type TrackingWindow,
} from '@/lib/trackingTimeline'
import type { LastKnownSource, LoadCheckCallRecord, TrackingLinkRecord } from '@/types/tms'

const POLL_MS = 60_000
/**
 * Polls after the first read only ask for rows newer than the last one seen, minus this
 * overlap: a breadcrumb written by the public Lambda can reach the index a moment after a
 * poll that already passed its timestamp. Duplicates collapse in `mergeFixes`.
 */
const BREADCRUMB_OVERLAP_MS = 2 * 60_000

export interface LoadTrackingInput {
  loadId: string | null | undefined
  shipmentId: string | null | undefined
  /** The own-fleet truck whose Motive trail belongs to this leg, when there is one. */
  truckId?: string | null
  /** Where the window starts and ends: the first appointment and the drop. `lastKnown*` is the fallback when no fix exists. */
  load?: {
    pickupAppt?: string | null
    deliveredAt?: string | null
    lastKnownAt?: string | null
    lastKnownLat?: number | null
    lastKnownLng?: number | null
    lastKnownCity?: string | null
    lastKnownState?: string | null
    lastKnownSource?: LastKnownSource | null
  } | null
  loadCarrier?: { dispatchedAt?: string | null } | null
}

export interface LoadTracking {
  events: LoadCheckCallRecord[]
  links: TrackingLinkRecord[]
  positions: TrackPosition[]
  timeline: TimelineItem[]
  lastKnown: LastKnownFix | null
  /** Step AO: every position from every source, ascending. */
  fixes: TrackingFix[]
  /** Step AO: the map's current marker (and a fresher approximate overlay, if any). */
  current: CurrentFix | null
  window: TrackingWindow
  loading: boolean
  error: string | null
  /** The clock the window and the check-call tone were cut against, advanced by the poll. */
  nowMs: number
  refresh: () => Promise<void>
}

const lastKnownSourceOf = (fix: TrackingFix): LastKnownSource => {
  if (fix.source === 'motive' || fix.source === 'blueink') return 'MOTIVE'
  if (fix.source === 'link') return 'LINK'
  if (fix.source.startsWith('provider:')) return 'SYSTEM'
  return 'MANUAL'
}

function lastKnownOfFix(fix: TrackingFix): LastKnownFix {
  return {
    at: fix.at,
    lat: fix.lat,
    lng: fix.lng,
    description: fix.place,
    source: lastKnownSourceOf(fix),
    pingSource: fix.source,
    accuracyM: fix.accuracyM,
    ...(fix.approx ? { approx: true } : {}),
  }
}

/** The `Load.lastKnown*` columns as a fix — the map's answer when nothing else has reported. */
function fallbackFix(load: LoadTrackingInput['load']): TrackingFix | null {
  const lat = load?.lastKnownLat
  const lng = load?.lastKnownLng
  const at = load?.lastKnownAt
  if (typeof lat !== 'number' || typeof lng !== 'number' || !at || Number.isNaN(Date.parse(at))) return null
  const place = [load?.lastKnownCity, load?.lastKnownState].filter(Boolean).join(', ') || null
  const source = load?.lastKnownSource
  return {
    at, lat, lng, accuracyM: null, approx: false, speedMph: null, headingDeg: null, place,
    source: source === 'LINK' ? 'link' : source === 'MOTIVE' ? 'motive' : 'manual',
  }
}

export function useLoadTracking(input: LoadTrackingInput): LoadTracking {
  const { loadId, shipmentId, truckId } = input
  const pickupAppt = input.load?.pickupAppt ?? null
  const deliveredAt = input.load?.deliveredAt ?? null
  const dispatchedAt = input.loadCarrier?.dispatchedAt ?? null
  const lastKnownAt = input.load?.lastKnownAt ?? null
  const lastKnownLat = input.load?.lastKnownLat ?? null
  const lastKnownLng = input.load?.lastKnownLng ?? null
  const lastKnownCity = input.load?.lastKnownCity ?? null
  const lastKnownState = input.load?.lastKnownState ?? null
  const lastKnownSource = input.load?.lastKnownSource ?? null

  const [events, setEvents] = useState<LoadCheckCallRecord[]>([])
  const [links, setLinks] = useState<TrackingLinkRecord[]>([])
  const [positions, setPositions] = useState<TrackPosition[]>([])
  const [fleetFixes, setFleetFixes] = useState<TrackingFix[]>([])
  const [pingFixes, setPingFixes] = useState<TrackingFix[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Load-keyed breadcrumbs accumulate across polls: the first read takes the whole window,
  // later ones only what is newer. Reset when the drawer moves to another load.
  const pings = useRef<{ loadId: string | null; fixes: TrackingFix[]; lastAt: string | null }>({ loadId: null, fixes: [], lastAt: null })

  // The window moves with the clock, so it is cut once per fetch rather than per render:
  // recomputing it in the render path would hand `buildTimeline` a new object every time.
  const [range, setRange] = useState<TrackingWindow>(
    () => trackingWindow({ pickupAppt, deliveredAt }, { dispatchedAt }, new Date().toISOString()),
  )
  // Same reason, for the callers that grade a check call against "now": the clock is
  // frozen into state and moved by the poll instead of read during render. A minute of
  // granularity is all a DUE/OVERDUE tone needs.
  const [nowMs, setNowMs] = useState(() => Date.now())

  // Non-async on purpose: `react-hooks/set-state-in-effect` cannot see through an
  // `async` function, so every state write lives in an explicit promise chain — the
  // same shape `useDirectory` uses.
  const load = useCallback(() => {
    // Nothing to read yet. No state is written here: the empty answer below already
    // describes a shipment with no load.
    if (!loadId) return Promise.resolve()
    const cut = trackingWindow({ pickupAppt, deliveredAt }, { dispatchedAt }, new Date().toISOString())

    const store = pings.current
    if (store.loadId !== loadId) { store.loadId = loadId; store.fixes = []; store.lastAt = null }
    const from = store.lastAt ? new Date(Date.parse(store.lastAt) - BREADCRUMB_OVERLAP_MS).toISOString() : cut.from
    // A failed breadcrumb read keeps the last good list: the map must not blank because one poll failed.
    const breadcrumbs = Date.parse(from) > Date.parse(cut.to)
      ? Promise.resolve(store.fixes)
      : listLoadBreadcrumbs(loadId, from, cut.to)
        .then((rows) => {
          store.fixes = mergeFixes(store.fixes, rows)
          const newest = store.fixes[store.fixes.length - 1]
          if (newest) store.lastAt = newest.at
          return store.fixes
        })
        .catch(() => store.fixes)

    return Promise.all([
      listCheckCallsByLoad(loadId),
      shipmentId ? listTrackingLinksByShipment(shipmentId) : Promise.resolve([]),
      truckId ? listTruckPositions(truckId, cut.from, cut.to) : Promise.resolve([]),
      breadcrumbs,
    ])
      .then(([checkCalls, linkRows, fleetRows, loadFixes]) => {
        setRange(cut)
        setEvents(checkCalls)
        setLinks(linkRows)
        setPositions(thinPositions(fleetRows.map(({ source, ...row }) => (isPingSource(source) ? { ...row, source } : row))))
        setFleetFixes(fleetRows.map((r) => fixOfRow({ ...r })).filter((f): f is TrackingFix => f !== null))
        setPingFixes(loadFixes)
        setNowMs(Date.now())
        setError(null)
      })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Tracking failed to load') })
      .finally(() => setLoading(false))
  }, [loadId, shipmentId, truckId, pickupAppt, deliveredAt, dispatchedAt])

  useEffect(() => {
    let alive = true
    const tick = () => {
      if (document.visibilityState !== 'visible') return
      setNowMs(Date.now())
      void load()
    }
    load()
    const t = setInterval(() => { if (alive) tick() }, POLL_MS)
    return () => { alive = false; clearInterval(t) }
  }, [load])

  const timeline = useMemo(
    () => buildTimeline({ checkCalls: events, positions, links, window: range }),
    [events, positions, links, range],
  )
  const timelineLast = useMemo(() => lastKnownPosition(timeline), [timeline])

  const fixes = useMemo(() => {
    const merged = mergeFixes(fleetFixes, pingFixes)
    if (merged.length > 0) return merged
    const fallback = fallbackFix({ lastKnownAt, lastKnownLat, lastKnownLng, lastKnownCity, lastKnownState, lastKnownSource })
    return fallback ? [fallback] : []
  }, [fleetFixes, pingFixes, lastKnownAt, lastKnownLat, lastKnownLng, lastKnownCity, lastKnownState, lastKnownSource])
  const current = useMemo(() => currentFix(fixes, nowMs), [fixes, nowMs])

  // The strip keeps its shape; it just also hears about breadcrumbs that never became a check call.
  // On a tie the timeline wins: its check call carries the city and state.
  const lastKnown = useMemo(() => {
    if (!current) return timelineLast
    if (!timelineLast || Date.parse(current.fix.at) > Date.parse(timelineLast.at)) return lastKnownOfFix(current.fix)
    return timelineLast
  }, [timelineLast, current])

  const refresh = useCallback(() => { setLoading(true); return load() }, [load])

  if (!loadId) {
    return { events: [], links: [], positions: [], timeline: [], lastKnown: null, fixes: [], current: null, window: range, loading: false, error: null, nowMs, refresh }
  }
  return { events, links, positions, timeline, lastKnown, fixes, current, window: range, loading, error, nowMs, refresh }
}
