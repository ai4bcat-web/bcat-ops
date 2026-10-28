import { useState, useEffect, useCallback } from 'react'
import { getShipmentBundle } from '@/lib/apiClient'
import type { ShipmentBundle } from '@/types/tms'

export type { ShipmentBundle }

/**
 * One shipment, with its orders, loads, assignments, charges and cached money.
 *
 * `id` may be null — that is the idle drawer, and it fetches nothing. Every
 * tmsShipmentActions mutation answers with the whole bundle, so callers hand the
 * response to `replace` instead of re-reading: no second round trip, and no flash
 * of the pre-mutation state in between.
 */
export function useShipment(id: string | null) {
  const [bundle, setBundle] = useState<ShipmentBundle | null>(null)
  const [loading, setLoading] = useState(id != null)
  const [error, setError] = useState<string | null>(null)

  // No synchronous setState before the first await (react-hooks/set-state-in-effect):
  // every state write lives in the promise chain. `refresh` sets loading itself.
  const load = useCallback(() => {
    if (id == null) {
      return Promise.resolve().then(() => { setBundle(null); setError(null); setLoading(false) })
    }
    return getShipmentBundle(id)
      .then((b) => { setBundle(b); setError(null) })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Shipment failed to load') })
      .finally(() => setLoading(false))
  }, [id])

  useEffect(() => { void load() }, [load])

  const refresh = useCallback(() => { setLoading(true); return load() }, [load])

  /** Swap in the bundle a mutation just returned. */
  const replace = useCallback((next: ShipmentBundle) => {
    setBundle(next)
    setError(null)
  }, [])

  return { bundle, loading, error, refresh, replace }
}
