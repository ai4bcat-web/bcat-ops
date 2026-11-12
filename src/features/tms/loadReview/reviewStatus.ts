import { boardStatusOf, isVoided, statusWithProgress, type ShipmentRow } from '@/features/shipments/shipmentViews'
import { formatDateTime } from '@/lib/date'

type DeliveredSource = Pick<ShipmentRow, 'deliveredAt' | 'stops'> & { loadDeliveredAt?: string | null }

/**
 * When the freight was delivered. The shipment stamp is only written once every load has delivered, so a load
 * moved to Delivered by status (or by the last stop) can lack it; fall back to the loads' stamp, then the
 * latest actual time recorded at a delivery stop.
 */
export function deliveredTimeOf(row: DeliveredSource): string | null {
  if (row.deliveredAt) return row.deliveredAt
  if (row.loadDeliveredAt) return row.loadDeliveredAt
  const times = (row.stops ?? [])
    .filter((s) => String(s.type).toLowerCase() === 'delivery')
    .map((s) => s.departedAt ?? s.arrivedAt ?? null)
    .filter((t): t is string => !!t)
    .sort()
  return times.length ? times[times.length - 1] : null
}

/** The Delivered cell: the time, or an honest note when the status says delivered but nobody recorded when. */
export function deliveredText(row: ShipmentRow & { loadDeliveredAt?: string | null }): string {
  const at = deliveredTimeOf(row)
  if (at) return formatDateTime(at)
  return boardStatusOf(row) === 'DELIVERED' ? 'Delivered (no time recorded)' : '—'
}

/** The shipment's status as the board prints it, "DELIVERED 2/2" style. */
export function reviewStatusText(row: ShipmentRow): string {
  return statusWithProgress(row)
}

export function reviewStatusTone(row: ShipmentRow): 'gray' | 'green' | 'red' | 'blue' {
  if (isVoided(row)) return 'red'
  return boardStatusOf(row) === 'DELIVERED' ? 'green' : 'blue'
}
