/**
 * Closable third column of the Inbox: mini map, driver card, key figures and the
 * order status timeline. Open/closed state persists in localStorage['tms-inbox-info'];
 * the default is open on wide screens, closed below 1280px.
 */
import { X } from 'lucide-react'
import { TmsMetaList, TmsTimeline } from '@/features/tms/kit'
import { formatDateTime } from '@/lib/date'
import type { ComputedTrackingEta } from '@/lib/trackingEta'
import type { ShipmentBundle } from '@/types/tms'
import type { ShipmentRow } from '../../shipmentViews'
import { DriverCard } from './DriverCard'
import { TrackingMiniMap } from './TrackingDetailMap'
import { buildStatusTimeline, formatMiles, type LegGeometry } from './statusTimeline'

export interface InboxInfoPanelProps {
  row: ShipmentRow
  bundle: ShipmentBundle | null
  geo: LegGeometry
  eta: ComputedTrackingEta | null
  nowMs: number
  mapsKey?: string
  mapsMapId?: string
  onClose: () => void
}

export function InboxInfoPanel({ row, bundle, geo, eta, nowMs, mapsKey, mapsMapId, onClose }: InboxInfoPanelProps) {
  const { leg } = geo
  const timeline = buildStatusTimeline({ row, bundle, nowMs, eta })
  return (
    <aside className="tms-inbox-info" data-testid="inbox-info-panel" aria-label="Shipment info">
      <div className="tms-inbox-info-head">
        <h3 className="tms-inbox-info-title">Info</h3>
        <button type="button" className="tms-icon-link" aria-label="Close info panel" onClick={onClose}>
          <X size={16} aria-hidden />
        </button>
      </div>
      <div className="tms-inbox-info-body">
        {(geo.lastKnown || geo.destination) && (
          <div className="tms-inbox-info-map">
            <TrackingMiniMap
              apiKey={mapsKey}
              mapId={mapsMapId}
              lastKnown={geo.lastKnown}
              delivery={geo.destination}
              deliveryName={geo.deliveryStop?.name ?? row.destinationCity}
            />
          </div>
        )}
        <DriverCard
          driver={leg ? { name: leg.driverName, phone: leg.driverPhone } : null}
          dispatcher={leg ? { name: leg.dispatcherName, phone: leg.dispatcherPhone, email: leg.dispatcherEmail } : null}
          loadStatus={row.loadStatus}
        />
        <TmsMetaList
          dense
          columns={2}
          items={[
            { label: 'Truck #', value: leg?.truckNumber, hidden: !leg?.truckNumber },
            { label: 'Trailer #', value: leg?.trailerNumber, hidden: !leg?.trailerNumber },
            { label: 'PRO', value: row.number },
            { label: 'Miles', value: formatMiles(eta?.miles), hidden: !eta },
            { label: 'ETA', value: eta ? formatDateTime(eta.etaAt) : null, hidden: !eta },
          ]}
        />
        <section aria-label="Order status">
          <h4 className="tms-inbox-info-sub">Order status</h4>
          <TmsTimeline compact items={timeline} ariaLabel="Order status timeline" data-testid="inbox-status-timeline" />
        </section>
      </div>
    </aside>
  )
}
