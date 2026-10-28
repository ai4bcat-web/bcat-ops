import { useState, useEffect, useCallback } from 'react'
import { listCarriers, listCarriersByStatus } from '@/lib/apiClient'
import type { CarrierRecord, CarrierStatus } from '@/types/tms'

export type { CarrierRecord }

/** The whole table, or one status bucket off the `status` GSI. */
export type CarriersView = { kind: 'all' } | { kind: 'status'; status: CarrierStatus }

const byName = (rows: CarrierRecord[]) => [...rows].sort((a, b) => a.name.localeCompare(b.name))

/**
 * The outside-carrier directory. `view` picks the whole list or one status bucket; the
 * board holds every tab's rows at once and filters locally, so the default is `all`.
 * A failed read is reported through `error`, never rendered as an empty directory.
 */
export function useCarriers(view?: CarriersView) {
  const kind = view?.kind ?? 'all'
  const status = view?.kind === 'status' ? view.status : null
  const [carriers, setCarriers] = useState<CarrierRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // No synchronous setState before the first await (react-hooks/set-state-in-effect):
  // every state write lives in the promise chain. `refresh` sets loading itself.
  const load = useCallback(() =>
    (kind === 'status' && status ? listCarriersByStatus(status) : listCarriers())
      .then((rows) => { setCarriers(byName(rows)); setError(null) })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Carriers failed to load') })
      .finally(() => setLoading(false)),
  [kind, status])

  useEffect(() => { void load() }, [load])

  const refresh = useCallback(() => { setLoading(true); return load() }, [load])

  /** Swap in the row a carrierAction just returned — no second round trip. */
  const replace = useCallback((c: CarrierRecord) => {
    setCarriers((p) => byName(p.some((x) => x.id === c.id) ? p.map((x) => (x.id === c.id ? c : x)) : [...p, c]))
  }, [])

  return { carriers, loading, error, refresh, replace }
}
