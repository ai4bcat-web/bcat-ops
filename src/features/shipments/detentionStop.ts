import type { DetentionStopType } from '@/lib/detentionFlag'
import { boardStatusOf } from '@/lib/shipmentViewDefs'

/** Which stop the truck is most likely sitting at: the delivery once it has picked up, else the pickup. */
export function detentionStopGuess(row: Parameters<typeof boardStatusOf>[0]): DetentionStopType {
  const status = boardStatusOf(row)
  return status === 'DEPARTED' || status === 'ARRIVED' || status === 'DELIVERED' ? 'delivery' : 'pickup'
}
