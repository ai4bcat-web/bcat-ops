/**
 * Reads for the Spot inbox: the connection/org status, the request list of one tab, one
 * request with its body, and the sidebar count. Plain polling hooks (visible tab only,
 * 60 s) — the same family as `useIntakeLoads` — because a rep's inbox is tens of rows.
 *
 * Every call goes through `spotAction`; a rep only ever receives their own requests (a
 * manager may pass `userId`), and the body of a mail only comes with `SPOT_GET_REQUEST`.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { spotAction } from '@/lib/apiClient'
import type {
  SpotCountView,
  SpotGetRequestResult,
  SpotRequestRow,
  SpotRequestStatus,
  SpotStatusView,
} from '@/lib/spot/types'

export const SPOT_POLL_MS = 60_000

/** The one place the OAuth return lands; also the redirect URI registered with Google. */
export const SPOT_CALLBACK_PATH = '/tms/rates/spot/callback'
export const SPOT_INBOX_PATH = '/tms/rates/spot'

export interface SpotTabDef {
  key: string
  label: string
  statuses: SpotRequestStatus[]
}

export const SPOT_TABS: readonly SpotTabDef[] = [
  { key: 'new', label: 'New', statuses: ['NEW'] },
  { key: 'needs-info', label: 'Needs info', statuses: ['NEEDS_INFO'] },
  { key: 'sent', label: 'Sent', statuses: ['SENT'] },
  { key: 'won', label: 'Won', statuses: ['WON'] },
  { key: 'closed', label: 'Lost / dismissed', statuses: ['LOST', 'DISMISSED'] },
]

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

function useVisiblePoll(run: () => void, enabled: boolean): void {
  const ref = useRef(run)
  useEffect(() => { ref.current = run })
  useEffect(() => {
    if (!enabled) return
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') ref.current()
    }, SPOT_POLL_MS)
    return () => window.clearInterval(id)
  }, [enabled])
}

export interface SpotStatusResult {
  status: SpotStatusView | null
  loading: boolean
  error: string | null
  refresh: () => void
}

/** Connection, provider modes and org settings. Not polled: it changes only when somebody acts. */
export function useSpotStatus(): SpotStatusResult {
  const [state, setState] = useState<{ status: SpotStatusView | null; error: string | null } | null>(null)
  const load = useCallback(() => {
    let live = true
    spotAction('SPOT_STATUS', {})
      .then((status) => { if (live) setState({ status, error: null }) })
      .catch((err: unknown) => { if (live) setState((prev) => ({ status: prev?.status ?? null, error: messageOf(err) })) })
    return () => { live = false }
  }, [])
  useEffect(() => load(), [load])
  return {
    status: state?.status ?? null,
    loading: state == null,
    error: state?.error ?? null,
    refresh: () => { load() },
  }
}

export interface SpotRequestsResult {
  rows: SpotRequestRow[]
  loading: boolean
  error: string | null
  refresh: () => void
}

/** The rows of one tab, newest first. `userId` is a manager looking at another rep. */
export function useSpotRequests(opts: { tab: SpotTabDef; userId?: string; enabled?: boolean }): SpotRequestsResult {
  const { tab, userId, enabled = true } = opts
  const key = `${tab.key}|${userId ?? ''}`
  const [state, setState] = useState<{ key: string; rows: SpotRequestRow[]; error: string | null } | null>(null)
  const load = useCallback(() => {
    let live = true
    Promise.all(
      tab.statuses.map((status) => spotAction('SPOT_LIST_REQUESTS', userId ? { status, userId } : { status })),
    )
      .then((pages) => {
        if (!live) return
        const rows = pages.flatMap((p) => p.rows).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
        setState({ key, rows, error: null })
      })
      .catch((err: unknown) => { if (live) setState({ key, rows: [], error: messageOf(err) }) })
    return () => { live = false }
  }, [tab, userId, key])

  useEffect(() => (enabled ? load() : undefined), [enabled, load])
  useVisiblePoll(() => { load() }, enabled)

  const current = enabled && state?.key === key ? state : null
  return {
    rows: current?.rows ?? [],
    loading: enabled && current == null,
    error: current?.error ?? null,
    refresh: () => { load() },
  }
}

export interface SpotRequestResult {
  result: SpotGetRequestResult | null
  loading: boolean
  error: string | null
  refresh: () => void
}

/** One request with its body, thread and the draft as Gmail holds it right now. Not polled: a rep is editing it. */
export function useSpotRequest(id: string | null): SpotRequestResult {
  const [state, setState] = useState<{ id: string; result: SpotGetRequestResult | null; error: string | null } | null>(null)
  const load = useCallback(() => {
    if (!id) return undefined
    let live = true
    spotAction('SPOT_GET_REQUEST', { id })
      .then((result) => { if (live) setState({ id, result, error: result ? null : 'This request is no longer available.' }) })
      .catch((err: unknown) => { if (live) setState({ id, result: null, error: messageOf(err) }) })
    return () => { live = false }
  }, [id])
  useEffect(() => load(), [load])
  const current = id && state?.id === id ? state : null
  return {
    result: current?.result ?? null,
    loading: !!id && current == null,
    error: current?.error ?? null,
    refresh: () => { load() },
  }
}

/** The sidebar number: how many requests are waiting on this rep. A failed read keeps the last value. */
export function useSpotNewCount(enabled: boolean): number {
  const [count, setCount] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    const load = () => {
      if (document.visibilityState !== 'visible') return
      spotAction('SPOT_COUNT', {})
        .then((c: SpotCountView) => { if (alive) setCount(c.new + c.needsAttention) })
        .catch(() => {})
    }
    load()
    const t = setInterval(load, SPOT_POLL_MS)
    return () => { alive = false; clearInterval(t) }
  }, [enabled])
  return enabled ? count : 0
}

/** The three tab/badge numbers for the signed-in rep. Polled with the list; a failed read keeps the last value. */
export function useSpotCounts(): { counts: SpotCountView | null; refresh: () => void } {
  const [counts, setCounts] = useState<SpotCountView | null>(null)
  const load = useCallback(() => {
    let live = true
    spotAction('SPOT_COUNT', {})
      .then((c) => { if (live) setCounts(c) })
      .catch(() => {})
    return () => { live = false }
  }, [])
  useEffect(() => load(), [load])
  useVisiblePoll(() => { load() }, true)
  return { counts, refresh: () => { load() } }
}
