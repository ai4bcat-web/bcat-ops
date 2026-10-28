import { useState, useEffect, useCallback } from 'react'
import { getCarrierBundle } from '@/lib/apiClient'
import type { CarrierBundle, CarrierRecord } from '@/types/tms'

export type { CarrierBundle }

/**
 * One carrier, with its contacts, payment methods, documents and load history.
 *
 * `id` may be null — that is the closed profile sheet, and it fetches nothing. Every
 * tmsCarrierActions mutation answers with the written row, so callers hand it to
 * `replaceCarrier` instead of re-reading; `replace` swaps a whole re-read bundle in.
 */
export function useCarrier(id: string | null) {
  const [bundle, setBundle] = useState<CarrierBundle | null>(null)
  const [loading, setLoading] = useState(id != null)
  const [error, setError] = useState<string | null>(null)

  // No synchronous setState before the first await (react-hooks/set-state-in-effect):
  // every state write lives in the promise chain. `refresh` sets loading itself.
  const load = useCallback(() => {
    if (id == null) {
      return Promise.resolve().then(() => { setBundle(null); setError(null); setLoading(false) })
    }
    return getCarrierBundle(id)
      .then((b) => { setBundle(b); setError(null) })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Carrier failed to load') })
      .finally(() => setLoading(false))
  }, [id])

  useEffect(() => { void load() }, [load])

  const refresh = useCallback(() => { setLoading(true); return load() }, [load])

  /** Swap in the bundle a re-read just returned. */
  const replace = useCallback((next: CarrierBundle) => {
    setBundle(next)
    setError(null)
  }, [])

  /** Swap in just the carrier row a mutation returned, keeping the loaded children. */
  const replaceCarrier = useCallback((carrier: CarrierRecord) => {
    setBundle((p) => (p ? { ...p, carrier } : p))
    setError(null)
  }, [])

  return { bundle, loading, error, refresh, replace, replaceCarrier }
}
