import { useState, useEffect, useRef, useCallback } from 'react'
import { toast } from 'sonner'
import { listIntakeItems, updateIntakeItem, deleteIntakeItem, notifySlackStatusChange } from '@/lib/apiClient'
import type { IntakeItem, IntakeStatus } from '@/types'

const POLL_MS = 30_000

export function useIntakeItems(filter?: { assignedTo?: string; source?: string }) {
  const { assignedTo, source } = filter ?? {}
  const key = `${assignedTo ?? ''}|${source ?? ''}`
  const [items, setItems] = useState<IntakeItem[]>([])
  // Loading is derived: true until a fetch for the CURRENT filter has settled, so a
  // filter change shows the spinner again without a synchronous reset in the effect.
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
  const prevIdsRef = useRef<Set<string>>(new Set())
  const initialLoadRef = useRef(true)

  const load = useCallback(() =>
    listIntakeItems({ assignedTo, source })
      .then((next) => {
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
      })
      .catch((err: unknown) => { console.error('[useIntakeItems] fetch error', err) })
      .finally(() => setLoadedKey(key)),
  [assignedTo, source, key])

  useEffect(() => {
    initialLoadRef.current = true
    void load()
    const id = setInterval(load, POLL_MS)
    return () => clearInterval(id)
  }, [load])

  const loading = loadedKey !== key

  const updateItem = useCallback(async (
    id: string,
    patch: {
      status?: IntakeStatus
      assignedTo?: string
      notes?: string
      builtLoadId?: string | null
      proNumber?: string | null
    },
    slackExtras?: {
      actorName?: string | null
      proNumber?: string | null       // included in DONE Slack reply
      reassignedTo?: string | null    // display name — triggers reassignment reply
    },
  ) => {
    const prev = items.find((i) => i.id === id)
    const updated = await updateIntakeItem(id, patch)
    setItems((all) => all.map((i) => (i.id === id ? updated : i)))

    // Status change notification
    if (patch.status && prev && patch.status !== prev.status) {
      notifySlackStatusChange({
        intakeItemId: id,
        oldStatus:    prev.status,
        newStatus:    patch.status,
        actorName:    slackExtras?.actorName ?? null,
        proNumber:    slackExtras?.proNumber ?? null,
      })
    }

    // Reassignment notification
    if (patch.assignedTo && prev && patch.assignedTo !== prev.assignedTo && slackExtras?.reassignedTo) {
      notifySlackStatusChange({
        intakeItemId: id,
        oldStatus:    prev.status,
        newStatus:    prev.status, // status unchanged — notifier uses reassignedTo branch
        actorName:    slackExtras?.actorName ?? null,
        reassignedTo: slackExtras.reassignedTo,
      })
    }

    return updated
  }, [items])

  const deleteItem = useCallback(async (id: string) => {
    await deleteIntakeItem(id)
    setItems((prev) => prev.filter((i) => i.id !== id))
  }, [])

  return { items, loading, refresh: load, updateItem, deleteItem }
}
