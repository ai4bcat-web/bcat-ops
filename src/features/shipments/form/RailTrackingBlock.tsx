/**
 * Tracking, in the shipment rail: where the truck on this load is right now (see railTracking.ts
 * for which source each kind of load reads). Refreshes every minute while the tab is visible.
 */
import { memo, useEffect, useMemo, useState } from 'react'
import { ExternalLink, MapPin } from 'lucide-react'
import { TmsBadge, TmsButton } from '@/features/tms/kit'
import { FleetMiniMap } from '@/features/dashboard/FleetMiniMap'
import { listCheckCallsByLoad, listTimeClockByDriver, listTrackingLinksByShipment, listTruckLocations, type TruckLocation } from '@/lib/apiClient'
import { chicagoDateStr, formatDateTime } from '@/lib/date'
import { useAppStore } from '@/store/useAppStore'
import type { LoadCheckCallRecord, ShipmentBundle, TrackingLinkRecord } from '@/types/tms'
import { agoText, freshnessOf, mapsUrl, railTracking, type LinkState, type Punch, type TrackingCase } from './railTracking'

const REFRESH_MS = 60_000
const DAY_MS = 86_400_000

/** Work days whose punches belong to this load: the day before its first appointment through today, at most a week. */
function punchDays(firstAppt: string | null, now: Date): { from: string; to: string } {
  const earliest = now.getTime() - 7 * DAY_MS
  const start = firstAppt && !Number.isNaN(Date.parse(firstAppt)) ? Math.max(Date.parse(firstAppt) - DAY_MS, earliest) : now.getTime() - 2 * DAY_MS
  return { from: chicagoDateStr(new Date(start)), to: chicagoDateStr(now) }
}

const KIND_LABEL: Record<TrackingCase, string> = {
  IVAN: 'Ivan driver · ELD',
  OWNER_OP: 'Owner operator · ELD',
  BROKERED: 'Brokered · tracking link',
  NONE: '',
}

const LINK_BADGE: Record<LinkState, { text: string; tone: 'gray' | 'orange' | 'green' | 'red' }> = {
  NOT_SENT: { text: 'Link not sent', tone: 'gray' },
  SENT: { text: 'Link sent · waiting', tone: 'orange' },
  ACCEPTED: { text: 'Link accepted', tone: 'green' },
  EXPIRED: { text: 'Link expired', tone: 'red' },
  STOPPED: { text: 'Link stopped', tone: 'gray' },
}

const FRESH_TONE = { fresh: 'green', stale: 'amber', old: 'red' } as const

