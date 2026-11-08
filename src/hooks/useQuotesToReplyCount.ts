/**
 * How many customer quotes are waiting on us — the sidebar's Quotes badge.
 *
 * One sparse-index read: `quoteOpen` carries only quotes still in play, and the three
 * rungs counted here are the ones where the next move is ours — an intake nobody has
 * priced, a reply that landed, a counter that needs answering. A quote sitting at QUOTED
 * is with the customer, not with us, and is not a chore.
 *
 * Carrier offers are deliberately not counted: the buy side's worklist is the load, and
 * a dispatcher chasing trucks is not reading the sales badge.
 *
 * Polled on the 60 s TMS clock, and only for people who can open the page — an account
 * without `quotes` would otherwise poll a list it is never shown.
 */
import { useCallback, useEffect, useState } from 'react'
import { listOpenQuotes } from '@/lib/apiClient'
import { useAuth } from '@/hooks/useAuth'
import type { QuoteStatus } from '@/types/tms'

const POLL_MS = 60_000

/** The rungs where it is our move. QUOTED and SENT_COUNTER are with the customer. */
const OURS: Partial<Record<QuoteStatus, true>> = {
  REQUESTED: true,
  RECEIVED_REPLY: true,
  RECEIVED_COUNTER: true,
}

export function useQuotesToReplyCount(): number {
  const { hasPageAccess } = useAuth()
  const enabled = hasPageAccess('quotes')
  const [count, setCount] = useState(0)

  // Non-async on purpose: `react-hooks/set-state-in-effect` cannot see through an
  // `async` function, so every state write lives in an explicit promise chain. A failed
  // read leaves the badge at its last value rather than flashing zero — "nothing to
  // answer" is a claim, and a network blip must not make it.
  const load = useCallback(() => {
    if (!enabled) return Promise.resolve()
    return listOpenQuotes()
      .then((rows) => setCount(rows.filter((q) => q.side === 'SELL' && OURS[q.status]).length))
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
