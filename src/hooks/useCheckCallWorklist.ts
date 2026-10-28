/**
 * The check-call worklist: every load with a reminder on the clock, and where that
 * reminder stands right now.
 *
 * The sparse `checkCallOpen` index answers with exactly the loads being tracked, so this
 * is a small query however big the board gets. `checkCallState` decides DUE vs OVERDUE —
 * the same function the notifier Lambda runs, so the sidebar badge, this page and the
 * Slack nudge can never disagree about a load.
 *
 * Polled like `useDispatchUnread`: one pass a minute while the tab is visible, and only
 * when the caller is somebody who may open the page.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { listCheckCallWorklist, listLoadCarriersByLoad } from '@/lib/apiClient'
import { checkCallState, type CheckCallState } from '@/lib/checkCalls'
import type { Load } from '@/types'
import type { LoadCarrierRecord } from '@/types/tms'

const POLL_MS = 60_000

export interface CheckCallWorklistRow {
  load: Load
  state: CheckCallState
  /** The ACTIVE assignment, for the carrier name and the driver's phone. */
  carrier: LoadCarrierRecord | null
}

export interface CheckCallWorklist {
  rows: CheckCallWorklistRow[]
  /** DUE + OVERDUE — what the sidebar badge counts. */
  dueCount: number
  overdueCount: number
  scheduledCount: number
  /** The clock the rows were graded against, so pages sharing this hook agree on "now". */
  nowMs: number
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function useCheckCallWorklist(opts?: { enabled?: boolean; graceMinutes?: number | null }): CheckCallWorklist {
  const enabled = opts?.enabled ?? true
  const graceMinutes = opts?.graceMinutes ?? null
  const [loads, setLoads] = useState<Load[]>([])
  const [carriers, setCarriers] = useState<Record<string, LoadCarrierRecord | null>>({})
  // Disabled callers (a sidebar badge for somebody without the page) never fetch, so the
  // hook reports "not loading" from the start rather than writing state inside the effect.
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState<string | null>(null)
  // The clock is frozen into state and advanced by the poll rather than read during
  // render: a load's DUE/OVERDUE tone only needs minute granularity, and a render-time
  // `Date.now()` is impure. The lazy initialiser runs outside the render-purity analysis.
  const [nowMs, setNowMs] = useState(() => Date.now())

  // Non-async on purpose: `react-hooks/set-state-in-effect` cannot see through an
  // `async` function, so every state write lives in an explicit promise chain — the
  // same shape `useDirectory` uses.
  const load = useCallback(() => {
    if (!enabled) return Promise.resolve()
    return listCheckCallWorklist()
      // One GetItem-shaped query per tracked load, not per board row: the worklist is
      // only the loads with a reminder set, and the driver's phone lives on the
      // assignment rather than the load.
      .then((rows) => Promise.all(
        rows.map((l) => (l.activeLoadCarrierId
          ? listLoadCarriersByLoad(l.id).then((assignments) =>
            [l.id, assignments.find((c) => c.id === l.activeLoadCarrierId) ?? null] as const)
          : Promise.resolve([l.id, null] as const))),
      ).then((pairs) => {
        setLoads(rows)
        setCarriers(Object.fromEntries(pairs))
        setNowMs(Date.now())
        setError(null)
      }))
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Check calls failed to load') })
      .finally(() => setLoading(false))
  }, [enabled])

  useEffect(() => {
    if (!enabled) return
    let alive = true
    const tick = () => {
      if (document.visibilityState !== 'visible') return
      setNowMs(Date.now())
      void load()
    }
    load()
    const t = setInterval(() => { if (alive) tick() }, POLL_MS)
    return () => { alive = false; clearInterval(t) }
  }, [enabled, load])

  const rows = useMemo(() => loads.map((l) => ({
    load: l,
    state: checkCallState(l, nowMs, graceMinutes),
    carrier: carriers[l.id] ?? null,
  })), [loads, carriers, graceMinutes, nowMs])
  const refresh = useCallback(() => { setLoading(true); return load() }, [load])

  return {
    rows,
    dueCount: rows.filter((r) => r.state === 'DUE' || r.state === 'OVERDUE').length,
    overdueCount: rows.filter((r) => r.state === 'OVERDUE').length,
    scheduledCount: rows.filter((r) => r.state === 'SCHEDULED').length,
    nowMs,
    loading,
    error,
    refresh,
  }
}
