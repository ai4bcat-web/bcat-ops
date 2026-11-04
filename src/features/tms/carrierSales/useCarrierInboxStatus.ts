import { csStatus } from './csClient'
import { usePolled } from './usePolled'

/** `CS_STATUS`: only the Settings page and the Offers banner read it. */
export function useCarrierInboxStatus(enabled = true) {
  return usePolled(enabled ? csStatus : null)
}
