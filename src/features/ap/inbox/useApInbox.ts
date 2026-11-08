/**
 * Step AG: the AP-inbox status (digest line, settings card) and queue reads, with the
 * "Review now" loop. State is written only inside promise chains (react-hooks/set-state-in-effect).
 */
import { useCallback, useEffect, useState } from 'react'
import { listApInboxItems, graphqlErrorText } from '@/lib/apiClient'
import type { ApInboxItemRecord, ApInboxStatus } from '@/lib/apInbox/types'
import { apInboxStatus, apInboxSyncNow, type ApInboxStatusView } from './apInboxClient'

/** One "Review now" press is at most this many 20 s slices (the cursor makes each resumable). */
export const MAX_SYNC_SLICES = 15

export interface SyncProgress { reviewed: number; remaining: number }

export interface ApInboxStatusHandle {
  status: ApInboxStatusView | null
  error: string | null
  refresh: () => Promise<void>
  syncing: boolean
  progress: SyncProgress | null
  /** Loops the budgeted slices to the end; resolves with the failure text, or null. */
  syncNow: () => Promise<string | null>
}

export function useApInboxStatus(): ApInboxStatusHandle {
  const [status, setStatus] = useState<ApInboxStatusView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [progress, setProgress] = useState<SyncProgress | null>(null)

  const refresh = useCallback(() =>
    apInboxStatus()
      .then((s) => { setStatus(s); setError(null) })
      .catch((e: unknown) => setError(graphqlErrorText(e) || 'Could not read the AP inbox status')),
  [])

  useEffect(() => { void refresh() }, [refresh])

  /** Loops the budgeted slices until the Lambda says it is done; resolves with the last error text, if any. */
  const syncNow = useCallback(async (): Promise<string | null> => {
    setSyncing(true)
    setProgress({ reviewed: 0, remaining: 0 })
    let failure: string | null = null
    try {
      for (let i = 0; i < MAX_SYNC_SLICES; i++) {
        const r = await apInboxSyncNow()
        setProgress({ reviewed: r.reviewed, remaining: r.remaining })
        if (r.done) break
      }
    } catch (e: unknown) {
      failure = graphqlErrorText(e) || 'Review failed'
    }
    setSyncing(false)
    setProgress(null)
    await refresh()
    return failure
  }, [refresh])

  return { status, error, refresh, syncing, progress, syncNow }
}

/** Items of one or more statuses, newest first. `sinceIso` bounds the history chips. */
export function useApInboxItems(statuses: ApInboxStatus[], sinceIso?: string) {
  const key = statuses.join(',')
  const [items, setItems] = useState<ApInboxItemRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() =>
    Promise.all(key.split(',').map((s) => listApInboxItems(s as ApInboxStatus, sinceIso)))
      .then((lists) => {
        setItems(lists.flat().sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)))
        setError(null)
      })
      .catch((e: unknown) => setError(graphqlErrorText(e) || 'Could not load the AP inbox'))
      .finally(() => setLoading(false)),
  [key, sinceIso])

  useEffect(() => { void refresh() }, [refresh])

  return { items, loading, error, refresh }
}
