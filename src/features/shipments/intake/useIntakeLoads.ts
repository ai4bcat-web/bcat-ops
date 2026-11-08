/**
 * Reads for the Intake area. Plain polling hooks (visible tab only, 60 s), same family as
 * `useShellBadgeCounts`: the table is small — tens of rows a day — so a poll is the whole story.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { countOpenIntakeLoads, getIntakeLoad, listIntakeLoads } from '@/lib/apiClient'
import type { IntakeLoadRecord, IntakeStatus } from '@/types/intake'

export const INTAKE_POLL_MS = 60_000

function useVisiblePoll(run: () => void, enabled: boolean): void {
  const ref = useRef(run)
  useEffect(() => { ref.current = run })
  useEffect(() => {
    if (!enabled) return
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') ref.current()
    }, INTAKE_POLL_MS)
    return () => window.clearInterval(id)
  }, [enabled])
}

export interface IntakeLoadsResult {
  rows: IntakeLoadRecord[]
  loading: boolean
  error: string | null
  refresh: () => void
}

/** The intake loads in one status, newest first. `enabled: false` skips the read (rows stay empty). */
export function useIntakeLoads(opts: { status: IntakeStatus; enabled?: boolean }): IntakeLoadsResult {
  const { status, enabled = true } = opts
  const [state, setState] = useState<{ key: string; rows: IntakeLoadRecord[]; error: string | null } | null>(null)
  const key = status
  const load = useCallback(() => {
    let live = true
    listIntakeLoads({ status })
      .then((rows) => { if (live) setState({ key, rows, error: null }) })
      .catch((err: unknown) => {
        if (live) setState({ key, rows: [], error: err instanceof Error ? err.message : String(err) })
      })
    return () => { live = false }
  }, [status, key])

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

/** How many OPEN intake loads there are — the number on the Shipments header tab. */
export function useOpenIntakeCount(): number | undefined {
  const [count, setCount] = useState<number | undefined>(undefined)
  const load = useCallback(() => {
    let live = true
    countOpenIntakeLoads()
      .then((n) => { if (live) setCount(n) })
      .catch(() => { if (live) setCount(undefined) })
    return () => { live = false }
  }, [])
  useEffect(() => load(), [load])
  useVisiblePoll(() => { load() }, true)
  return count
}

export interface IntakeLoadResult {
  row: IntakeLoadRecord | null
  loading: boolean
  error: string | null
  /** Re-read from the server (used after a version conflict). */
  reload: () => Promise<void>
  /** Replace the row with a server response. */
  setRow: (row: IntakeLoadRecord) => void
}

/** One intake load by id. Not polled: a reviewer is editing it. */
export function useIntakeLoad(id: string | undefined): IntakeLoadResult {
  const [state, setState] = useState<{ id: string; row: IntakeLoadRecord | null; error: string | null } | null>(null)

  const reload = useCallback(async () => {
    if (!id) return
    try {
      const row = await getIntakeLoad(id)
      setState({ id, row, error: row ? null : 'This intake load was not found.' })
    } catch (err) {
      setState({ id, row: null, error: err instanceof Error ? err.message : String(err) })
    }
  }, [id])

  useEffect(() => {
    let live = true
    if (!id) return
    getIntakeLoad(id)
      .then((row) => { if (live) setState({ id, row, error: row ? null : 'This intake load was not found.' }) })
      .catch((err: unknown) => {
        if (live) setState({ id, row: null, error: err instanceof Error ? err.message : String(err) })
      })
    return () => { live = false }
  }, [id])

  const current = state && state.id === id ? state : null
  return {
    row: current?.row ?? null,
    loading: id != null && current == null,
    error: current?.error ?? null,
    reload,
    setRow: (row) => setState({ id: row.id, row, error: null }),
  }
}