function RailTrackingBlockImpl({ bundle, onSendTrackingLink }: { bundle: ShipmentBundle | null; onSendTrackingLink?: () => void }) {
  const drivers = useAppStore((s) => s.drivers)
  const equipment = useAppStore((s) => s.equipment)
  const load = bundle?.loads[0] ?? null
  const loadId = load?.id ?? null
  const shipmentId = bundle?.shipment.id ?? null
  const ownLeg = bundle?.loadCarriers.find((c) => c.status === 'ACTIVE' && c.kind === 'OWN_ASSET') ?? null
  const ownFleet = !!ownLeg
  const ownDriverId = ownLeg?.driverId ?? null
  const firstAppt = ((load?.stops ?? []) as { appt?: string | null }[]).find((s) => s.appt)?.appt ?? null

  const [truckLocations, setTruckLocations] = useState<TruckLocation[]>([])
  const [checkCalls, setCheckCalls] = useState<LoadCheckCallRecord[]>([])
  const [trackingLinks, setTrackingLinks] = useState<TrackingLinkRecord[]>([])
  const [punches, setPunches] = useState<Punch[]>([])
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    if (!loadId || !shipmentId) return
    let alive = true
    const tick = () => {
      if (document.visibilityState !== 'visible') return
      setNow(new Date())
      if (ownFleet) listTruckLocations().then((rows) => { if (alive) setTruckLocations(rows) }).catch(() => undefined)
      if (ownDriverId) {
        const { from, to } = punchDays(firstAppt, new Date())
        listTimeClockByDriver(ownDriverId, from, to).then((rows) => { if (alive) setPunches(rows) }).catch(() => undefined)
      }
      listCheckCallsByLoad(loadId).then((rows) => { if (alive) setCheckCalls(rows) }).catch(() => undefined)
      listTrackingLinksByShipment(shipmentId).then((rows) => { if (alive) setTrackingLinks(rows) }).catch(() => undefined)
    }
    tick()
    const timer = window.setInterval(tick, REFRESH_MS)
    return () => { alive = false; window.clearInterval(timer) }
  }, [loadId, shipmentId, ownFleet, ownDriverId, firstAppt])

  const t = useMemo(() => railTracking({
    load, loadCarriers: bundle?.loadCarriers ?? [], drivers, equipment, truckLocations, checkCalls, trackingLinks, punches, now,
  }), [load, bundle?.loadCarriers, drivers, equipment, truckLocations, checkCalls, trackingLinks, punches, now])

  if (!bundle) return null

  const fresh = t.fix ? freshnessOf(t.fix.at, now) : null
  const who = [t.carrierName, t.driverName, t.truckLabel].filter(Boolean).join(' · ')
  const mapLocation: TruckLocation[] = t.fix ? [{
    truckId: 'this-load', unitNumber: t.truckLabel ?? '', lat: t.fix.lat, lon: t.fix.lng, bearing: null,
    speed: t.fix.speedMph, locatedAt: t.fix.at, description: t.fix.place, motion: t.fix.moving ? 'MOVING' : 'STATIONARY',
    motionSince: null, odometer: null, source: t.fix.source, syncedAt: t.fix.at, createdAt: t.fix.at, updatedAt: t.fix.at,
  }] : []

  return (
    <section className="tms-rail-block tms-rail-tracking" data-testid="rail-tracking" aria-label="Tracking">
      <h2 className="tms-rail-h">
        Tracking
        {t.kind !== 'NONE' ? <span className="tms-rail-tracking-kind" data-testid="rail-tracking-kind">{KIND_LABEL[t.kind]}</span> : null}
      </h2>

      {who ? <p className="tms-rail-line tms-rail-line-strong" data-testid="rail-tracking-who">{who}</p> : null}

      {t.link ? (
        <div className="tms-rail-tracking-row">
          <TmsBadge tone={LINK_BADGE[t.link.state].tone} data-testid="rail-tracking-link">{LINK_BADGE[t.link.state].text}</TmsBadge>
          {t.link.at ? <span className="tms-rail-tracking-muted">{formatDateTime(t.link.at)}</span> : null}
        </div>
      ) : null}

      {t.delivered ? (
        <p className="tms-rail-line" data-testid="rail-tracking-delivered">
          Delivered{t.deliveredAt ? ` ${formatDateTime(t.deliveredAt)}` : ''}{t.fix ? ' · last known position below' : ''}
        </p>
      ) : null}

      {t.fix ? (
        <div className="tms-rail-tracking-fix" data-testid="rail-tracking-fix">
          <div className="tms-rail-tracking-row">
            <MapPin size={14} aria-hidden="true" />
            <span className="tms-rail-tracking-place">{t.fix.place ?? `${t.fix.lat.toFixed(4)}, ${t.fix.lng.toFixed(4)}`}</span>
          </div>
          <div className="tms-rail-tracking-row tms-rail-tracking-muted">
            <span className="tms-rail-dot" data-tone={FRESH_TONE[fresh!]} aria-hidden="true" />
            <span data-testid="rail-tracking-age" data-fresh={fresh}>Updated {agoText(t.fix.at, now)}</span>
            {t.fix.speedMph != null ? <span>· {t.fix.moving ? `${t.fix.speedMph} mph` : 'Stopped'}</span> : null}
            <a href={mapsUrl(t.fix.lat, t.fix.lng)} target="_blank" rel="noreferrer" className="tms-rail-tracking-maps">
              Map <ExternalLink size={11} aria-hidden="true" />
            </a>
          </div>
          <FleetMiniMap locations={mapLocation} />
        </div>
      ) : t.emptyReason ? (
        <p className="tms-rail-line" data-testid="rail-tracking-empty">{t.emptyReason}</p>
      ) : null}

      {t.kind === 'BROKERED' && t.link && (t.link.state === 'NOT_SENT' || t.link.state === 'EXPIRED' || t.link.state === 'STOPPED') && onSendTrackingLink ? (
        <div><TmsButton size="sm" onClick={onSendTrackingLink} data-testid="rail-tracking-send">Send Tracking Link</TmsButton></div>
      ) : null}

      {t.checkIns.length > 0 ? (
        <div className="tms-rail-tracking-checkins" data-testid="rail-tracking-checkins">
          <span className="tms-rail-tracking-sub">Recent check-ins</span>
          <ul>
            {t.checkIns.map((c) => (
              <li key={`${c.at}-${c.label}`}>
                <span className="tms-rail-tracking-ci-label">{c.label}{c.place ? ` · ${c.place}` : ''}</span>
                <span className="tms-rail-tracking-muted">{formatDateTime(c.at)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}

export const RailTrackingBlock = memo(RailTrackingBlockImpl)
