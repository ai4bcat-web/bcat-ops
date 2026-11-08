import { listUnmatchedMessages } from '@/lib/apiClient'
import { usePolled } from './usePolled'

/** The Unmatched bucket (ShipmentMessage rows under shipmentId='UNMATCHED'), newest first. */
export function useUnmatchedOffers() {
  return usePolled(listUnmatchedMessages)
}
