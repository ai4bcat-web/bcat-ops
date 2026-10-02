import { useState, useEffect, useCallback } from 'react'
import { listTruckMileages } from '@/lib/apiClient'
import type { TruckMileage } from '@/lib/apiClient'
import { errorText } from '@/lib/errorText'

export type { TruckMileage }

/**
 * Lists per-truck per-day mileage (DAY rows only) from the Motive sync. DAY rows
 * are keyed (truckId, 'YYYY-MM-DD', 'DAY') and accumulate, so we fetch only that
 * granularity to keep payloads small. The fleet-profitability calc sums these
 * across a date range.
 */
export function useTruckMileage(periodType: string = 'DAY') {
  const [rows, setRows] = useState<TruckMileage[]>([])
  // Derived: true until a fetch for the CURRENT period type has settled.
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() =>
    listTruckMileages(undefined, periodType)
      .then((next) => { setRows(next); setError(null) })
      .catch((err: unknown) => { setError(errorText(err)) })
      .finally(() => setLoadedFor(periodType)),
  [periodType])
  const refresh = useCallback(() => { setLoadedFor(null); setError(null); return load() }, [load])

  useEffect(() => { void load() }, [load])

  return { rows, loading: loadedFor !== periodType, error, refresh }
}
