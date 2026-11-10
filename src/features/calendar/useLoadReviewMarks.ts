import { useMemo } from 'react'
import { useShipments } from '@/hooks/useShipments'
import { isReleasedToInvoicing } from '@/lib/shipmentLists'
import type { Load } from '@/types'

/** The revenue divisions the calendar shows. */
export const CALENDAR_DIVISIONS: readonly string[] = ['ASSETS', 'OWNER_OPERATOR']

/**
 * Is this load kept off the calendar? Decided from facts that are the same for every signed-in person:
 *  - the division the load itself carries (mirrored onto it from its shipment), so the answer never waits on, or depends on, a second
 *    fetch of shipments that can lag or fail for one browser and leak brokerage freight onto that person's calendar; or
 *  - the shipment's division, once the shipment rows are in.
 * A load whose division is unknown everywhere is still shown, except while the shipment rows are not settled (loading, partly read, or
 * the read failed): then it is held back rather than flashed onto the board and pulled off again (or, on a failed read, left there).
 */
export function loadOffCalendar(
  load: Pick<Load, 'shipmentId' | 'revDivision'>,
  shipments: { offCalendar: ReadonlySet<string>; known: ReadonlySet<string>; loading: boolean },
): boolean {
  if (load.revDivision) return !CALENDAR_DIVISIONS.includes(load.revDivision)
  if (load.shipmentId != null && shipments.offCalendar.has(load.shipmentId)) return true
  return shipments.loading && !(load.shipmentId != null && shipments.known.has(load.shipmentId))
}

/**
 * What the calendar shows, straight from the Shipments page's state.
 *
 * The calendar is for Ivan loads only (the ones sent to ivanloads@bcatcorp.com, revenue division Assets, owner operators included).
 * A shipment in any other revenue division (Brokerage, Car Shipping...) is not on the calendar at all; it lives on the Shipments
 * page, where a brokerage load that needs a carrier shows as Need to cover. A shipment with no division set is still shown.
 *
 * The calendar's green. A shipment is marked once it has everything it needs and has moved into Load Review (the push stamp), and
 * stays marked after it is released to invoicing. It is the Shipments page's own state, not a flag somebody sets on the calendar:
 * the shipment's loads come back with `readyToInvoice` set to that state, which is what every calendar view draws green.
 * Reads the shared working set (cached; every extra mount is a hit); a load whose shipment has left that set is still green when
 * its status says it was released to invoicing.
 */
export function useLoadReviewMarks(loads: readonly Load[]): Load[] {
  const workingRead = useShipments({ kind: 'working' })
  const working = workingRead.shipments
  // The months the calendar actually holds: a shipment outside the working set (an older or later month) is read too, so its
  // division and Load Review state are known and it is not shown by mistake.
  const monthsKey = useMemo(() => [...new Set(loads.map((l) => (l.pickupAppt ?? '').slice(0, 7)).filter((m) => /^\d{4}-\d{2}$/.test(m)))].sort().join(','), [loads])
  const windowRead = useShipments({ kind: 'window', months: monthsKey ? monthsKey.split(',') : [] })
  const windowed = windowRead.shipments
  // Not settled = still loading, only part read, or the read failed: in each case a missing row proves nothing, so it must not read as "no division".
  const shipmentsLoading = [workingRead, windowRead].some((r) => r.loading || r.partial || r.error != null)
  const shipments = useMemo(() => [...working, ...windowed], [working, windowed])
  const { marked, offCalendar, known } = useMemo(() => {
    const ids = new Set<string>()
    const offCalendarIds = new Set<string>()
    const knownIds = new Set<string>()
    for (const row of shipments) {
      knownIds.add(row.id)
      if (row.loadReviewPushedAt || isReleasedToInvoicing(row)) ids.add(row.id)
      if (row.revDivision && !CALENDAR_DIVISIONS.includes(row.revDivision)) offCalendarIds.add(row.id)
    }
    return { marked: ids, offCalendar: offCalendarIds, known: knownIds }
  }, [shipments])
  return useMemo(
    () => loads.filter((l) => !loadOffCalendar(l, { offCalendar, known, loading: shipmentsLoading })).map((l) => {
      const green = (l.shipmentId != null && marked.has(l.shipmentId)) || l.status === 'INVOICING'
      return green === Boolean(l.readyToInvoice) ? l : { ...l, readyToInvoice: green }
    }),
    [loads, marked, offCalendar, known, shipmentsLoading],
  )
}
