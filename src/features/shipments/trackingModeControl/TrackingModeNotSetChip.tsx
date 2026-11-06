/** The amber "Tracking mode not set" chip: a carrier is booked but nobody confirmed how the load is tracked. */
import { trackingModeNotSet } from '@/lib/trackingPrefs'

export const TRACKING_NOT_SET_TEXT = 'Tracking mode not set'

export function TrackingModeNotSetChip({ shipment, hasCarrier, className }: {
  shipment: { trackingPrefs?: unknown; createdAt?: string | null } | null
  hasCarrier: boolean
  className?: string
}) {
  if (!trackingModeNotSet(shipment, hasCarrier)) return null
  return (
    <span
      className={`tms-trk-notset${className ? ` ${className}` : ''}`} data-testid="tracking-not-set"
      title="A carrier is booked but the tracking mode was never confirmed for this load. Automation is off; the rate con is not blocked."
    >
      {TRACKING_NOT_SET_TEXT}
    </span>
  )
}
