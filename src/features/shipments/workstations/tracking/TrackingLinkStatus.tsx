/**
 * The tracking page's "Tracking link: sent manually 10:02 / auto-sends at 7:00 AM / sent
 * automatically 7:00 AM" line (Ryne 2026-11-16), from the same leg fields the automatic
 * send decides on.
 */
import { resolveAutomation } from '@/lib/trackingAutomation'
import { trackingLinkStatusLabel } from '@/lib/autoTrackingLink'
import type { CustomerRecord, LoadCarrierRecord, ShipmentLoad, ShipmentRecord, TmsSettings } from '@/types/tms'
import type { ShipmentRow } from '../../shipmentViews'

export function TrackingLinkStatus({ settings, customer, shipment, load, loadCarrier, row }: {
  settings: TmsSettings | null
  customer: CustomerRecord | null
  shipment: ShipmentRecord
  load: ShipmentLoad | null
  loadCarrier: LoadCarrierRecord | null
  row?: ShipmentRow | null
}) {
  const pickup = (load?.stops ?? []).find((st) => st.type === 'pickup')
  const label = trackingLinkStatusLabel({
    now: new Date().toISOString(),
    enabled: resolveAutomation({
      settings, customer, load: null,
      revDivision: shipment.revDivision ?? null, revSubdivision: shipment.revSubdivision ?? null,
    }).policy.trackingLinkAuto,
    load: {
      status: load?.status ?? null,
      pickupAppt: load?.pickupAppt ?? shipment.pickupAppt ?? null,
      pickupApptType: pickup?.apptType ?? row?.pickupApptType ?? null,
      trackingProvider: load?.trackingProvider ?? null,
      pickupDepartedAt: pickup?.departedAt ?? null,
    },
    leg: loadCarrier ? {
      status: loadCarrier.status,
      kind: loadCarrier.kind,
      trackingLinkId: loadCarrier.trackingLinkId ?? null,
      trackingStartedAt: loadCarrier.trackingStartedAt ?? null,
      autoTrackingClaimAt: loadCarrier.autoTrackingClaimAt ?? null,
    } : null,
    hasPhone: Boolean(loadCarrier?.driverPhone),
  })
  if (!label) return null
  return <span className="tms-muted" data-testid="tracking-link-line" style={{ fontSize: 12, alignSelf: 'center' }}>{label}</span>
}
