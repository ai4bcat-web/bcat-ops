import { useCallback, useEffect, useRef, useState } from 'react'
import { graphqlErrorText } from '@/lib/apiClient'
import {
  getPodConnectionStatus,
  listPods,
  syncPods,
} from '@/lib/podsClient'
import type { PodConnectionStatus, PodDocument } from '@/types/pods'

const isBrowser = typeof window !== 'undefined'

export interface UsePodDocumentsReturn {
  status: PodConnectionStatus | null
  statusLoading: boolean
  statusError: string | null
  docs: PodDocument[]
  nextToken: string | null
  loading: boolean
  error: string | null
  syncing: boolean
  syncImported: number
  syncSkipped: number
  syncError: string | null
  refresh: () => Promise<void>
  loadMore: () => Promise<void>
  syncFirstPage: () => Promise<void>
  syncAll: () => Promise<void>
  cancelSync: () => void
  patchDoc: (id: string, updater: (d: PodDocument) => PodDocument) => void
  refreshStatus: () => Promise<void>
}

export function usePodDocuments(options?: { loadId?: string | null; autoSync?: boolean }): UsePodDocumentsReturn {
  const { loadId, autoSync = true } = options ?? {}

  const [status, setStatus] = useState<PodConnectionStatus | null>(null)
  const [statusLoading, setStatusLoading] = useState(false)
  const [statusError, setStatusError] = useState<string | null>(null)

  const [docs, setDocs] = useState<PodDocument[]>([])
  const [nextToken, setNextToken] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [syncing, setSyncing] = useState(false)
  const [syncImported, setSyncImported] = useState(0)
  const [syncSkipped, setSyncSkipped] = useState(0)
  const [syncError, setSyncError] = useState<string | null>(null)
  const cancelRef = useRef(false)
  const configuredRef = useRef(false)
  // Mirrors `docs` for use inside async callbacks without re-creating them.
  const docsRef = useRef<PodDocument[]>([])
  useEffect(() => { docsRef.current = docs }, [docs])

  const loadStatus = useCallback(async () => {
    setStatusLoading(true)
    setStatusError(null)
    try {
      const s = await getPodConnectionStatus()
      configuredRef.current = s.configured
      setStatus(s)
      return s
    } catch (err) {
      const msg = graphqlErrorText(err) || 'Could not load JobsDone status'
      setStatusError(msg)
      return null
    } finally {
      setStatusLoading(false)
    }
  }, [])

  const fetchList = useCallback(async (opts?: { nextToken?: string | null; mode?: 'append' | 'replace' | 'merge' }) => {
    setLoading(true)
    setError(null)
    try {
      const page = await listPods({ loadId: loadId ?? undefined, nextToken: opts?.nextToken ?? undefined })
      const mode = opts?.mode ?? 'append'
      setDocs((prev) => {
        if (mode === 'replace') return page.items
        if (mode === 'append') return [...prev, ...page.items]
        // merge: refresh the first page in place and keep every older page the user
        // already loaded, so a background refresh never snaps the list back to page 1.
        const seen = new Set(page.items.map((d) => d.id))
        return [...page.items, ...prev.filter((d) => !seen.has(d.id))]
      })
      // A merge onto an empty list (e.g. refresh right after the first sync) is
      // effectively the first page, so it must still expose "Load more".
      if (mode !== 'merge' || docsRef.current.length === 0) setNextToken(page.nextToken)
    } catch (err) {
      setError(graphqlErrorText(err) || 'Could not load POD documents')
    } finally {
      setLoading(false)
    }
  }, [loadId])

  const refresh = useCallback(async () => {
    await fetchList({ mode: 'merge' })
  }, [fetchList])

  const loadMore = useCallback(async () => {
    if (nextToken == null || loading) return
    await fetchList({ nextToken })
  }, [nextToken, loading, fetchList])

  const syncFirstPage = useCallback(async () => {
    if (!configuredRef.current) return
    setSyncError(null)
    try {
      const r = await syncPods(null)
      setSyncImported(r.imported)
      setSyncSkipped(r.skipped)
    } catch (err) {
      setSyncError(graphqlErrorText(err) || 'Could not sync JobsDone feed')
    }
  }, [])

  const syncAll = useCallback(async () => {
    if (!configuredRef.current || syncing) return
    setSyncing(true)
    setSyncError(null)
    setSyncImported(0)
    setSyncSkipped(0)
    cancelRef.current = false
    let imported = 0
    let skipped = 0
    let token: string | null = null

    try {
      do {
        const r = await syncPods(token)
        if (cancelRef.current) break
        imported += r.imported
        skipped += r.skipped
        setSyncImported(imported)
        setSyncSkipped(skipped)
        token = r.nextToken
      } while (token && !cancelRef.current)
    } catch (err) {
      setSyncError(graphqlErrorText(err) || 'Sync failed')
    } finally {
      setSyncing(false)
    }

    // Always refresh the visible list after a sync attempt; keep existing docs if it failed.
    await refresh()
  }, [syncing, refresh])

  const cancelSync = useCallback(() => {
    cancelRef.current = true
    setSyncing(false)
  }, [])

  const patchDoc = useCallback((id: string, updater: (d: PodDocument) => PodDocument) => {
    setDocs((prev) => prev.map((d) => (d.id === id ? updater(d) : d)))
  }, [])

  // On mount (and when the scoped load changes): status → optional first-page sync → list.
  // `status` is read through configuredRef so a fresh status object cannot restart this.
  useEffect(() => {
    let alive = true
    ;(async () => {
      const s = await loadStatus()
      if (!alive) return
      if (s?.configured && autoSync) {
        await syncFirstPage()
        if (!alive) return
      }
      await fetchList({ mode: 'replace' })
    })()
    return () => { alive = false }
  }, [loadStatus, syncFirstPage, fetchList, autoSync])

  // Pull new JobsDone messages while the PODs page is open: on return to the tab
  // and every 30 seconds. Embedded viewers (autoSync: false, e.g. the load drawer)
  // only re-read their own list so they never call the privileged sync action.
  const configured = status?.configured ?? false
  useEffect(() => {
    if (!isBrowser || !configured) return
    const pull = autoSync
      ? () => { void syncFirstPage().then(() => refresh()) }
      : () => { void refresh() }
    const onVisible = () => { if (!document.hidden) pull() }
    document.addEventListener('visibilitychange', onVisible)
    const id = setInterval(pull, 30_000)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      clearInterval(id)
    }
  }, [configured, autoSync, syncFirstPage, refresh])

  // Bounded fast refresh while any document is still being enhanced on the server.
  // Keyed on the boolean so each refreshed page does not restart the 3-minute budget.
  const hasPending = docs.some((d) => d.processingStatus === 'PENDING')
  useEffect(() => {
    if (!hasPending) return
    let ticks = 0
    const id = setInterval(() => {
      ticks += 1
      if (ticks > 60) {
        clearInterval(id)
        return
      }
      void refresh()
    }, 3_000)
    return () => clearInterval(id)
  }, [hasPending, refresh])

  return {
    status,
    statusLoading,
    statusError,
    docs,
    nextToken,
    loading,
    error,
    syncing,
    syncImported,
    syncSkipped,
    syncError,
    refresh,
    loadMore,
    syncFirstPage,
    syncAll,
    cancelSync,
    patchDoc,
    refreshStatus: async () => {
      const s = await loadStatus()
      if (s?.configured && autoSync) await syncFirstPage()
      await refresh()
    },
  }
}
