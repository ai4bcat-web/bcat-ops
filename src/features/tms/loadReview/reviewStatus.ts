import { boardStatusOf, statusWithProgress, type ShipmentRow } from '@/features/shipments/shipmentViews'
import { formatDateTime } from '@/lib/date'
import { deliveredTimeOf as sharedDeliveredTimeOf } from '@/lib/deliveredAt'

type DeliveredSource = Pick<ShipmentRow, 'deliveredAt' | 'stops'> & Partial<Pick<ShipmentRow, 'status' | 'statusChangedAt'>> & { loadDeliveredAt?: string | null }

/** When the freight was delivered: the shared precedence in `@/lib/deliveredAt`. */
export function deliveredTimeOf(row: DeliveredSource): string | null {
  return sharedDeliveredTimeOf(row)
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
