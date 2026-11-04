import { useMemo } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { useLoads } from '@/hooks/useLoads'
import { apptOutstanding, requiresApptProofs } from '@/lib/apptQueue'

/**
 * Batory stops still to book: the only customer whose appointments this office books (every
 * other customer's arrive booked on the rate confirmation). The same derivation the Appts
 * page uses over the same open-load set, so the card and the page cannot disagree.
 * `null` while the store is still reading its loads.
 */
export function useBatoryApptCount(): number | null {
  const { loads } = useLoads()
  const loading = useAppStore((s) => s.isLoading)
  const count = useMemo(() => apptOutstanding(loads.filter((l) => requiresApptProofs(l))).length, [loads])
  return loading ? null : count
}
