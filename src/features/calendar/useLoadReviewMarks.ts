import { useMemo } from 'react'
import { useShipments } from '@/hooks/useShipments'
import { isReleasedToInvoicing } from '@/lib/shipmentLists'
import type { Load } from '@/types'

/** The revenue divisions the calendar shows. */
export const CALENDAR_DIVISIONS: readonly string[] = ['ASSETS', 'OWNER_OPERATOR']

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
  const working = useShipments({ kind: 'working' }).shipments
  // The months the calendar actually holds: a shipment outside the working set (an older or later month) is read too, so its
  // division and Load Review state are known and it is not shown by mistake.
  const monthsKey = useMemo(() => [...new Set(loads.map((l) => (l.pickupAppt ?? '').slice(0, 7)).filter((m) => /^\d{4}-\d{2}$/.test(m)))].sort().join(','), [loads])
  const windowed = useShipments({ kind: 'window', months: monthsKey ? monthsKey.split(',') : [] }).shipments
  const shipments = useMemo(() => [...working, ...windowed], [working, windowed])
  const { marked, offCalendar } = useMemo(() => {
    const ids = new Set<string>()
    const offCalendarIds = new Set<string>()
    for (const row of shipments) {
      if (row.loadReviewPushedAt || isReleasedToInvoicing(row)) ids.add(row.id)
      if (row.revDivision && !CALENDAR_DIVISIONS.includes(row.revDivision)) offCalendarIds.add(row.id)
    }
    return { marked: ids, offCalendar: offCalendarIds }
  }, [shipments])
  return useMemo(
    () => loads.filter((l) => !(l.shipmentId != null && offCalendar.has(l.shipmentId))).map((l) => {
      const green = (l.shipmentId != null && marked.has(l.shipmentId)) || l.status === 'INVOICING'
      return green === Boolean(l.readyToInvoice) ? l : { ...l, readyToInvoice: green }
    }),
    [loads, marked, offCalendar],
  )
}
