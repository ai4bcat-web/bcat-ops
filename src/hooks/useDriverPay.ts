import { useState, useEffect, useCallback } from 'react'
import {
  listDriverPayPeriods,
  createDriverPayPeriod,
  updateDriverPayPeriod,
  deleteDriverPayPeriod,
} from '@/lib/apiClient'
import type { DriverPayPeriod } from '@/lib/apiClient'

export type { DriverPayPeriod }

export interface DriverPayState {
  payPeriods: DriverPayPeriod[]
  loading:    boolean
  error:      string | null
  refresh:    () => void
  createPay:  (input: Omit<DriverPayPeriod, 'id' | 'createdAt' | 'updatedAt'>) => Promise<DriverPayPeriod>
  updatePay:  (id: string, patch: Partial<Omit<DriverPayPeriod, 'id' | 'createdAt' | 'updatedAt'>>) => Promise<DriverPayPeriod>
  deletePay:  (id: string) => Promise<void>
}

export function useDriverPay(): DriverPayState {
  const [payPeriods, setPayPeriods] = useState<DriverPayPeriod[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setPayPeriods(await listDriverPayPeriods())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const createPay = useCallback(async (input: Omit<DriverPayPeriod, 'id' | 'createdAt' | 'updatedAt'>) => {
    const created = await createDriverPayPeriod(input)
    setPayPeriods((prev) => [...prev, created])
    return created
  }, [])

  const updatePay = useCallback(async (id: string, patch: Partial<Omit<DriverPayPeriod, 'id' | 'createdAt' | 'updatedAt'>>) => {
    const updated = await updateDriverPayPeriod(id, patch)
    setPayPeriods((prev) => prev.map((p) => p.id === id ? updated : p))
    return updated
  }, [])

  const deletePay = useCallback(async (id: string) => {
    await deleteDriverPayPeriod(id)
    setPayPeriods((prev) => prev.filter((p) => p.id !== id))
  }, [])

  return { payPeriods, loading, error, refresh: load, createPay, updatePay, deletePay }
}
