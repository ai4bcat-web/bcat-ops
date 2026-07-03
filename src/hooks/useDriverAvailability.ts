import { useState, useEffect, useCallback } from 'react'
import * as api from '@/lib/apiClient'

export type DriverAvailability = api.DriverAvailability

export function useDriverAvailability() {
  const [availabilities, setAvailabilities] = useState<api.DriverAvailability[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.listDriverAvailabilities()
      .then((items) => setAvailabilities(items))
      .catch(console.error)
      .finally(() => setLoading(false))
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

  return { availabilities, loading, createAvailability, updateAvailability, deleteAvailability }
}
