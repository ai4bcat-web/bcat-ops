import { useEffect, useState } from 'react'
import { listFactoringItems } from '@/lib/apiClient'
import { otrNoBuyByCustomer, type OtrNoBuyByCustomer } from '@/lib/otrNoBuy'

let cache: { at: number; map: OtrNoBuyByCustomer } | null = null
const FRESH_MS = 60_000

export interface OtrNoBuyState {
  map: OtrNoBuyByCustomer
  /** True once the queue was read. False for someone who may not read it, or before the read lands: no customer is shown as "not flagged". */
  loaded: boolean
}

/**
 * Which customers have ever had a No buy from OTR, for screens that do not already hold the
 * factoring queue (the customer profile and the Customers list). One read, shared for a minute. A user
 * who cannot read the queue gets an empty map: the flag is a convenience, never a gate.
 */
export function useOtrNoBuyState(): OtrNoBuyState {
  const [state, setState] = useState<OtrNoBuyState>(() => (cache ? { map: cache.map, loaded: true } : { map: new Map(), loaded: false }))
  useEffect(() => {
    if (cache && Date.now() - cache.at < FRESH_MS) return
    let alive = true
    try {
      listFactoringItems()
        .then((items) => {
          const next = otrNoBuyByCustomer(items)
          cache = { at: Date.now(), map: next }
          if (alive) setState({ map: next, loaded: true })
        })
        .catch(() => { /* not allowed to read the queue, or offline: no flag */ })
    } catch { /* no flag */ }
    return () => { alive = false }
  }, [])
  return state
}

export function useOtrNoBuy(): OtrNoBuyByCustomer {
  return useOtrNoBuyState().map
}
