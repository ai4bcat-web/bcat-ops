/** The amber "Tracking mode not set" chip: a carrier is booked but nobody confirmed how the load is tracked. */
import { trackingModeNotSet } from '@/lib/trackingPrefs'
import './trackingModeControl.css'

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

/** A board / Load Tracking row: a carrier (or own asset) is on the load when the ladder rung or assignment type is set. */
export function TrackingModeNotSetRowChip({ row }: {
  row: { trackingPrefs?: unknown; createdAt?: string | null; carrierAssignmentStatus?: string | null; assignmentType?: string | null }
}) {
  return <TrackingModeNotSetChip shipment={row} hasCarrier={Boolean(row.carrierAssignmentStatus) || Boolean(row.assignmentType)} className="tms-trk-notset-row" />
}
