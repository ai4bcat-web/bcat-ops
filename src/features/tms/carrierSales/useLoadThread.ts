import { useCallback } from 'react'
import { listOfferThread } from '@/lib/apiClient'
import { usePolled } from './usePolled'

/** One load's e-mail + call offer thread, oldest first. */
export function useLoadThread(shipmentId: string | null) {
  const read = useCallback(() => listOfferThread(shipmentId!), [shipmentId])
  return usePolled(shipmentId ? read : null)
}
