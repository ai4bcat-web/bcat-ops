/**
 * "Distance to arrival" card pinned at the end of the Inbox stream: a snapshot of
 * the latest known position (not a per-message map) with the ETA estimate the
 * Tracking tab shows. Rendered only when the load has a fix.
 */
import { MapPin } from 'lucide-react'
import { formatDateTime } from '@/lib/date'
import type { ComputedTrackingEta } from '@/lib/trackingEta'
import type { ShipmentRow } from '../../shipmentViews'
import { relativeTime } from '../motion'
import { TrackingMiniMap } from './TrackingDetailMap'
import { formatDriveTime, type LegGeometry } from './statusTimeline'

export interface LocationCardProps {
  row: Pick<ShipmentRow, 'originCity' | 'destinationCity'>
  geo: LegGeometry
  eta: ComputedTrackingEta | null
  nowMs: number
  mapsKey?: string
  mapsMapId?: string
}

export function LocationCard({ row, geo, eta, nowMs, mapsKey, mapsMapId }: LocationCardProps) {
  if (!geo.lastKnown) return null
  const ping = relativeTime(geo.pingAt, nowMs)
  return (
    <section className="tms-location-card" data-testid="inbox-location-card" aria-label="Distance to arrival">
      <div className="tms-location-card-map">
        <TrackingMiniMap
          apiKey={mapsKey}
          mapId={mapsMapId}
          lastKnown={geo.lastKnown}
          delivery={geo.destination}
          deliveryName={geo.deliveryStop?.name ?? row.destinationCity}
        />
      </div>
      <div className="tms-location-card-body">
        <span className="tms-location-card-label">Distance to arrival</span>
        <span className="tms-location-card-figure" data-testid="location-distance">
          {eta ? `${Math.round(eta.miles).toLocaleString('en-US')} mi · ${formatDriveTime(eta.driveMinutes)}` : '—'}
        </span>
        <span className="tms-location-card-lane">{row.originCity ?? '—'} → {row.destinationCity ?? '—'}</span>
        <span className="tms-location-card-ping">
          <MapPin size={12} aria-hidden /> Last ping {geo.pingAt ? `${ping ?? formatDateTime(geo.pingAt)}` : 'unknown'}
          {eta ? ` · ${eta.basis === 'ESTIMATE' ? 'estimate' : 'routed'}` : ''}
        </span>
      </div>
    </section>
  )
}
