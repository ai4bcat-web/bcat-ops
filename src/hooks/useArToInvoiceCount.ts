/**
 * How many delivered orders are sitting on UNBILLED — the sidebar's AR badge.
 *
 * One sparse-index read: `arStatus` + `arStatusChangedAt` only carries orders somebody
 * has moved, so this is the worklist itself and not a scan of the order book. Polled on
 * the 60 s TMS clock, and only for people who can open the page — an account without
 * `invoicing` would otherwise poll a list it is never shown.
 */
import { useCallback, useEffect, useState } from 'react'
import { listOrdersByArStatus } from '@/lib/apiClient'
import { useAuth } from '@/hooks/useAuth'

const POLL_MS = 60_000

export function useArToInvoiceCount(): number {
  const { hasPageAccess } = useAuth()
  const enabled = hasPageAccess('invoicing')
  const [count, setCount] = useState(0)

  // Non-async on purpose: `react-hooks/set-state-in-effect` cannot see through an
  // `async` function, so every state write lives in an explicit promise chain. A failed
  // read leaves the badge at its last value rather than flashing zero — "nothing to
  // invoice" is a claim, and a network blip must not make it.
  const load = useCallback(() => {
    if (!enabled) return Promise.resolve()
    return listOrdersByArStatus('UNBILLED')
      .then((rows) => setCount(rows.length))
      .catch(() => {})
  }, [enabled])

  useEffect(() => {
    if (!enabled) return
    let alive = true
    const tick = () => {
      if (document.visibilityState !== 'visible') return
      void load()
    }
    load()
    const t = setInterval(() => { if (alive) tick() }, POLL_MS)
    return () => { alive = false; clearInterval(t) }
  }, [enabled, load])

  return enabled ? count : 0
}
