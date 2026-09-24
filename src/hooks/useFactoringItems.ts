import { useState, useEffect, useRef, useCallback } from 'react'
import { listFactoringItems, updateFactoringItem, deleteFactoringItem } from '@/lib/apiClient'
import type { FactoringItem, FactoringItemStatus } from '@/types'

const POLL_MS = 30_000

export interface UseFactoringItemsResult {
  items: FactoringItem[]
  loading: boolean
  error: string | null
  pendingIds: Set<string>
  refresh: () => void
  updateStatus: (id: string, status: FactoringItemStatus) => Promise<FactoringItem>
  removeItem: (id: string) => Promise<void>
}

export function useFactoringItems(): UseFactoringItemsResult {
  const [items, setItems] = useState<FactoringItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set())
  const pendingIdsRef = useRef<Set<string>>(new Set())
  const snapshotRef = useRef<Map<string, FactoringItem>>(new Map())
  const deletedAtRef = useRef<Map<string, string>>(new Map())

  const syncPending = useCallback((next: Set<string>) => {
    pendingIdsRef.current = next
    setPendingIds(next)
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const next = await listFactoringItems()
      setItems((prev) => {
        const pending = pendingIdsRef.current
        const deleted = deletedAtRef.current
        const prevMap = new Map(prev.map((i) => [i.id, i]))
        const nextMap = new Map(next.map((i) => [i.id, i]))
        const merged: FactoringItem[] = []

        // Merge by updatedAt so:
        // 1. Optimistic pending items are never overwritten by a poll.
        // 2. A poll that started before a completed mutation cannot clobber the
        //    confirmed new status (its updatedAt is older).
        // 3. Brand-new rows arriving via direct Dynamo inserts are preserved.
        // 4. Older overlapping list responses lose to newer ones.
        // 5. A poll that started before a successful delete cannot resurrect the
        //    deleted row, while a genuinely new later forward with the same PRO
        //    (and therefore possibly the same id) is allowed because its
        //    updatedAt is newer than the deletion timestamp.
        for (const id of new Set([...prevMap.keys(), ...nextMap.keys()])) {
          if (pending.has(id)) {
            merged.push(prevMap.get(id)!)
            continue
          }
          const incoming = nextMap.get(id)
          const current = prevMap.get(id)
          if (!incoming) continue
          const deletedAt = deleted.get(id)
          if (deletedAt && incoming.updatedAt <= deletedAt) {
            // Stale poll returning a successfully deleted row.
            continue
          }
          if (!current || incoming.updatedAt > current.updatedAt) {
            merged.push(incoming)
          } else {
            merged.push(current)
          }
        }
        return merged
      })
      setError(null)
    } catch (err) {
      console.error('[useFactoringItems] fetch error', err)
      setError(err instanceof Error ? err.message : 'Failed to load factoring items')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const immediate = setTimeout(load, 0)
    const id = setInterval(load, POLL_MS)
    return () => {
      clearTimeout(immediate)
      clearInterval(id)
    }
  }, [load])

  const updateStatus = useCallback(async (id: string, status: FactoringItemStatus) => {
    const prev = items.find((i) => i.id === id)
    if (!prev) throw new Error('Item not found')
    if (prev.status === status) return prev

    snapshotRef.current.set(id, prev)
    syncPending(new Set(pendingIdsRef.current).add(id))
    setItems((all) => all.map((i) => (i.id === id ? { ...i, status } : i)))

    try {
      const updated = await updateFactoringItem(id, { status })
      setItems((all) => all.map((i) => (i.id === id ? updated : i)))
      snapshotRef.current.delete(id)
      syncPending((() => {
        const next = new Set(pendingIdsRef.current)
        next.delete(id)
        return next
      })())
      return updated
    } catch (err) {
      // Save failed — revert to the previous server-known value so the UI
      // doesn't display a status that didn't persist.
      const snapshot = snapshotRef.current.get(id)
      if (snapshot) {
        setItems((all) => all.map((i) => (i.id === id ? snapshot : i)))
      }
      snapshotRef.current.delete(id)
      syncPending((() => {
        const next = new Set(pendingIdsRef.current)
        next.delete(id)
        return next
      })())
      throw err
    }
  }, [items, syncPending])

  const removeItem = useCallback(async (id: string) => {
    const target = items.find((i) => i.id === id)
    if (!target) throw new Error('Item not found')

    syncPending(new Set(pendingIdsRef.current).add(id))

    try {
      await deleteFactoringItem(id)
      setItems((all) => all.filter((i) => i.id !== id))
      deletedAtRef.current.set(id, target.updatedAt)
      syncPending((() => {
        const next = new Set(pendingIdsRef.current)
        next.delete(id)
        return next
      })())
    } catch (err) {
      syncPending((() => {
        const next = new Set(pendingIdsRef.current)
        next.delete(id)
        return next
      })())
      throw err
    }
  }, [items, syncPending])

  return { items, loading, error, pendingIds, refresh: load, updateStatus, removeItem }
}
