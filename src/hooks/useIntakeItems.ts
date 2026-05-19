import { useState, useEffect, useRef, useCallback } from 'react'
import { toast } from 'sonner'
import { listIntakeItems, updateIntakeItem } from '@/lib/apiClient'
import type { IntakeItem, IntakeStatus } from '@/types'

const POLL_MS = 30_000

export function useIntakeItems(filter?: { assignedTo?: string; source?: string }) {
  const [items, setItems] = useState<IntakeItem[]>([])
  const [loading, setLoading] = useState(true)
  const prevIdsRef = useRef<Set<string>>(new Set())
  const initialLoadRef = useRef(true)

  const load = useCallback(async () => {
    try {
      const next = await listIntakeItems(filter)
      setItems(next)

      // Toast on new items (skip on initial load)
      if (!initialLoadRef.current) {
        next.forEach((item) => {
          if (!prevIdsRef.current.has(item.id)) {
            toast.info(`New intake: ${item.subject || item.fromEmail}`, {
              description: item.source === 'IVAN_CARTAGE' ? 'Ivan Cartage' : 'BCAT Logistics',
            })
          }
        })
      }
      prevIdsRef.current = new Set(next.map((i) => i.id))
      initialLoadRef.current = false
    } catch (err) {
      console.error('[useIntakeItems] fetch error', err)
    } finally {
      setLoading(false)
    }
  }, [filter?.assignedTo, filter?.source]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    initialLoadRef.current = true
    setLoading(true)
    load()
    const id = setInterval(load, POLL_MS)
    return () => clearInterval(id)
  }, [load])

  const updateItem = useCallback(async (id: string, patch: {
    status?: IntakeStatus
    assignedTo?: string
    notes?: string
    builtLoadId?: string
  }) => {
    const updated = await updateIntakeItem(id, patch)
    setItems((prev) => prev.map((i) => (i.id === id ? updated : i)))
    return updated
  }, [])

  return { items, loading, refresh: load, updateItem }
}
