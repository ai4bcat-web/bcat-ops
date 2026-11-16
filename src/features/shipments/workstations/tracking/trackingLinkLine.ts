/**
 * The "Tracking link" line for a board row (Track list column and tracking page): sent
 * manually / sent automatically / auto-sends at … — from the row's own projection, so it
 * reads the same leg fields the automatic send decides on.
 */
import { trackingLinkStatusLabel } from '@/lib/autoTrackingLink'
import type { ShipmentRow } from '../../shipmentViews'

export function trackingLinkLine(row: ShipmentRow, nowIso: string, autoOn: boolean): string {
  const label = trackingLinkStatusLabel({
    now: nowIso,
    enabled: autoOn,
    load: {
      status: (row.loadStatus as string | null | undefined) ?? row.status ?? null,
      pickupAppt: row.pickupAppt ?? null,
      pickupApptType: row.pickupApptType ?? null,
      trackingProvider: row.trackingProvider ?? null,
    },
    leg: row.assignmentType || row.carrierName
      ? {
          status: 'ACTIVE',
          kind: row.assignmentType === 'OWN_ASSET' ? 'OWN_ASSET' : 'CARRIER',
          trackingLinkId: row.trackingLinkId ?? null,
          trackingStartedAt: row.trackingStartedAt ?? null,
          autoTrackingClaimAt: row.autoTrackingClaimAt ?? null,
        }
      : null,
    hasPhone: Boolean(row.driverPhone),
  })
  return label ? label.replace(/^Tracking link: /, '') : ''
}
