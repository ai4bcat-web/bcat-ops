import { useState, useEffect, useCallback } from 'react'
import { listTruckMileages } from '@/lib/apiClient'
import type { TruckMileage } from '@/lib/apiClient'

export type { TruckMileage }

/**
 * Lists per-truck per-day mileage (DAY rows only) from the Motive sync. DAY rows
 * are keyed (truckId, 'YYYY-MM-DD', 'DAY') and accumulate, so we fetch only that
 * granularity to keep payloads small. The fleet-profitability calc sums these
 * across a date range.
 */
export function useTruckMileage(periodType: string = 'DAY') {
  const [rows, setRows] = useState<TruckMileage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setRows(await listTruckMileages(undefined, periodType))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [periodType])

  useEffect(() => { load() }, [load])

  return { rows, loading, error, refresh: load }
}
