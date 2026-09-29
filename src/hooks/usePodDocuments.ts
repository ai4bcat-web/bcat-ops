import { useCallback, useEffect, useRef, useState } from 'react'
import { graphqlErrorText } from '@/lib/apiClient'
import {
  getPodConnectionStatus,
  listPods,
  backfillPods,
  getPodSenderMappings,
  setPodSenderMapping,
} from '@/lib/podsClient'
import type { PodConnectionStatus, PodDocument, PodSenderMapping } from '@/types/pods'

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
  syncQueued: boolean
  syncError: string | null
  refresh: () => Promise<void>
  loadMore: () => Promise<void>
  startBackfill: () => Promise<void>
  patchDoc: (id: string, updater: (d: PodDocument) => PodDocument) => void
  refreshStatus: () => Promise<void>
  senderMappings: PodSenderMapping[]
  senderMappingsLoading: boolean
  refreshSenderMappings: () => Promise<void>
  saveSenderMapping: (input: { phone: string; senderName: string; driverId: string | null }) => Promise<void>
}

export function usePodDocuments(options?: { loadId?: string | null }): UsePodDocumentsReturn {
  const { loadId } = options ?? {}

  const [status, setStatus] = useState<PodConnectionStatus | null>(null)
  const [statusLoading, setStatusLoading] = useState(false)
  const [statusError, setStatusError] = useState<string | null>(null)

  const [docs, setDocs] = useState<PodDocument[]>([])
  const [nextToken, setNextToken] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [syncing, setSyncing] = useState(false)
  const [syncQueued, setSyncQueued] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [senderMappings, setSenderMappings] = useState<PodSenderMapping[]>([])
  const [senderMappingsLoading, setSenderMappingsLoading] = useState(false)
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

  const startBackfill = useCallback(async () => {
    if (!configuredRef.current || syncing) return
    setSyncing(true)
    setSyncQueued(false)
    setSyncError(null)
    try {
      await backfillPods()
      setSyncQueued(true)
    } catch (err) {
      setSyncError(graphqlErrorText(err) || "Could not start the seven-day scan")
    } finally {
      setSyncing(false)
    }
  }, [syncing])

  const patchDoc = useCallback((id: string, updater: (d: PodDocument) => PodDocument) => {
    setDocs((prev) => prev.map((d) => (d.id === id ? updater(d) : d)))
  }, [])

  const refreshSenderMappings = useCallback(async () => {
    setSenderMappingsLoading(true)
    try {
      const { items } = await getPodSenderMappings()
      setSenderMappings(items)
    } catch (err) {
      console.error('Could not load sender mappings:', graphqlErrorText(err))
    } finally {
      setSenderMappingsLoading(false)
    }
  }, [])

  const saveSenderMapping = useCallback(async (input: { phone: string; senderName: string; driverId: string | null }) => {
    const result = await setPodSenderMapping(input)
    if (result.item) {
      setSenderMappings((prev) => {
        const filtered = prev.filter((m) => m.senderKey !== result.item!.senderKey)
        return [...filtered, result.item!]
      })
    } else if (result.deleted) {
      const key = input.phone ? `phone:${(input.phone ?? '').replace(/\D/g, '').slice(-10)}` : `name:${(input.senderName ?? '').toLowerCase().replace(/[^a-z]+/g, '')}`
      setSenderMappings((prev) => prev.filter((m) => m.senderKey !== key))
    }
    await refreshSenderMappings()
  }, [refreshSenderMappings])

  // Browser sessions only read stored documents; upstream ingestion runs on AWS.
  useEffect(() => {
    let alive = true
    ;(async () => {
      await loadStatus()
      if (!alive) return
      await fetchList({ mode: 'replace' })
    })()
    return () => { alive = false }
  }, [loadStatus, fetchList])

  // Load sender mappings once when the connection is known and this is the full PODs page.
  useEffect(() => {
    if (!isBrowser || !status?.configured || loadId) return
    ;(async () => {
      await refreshSenderMappings()
    })()
  }, [status?.configured, loadId, refreshSenderMappings])

  // Refresh the gallery without triggering another upstream sync per open tab.
  const configured = status?.configured ?? false
  useEffect(() => {
    if (!isBrowser || !configured) return
    const pull = () => { void refresh() }
    const onVisible = () => { if (!document.hidden) pull() }
    document.addEventListener('visibilitychange', onVisible)
    const id = setInterval(pull, 30_000)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      clearInterval(id)
    }
  }, [configured, refresh])

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
    syncQueued,
    syncError,
    refresh,
    loadMore,
    startBackfill,
    patchDoc,
    refreshStatus: async () => {
      await loadStatus()
      await refresh()
    },
    senderMappings,
    senderMappingsLoading,
    refreshSenderMappings,
    saveSenderMapping,
  }
}
