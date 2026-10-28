/**
 * How many carrier bills are sitting on IN_REVIEW — the sidebar's AP badge.
 *
 * One sparse-index read: `apOpen` only carries assignments that still owe a carrier
 * money, so this is the worklist itself and not a scan of every leg ever booked. Polled
 * on the 60 s TMS clock, and only for people who can open the page — an account without
 * `carrierPay` would otherwise poll a list it is never shown.
 */
import { useCallback, useEffect, useState } from 'react'
import { listOpenApAssignments } from '@/lib/apiClient'
import { useAuth } from '@/hooks/useAuth'

const POLL_MS = 60_000

export function useApToReviewCount(): number {
  const { hasPageAccess } = useAuth()
  const enabled = hasPageAccess('carrierPay')
  const [count, setCount] = useState(0)

  // Non-async on purpose: `react-hooks/set-state-in-effect` cannot see through an
  // `async` function, so every state write lives in an explicit promise chain. A failed
  // read leaves the badge at its last value rather than flashing zero — "nothing to
  // review" is a claim, and a network blip must not make it.
  const load = useCallback(() => {
    if (!enabled) return Promise.resolve()
    return listOpenApAssignments('IN_REVIEW')
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
