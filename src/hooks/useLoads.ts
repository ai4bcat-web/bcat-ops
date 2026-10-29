// Data-layer hook: today returns store state; swap internals to hit an API later
import { useMemo } from 'react'
import { isLoadVoided } from '@/lib/shipmentVoid'
import { useAppStore } from '@/store/useAppStore'

/**
 * The two views of the Load table, kept apart on purpose.
 *
 * `store.loads` is the IDENTITY TABLE: every load ever created, voided ones
 * included, because a Pro # is permanent and must stay claimed forever. Only the
 * duplicate-Pro check and the PRO/id matchers (Intake, PODs, factoring) read it,
 * and they get it here as `allLoads`.
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
