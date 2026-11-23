import { useEffect, useState } from 'react'
import { listFactoringItems } from '@/lib/apiClient'
import { otrNoBuyByCustomer, type OtrNoBuyByCustomer } from '@/lib/otrNoBuy'

let cache: { at: number; map: OtrNoBuyByCustomer } | null = null
const FRESH_MS = 60_000

/**
 * Which customers have ever had a No buy from OTR, for screens that do not already hold the
 * factoring queue (the customer profile). One read, shared for a minute. A user who cannot read
 * the queue gets an empty map: the flag is a convenience, never a gate.
 */
export function useOtrNoBuy(): OtrNoBuyByCustomer {
  const [map, setMap] = useState<OtrNoBuyByCustomer>(() => cache?.map ?? new Map())
  useEffect(() => {
    if (cache && Date.now() - cache.at < FRESH_MS) return
    let alive = true
    try {
      listFactoringItems()
        .then((items) => {
          const next = otrNoBuyByCustomer(items)
          cache = { at: Date.now(), map: next }
          if (alive) setMap(next)
        })
        .catch(() => { /* not allowed to read the queue, or offline: no flag */ })
    } catch { /* no flag */ }
    return () => { alive = false }
  }, [])
  return map
}
