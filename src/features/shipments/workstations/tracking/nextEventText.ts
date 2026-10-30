import { relativeTime } from '../motion'
import { boardStatusOf, type ShipmentRow } from '../../shipmentViews'

/** The next human-meaningful thing the clock brings for the tracking board. */
export function nextEventText(row: ShipmentRow, nowMs: number): string | null {
  const status = boardStatusOf(row)
  if (status === 'VOIDED' || status === 'CANCELED') return null
  if (status === 'DELIVERED') {
    const ago = relativeTime(row.deliveredAt, nowMs)
    return ago ? `Delivered ${ago}` : null
  }
  const destination = status === 'DEPARTED' || status === 'ARRIVED'
  const appt = destination ? row.deliveryAppt : row.pickupAppt
  const rel = relativeTime(appt, nowMs)
  if (!rel) return null
  const event = destination ? 'Delivery' : 'Pickup'
  return rel.startsWith('in ') ? `${event} starts ${rel}` : `${event} appointment ${rel}`
}
