import { useState, useEffect, useCallback } from 'react'
import * as api from '@/lib/apiClient'

export type DriverAvailability = api.DriverAvailability

export function useDriverAvailability() {
  const [availabilities, setAvailabilities] = useState<api.DriverAvailability[]>([])
  const [loading, setLoading] = useState(true)

  // Poll-friendly refetch (used by the calendar's periodic refresh). Non-fatal on error.
  const refresh = useCallback(async () => {
    try { setAvailabilities(await api.listDriverAvailabilities()) }
    catch (err) { console.warn('[availability] refresh failed', err) }
  }, [])

  useEffect(() => {
    api.listDriverAvailabilities()
      .then((items) => setAvailabilities(items))
      .catch(console.error)
      .finally(() => setLoading(false))

    // Live-sync: reflect any user's availability changes on every open calendar.
    // Upsert on create/update (dedupe by id so our own optimistic write isn't doubled).
    const unsubscribe = api.subscribeToDriverAvailabilityChanges({
      onCreate: (a) => setAvailabilities((prev) => (prev.some((x) => x.id === a.id) ? prev.map((x) => (x.id === a.id ? a : x)) : [...prev, a])),
      onUpdate: (a) => setAvailabilities((prev) => prev.map((x) => (x.id === a.id ? a : x))),
      onDelete: (id) => setAvailabilities((prev) => prev.filter((x) => x.id !== id)),
    })
    return unsubscribe
  }, [])

  const createAvailability = useCallback(async (
    input: Omit<api.DriverAvailability, 'id' | 'createdAt' | 'updatedAt'>
  ) => {
    const created = await api.createDriverAvailability(input)
    setAvailabilities((prev) => [...prev, created])
    return created
  }, [])

  const updateAvailability = useCallback(async (
    id: string,
    patch: Partial<Omit<api.DriverAvailability, 'id' | 'createdAt' | 'updatedAt'>>
  ) => {
    const updated = await api.updateDriverAvailability(id, patch)
    setAvailabilities((prev) => prev.map((a) => (a.id === id ? updated : a)))
    return updated
  }, [])

  const deleteAvailability = useCallback(async (id: string) => {
    await api.deleteDriverAvailability(id)
    setAvailabilities((prev) => prev.filter((a) => a.id !== id))
  }, [])

  return { availabilities, loading, refresh, createAvailability, updateAvailability, deleteAvailability }
}
