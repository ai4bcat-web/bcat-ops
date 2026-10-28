/**
 * One load's tracking log, as the Tracking tab reads it.
 *
 * Three sources — the check calls somebody logged, the pings a tapped link sent, and
 * Motive's breadcrumbs for an own-fleet truck — merged by `buildTimeline` into the one
 * list the tab renders. Nothing here decides anything: the ordering, the window and the
 * last-known fix all come from `src/lib/trackingTimeline.ts`, which the Lambdas share.
 *
 * Polled every 60 s while the tab is visible. These models have no subscriptions (the
 * shipment layer polls throughout), and a check call logged by a colleague is worth
 * seeing within a minute, not instantly.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { listCheckCallsByLoad, listTrackingLinksByShipment, listTruckPositions } from '@/lib/apiClient'
import {
  buildTimeline, lastKnownPosition, thinPositions, trackingWindow,
  type LastKnownFix, type TimelineItem, type TrackPosition, type TrackingWindow,
} from '@/lib/trackingTimeline'
import type { LoadCheckCallRecord, TrackingLinkRecord } from '@/types/tms'

const POLL_MS = 60_000

export interface LoadTrackingInput {
  loadId: string | null | undefined
  shipmentId: string | null | undefined
  /** The own-fleet truck whose Motive trail belongs to this leg, when there is one. */
  truckId?: string | null
  /** Where the window starts and ends: the first appointment and the drop. */
  load?: { pickupAppt?: string | null; deliveredAt?: string | null } | null
  loadCarrier?: { dispatchedAt?: string | null } | null
}

export interface LoadTracking {
  events: LoadCheckCallRecord[]
  links: TrackingLinkRecord[]
  positions: TrackPosition[]
  timeline: TimelineItem[]
  lastKnown: LastKnownFix | null
  window: TrackingWindow
  loading: boolean
  error: string | null
  /** The clock the window and the check-call tone were cut against, advanced by the poll. */
  nowMs: number
  refresh: () => Promise<void>
}

export function useLoadTracking(input: LoadTrackingInput): LoadTracking {
  const { loadId, shipmentId, truckId } = input
  const pickupAppt = input.load?.pickupAppt ?? null
  const deliveredAt = input.load?.deliveredAt ?? null
  const dispatchedAt = input.loadCarrier?.dispatchedAt ?? null

  const [events, setEvents] = useState<LoadCheckCallRecord[]>([])
  const [links, setLinks] = useState<TrackingLinkRecord[]>([])
  const [positions, setPositions] = useState<TrackPosition[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

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
    return Promise.all([
      listCheckCallsByLoad(loadId),
      shipmentId ? listTrackingLinksByShipment(shipmentId) : Promise.resolve([]),
      truckId ? listTruckPositions(truckId, cut.from, cut.to) : Promise.resolve([]),
    ])
      .then(([checkCalls, linkRows, fixes]) => {
        setRange(cut)
        setEvents(checkCalls)
        setLinks(linkRows)
        setPositions(thinPositions(fixes))
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
  const lastKnown = useMemo(() => lastKnownPosition(timeline), [timeline])

  const refresh = useCallback(() => { setLoading(true); return load() }, [load])

  if (!loadId) {
    return { events: [], links: [], positions: [], timeline: [], lastKnown: null, window: range, loading: false, error: null, nowMs, refresh }
  }
  return { events, links, positions, timeline, lastKnown, window: range, loading, error, nowMs, refresh }
}
