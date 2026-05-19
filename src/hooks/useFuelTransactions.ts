import { useState, useEffect, useCallback } from 'react'
import { listFuelTransactions } from '@/lib/apiClient'
import type { FuelTransaction } from '@/lib/apiClient'

export type { FuelTransaction }

export function useFuelTransactions() {
  const [transactions, setTransactions] = useState<FuelTransaction[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await listFuelTransactions()
      setTransactions(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const addTransactions = useCallback((added: FuelTransaction[]) => {
    setTransactions((prev) => [...prev, ...added])
  }, [])

  return { transactions, loading, error, refresh: load, addTransactions }
}
