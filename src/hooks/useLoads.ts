// Data-layer hook: today returns store state; swap internals to hit an API later
import { useEffect, useMemo } from 'react'
import { isLoadVoided } from '@/lib/shipmentVoid'
import { monthsCovering } from '@/lib/shipmentWindows'
import { useAppStore } from '@/store/useAppStore'

/**
 * The two views of the Load table, kept apart on purpose.
 *
 * `store.loads` is the IDENTITY TABLE for what has been looked at: the bulk window read
 * leaves voided shipments out, but a voided load that something asked for (by id through
 * `useResolveLoads`, by PRO through `proConflictAllHistory`) is merged in, because a Pro #
 * is permanent and must stay claimed forever. The duplicate-Pro check and the PRO/id
 * matchers (Intake, PODs, factoring) read it, and they get it here as `allLoads`.
 *
 * `loads` is the LIVE WORKING SET: the same table with voided loads filtered out,
 * which is what the calendar, dispatch, the schedule, the appointment queue, the
 * fleet dashboards and every metric want. The filter runs in a `useMemo` keyed on
 * the array the selector returned — never inside the selector, because Zustand
 * compares selector results by reference and a fresh array on every call would
 * make useSyncExternalStore loop forever.
 */
export function useLoads() {
  const allLoads = useAppStore((s) => s.loads)
  const updateLoad = useAppStore((s) => s.updateLoad)
  const loads = useMemo(() => allLoads.filter((l) => !isLoadVoided(l)), [allLoads])
  return { loads, allLoads, updateLoad }
}

/**
 * Window the loads of an inclusive 'YYYY-MM-DD' range (±1 month) into the store and say
 * whether they are all there yet. The store no longer holds the whole Load table, so a
 * page or pay/metrics hook that computes over a date range calls this with that range;
 * `false` means the numbers read off `loads` so far are not final.
 */
export function useEnsureLoadRange(from: string, to: string): boolean {
  const loadedMonths = useAppStore((s) => s.loadedMonths)
  const ensureLoadRange = useAppStore((s) => s.ensureLoadRange)
  useEffect(() => {
    ensureLoadRange(from, to).catch((err: unknown) => console.warn('[useLoads] ensureLoadRange failed', from, to, err))
  }, [ensureLoadRange, from, to])
  return monthsCovering(from, to, 1).every((m) => loadedMonths.has(m))
}
