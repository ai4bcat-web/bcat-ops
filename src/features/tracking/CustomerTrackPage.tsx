import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { fetchCustomerTracking, TrackingError, type CustomerTrackingView } from '@/lib/trackingClient'
import { FleetMiniMap } from '@/features/dashboard/FleetMiniMap'
import type { TruckLocation } from '@/lib/apiClient'
import type { ShipmentStatus } from '@/types/tms'
import { TmsAlert, TmsAvatar, TmsCard, TmsMetaList, TmsPublicFrame, TmsTimeline } from '@/features/tms/kit'
import type { TmsTimelineItem } from '@/features/tms/kit'

const when = (iso: string) => new Date(iso).toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })

/** "14 min ago" below an hour, then "3 h ago", then days: an order of magnitude is enough. */
function ago(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  if (minutes < 60) return `${minutes} min ago`
  if (minutes < 1440) return `${Math.round(minutes / 60)} h ago`
  const days = Math.round(minutes / 1440)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

/** The four states a shipment passes through, as the stepper draws them. */
const STEPS = ['Booked', 'Dispatched', 'In transit', 'Delivered']

/** Every shipment status collapsed onto those four. */
const STEP_OF: Record<ShipmentStatus, number> = {
  DRAFT: 0, TENDER_PENDING: 0, TENDER_REJECTED: 0, OPEN: 0, ON_HOLD: 0, BOOKED: 0, PLANNED: 0, CANCELED: 0,
  DISPATCHED: 1,
  LOADING: 2, PICKED_UP: 2, IN_TRANSIT: 2, RECOVERED: 2, ARRIVED_AT_DELIVERY_TERMINAL: 2, OUT_FOR_DELIVERY: 2, UNLOADING: 2,
  DELIVERED: 3,
}

/**
 * The public page behind a shipment's Customer Link. No sign-in; the token in the URL
 * is the key. Shows where the freight is, where it is going and who to call — never
 * the carrier unless the link was minted to show it, never a rate. Refreshes itself
 * every minute, like the truck page.
 */
export function CustomerTrackPage() {
  const { token = '' } = useParams()
  const [view, setView] = useState<CustomerTrackingView | null>(null)
  const [error, setError] = useState<{ status: number; message: string } | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let alive = true
    const tick = async () => {
      try { const v = await fetchCustomerTracking(token); if (alive) { setView(v); setError(null); setNow(Date.now()) } }
      catch (e) { if (alive) setError(e instanceof TrackingError ? { status: e.status, message: e.message } : { status: 0, message: 'Could not load tracking' }) }
    }
    void tick()
    // A tab left open in the background must not keep spending the link's request
    // budget; it refreshes again the moment somebody looks at it.
    const t = setInterval(() => { if (document.visibilityState === 'visible') void tick() }, 60_000)
    return () => { alive = false; clearInterval(t) }
  }, [token])

  const location: TruckLocation[] = useMemo(() => (
    view?.position
      ? [{ truckId: 'this', unitNumber: view.number, lat: view.position.lat, lon: view.position.lng, locatedAt: view.position.at, description: view.position.description ?? undefined, source: 'tracking', syncedAt: view.generatedAt } as unknown as TruckLocation]
      : []
  ), [view])

  // A stop the truck has already left means in transit, even when the status lags.
  const step = !view || view.status === 'CANCELED'
    ? 0
    : Math.max(STEP_OF[view.status] ?? 0, view.stops.some((s) => s.departedAt) ? 2 : 0)

  const statusItems: TmsTimelineItem[] = STEPS.map((label, i) => ({
    id: label,
    title: label,
    state: i < step ? 'done' : i === step ? 'current' : 'upcoming',
  }))

  const stopItems: TmsTimelineItem[] = (view?.stops ?? []).map((stop) => ({
    id: stop.id,
    title: [stop.city, stop.state].filter(Boolean).join(', ') || stop.name || 'Stop',
    tag: stop.type === 'pickup' ? 'Pickup' : 'Delivery',
    state: stop.departedAt ? 'done' : stop.arrivedAt ? 'current' : 'upcoming',
    description: (
      <>
        {stop.appt && <div>Appointment {when(stop.appt)}</div>}
        {stop.arrivedAt && <div>Arrived {when(stop.arrivedAt)}</div>}
        {stop.departedAt && <div>Departed {when(stop.departedAt)}</div>}
      </>
    ),
  }))

  return (
    <TmsPublicFrame
      brand={view?.broker.name}
      subtitle={view ? 'Shipment tracking' : undefined}
      title={view ? `Shipment ${view.number}` : error ? 'Tracking' : 'Loading…'}
      width="md"
      footer={<span>This page refreshes every minute.</span>}
    >
      {error ? (
        <TmsAlert tone="red">
          {error.status === 404 ? 'This tracking link is no longer active. Ask your BCAT rep for a current one.' : error.message}
        </TmsAlert>
      ) : view ? (
        <div className="tms-public-stack">
          <TmsCard title={view.statusLabel}>
            <TmsTimeline items={statusItems} compact ariaLabel="Shipment progress" />
          </TmsCard>

          {view.position && (
            <TmsCard flush>
              <FleetMiniMap locations={location} />
              <div className="tms-public-caption">
                Last seen {view.position.description ? `near ${view.position.description}` : `at ${view.position.lat.toFixed(3)}, ${view.position.lng.toFixed(3)}`} · {ago(view.position.at, now)}
              </div>
            </TmsCard>
          )}

          <TmsCard title="Stops">
            <TmsTimeline items={stopItems} ariaLabel="Stops" />
          </TmsCard>

          <TmsCard>
            <TmsMetaList
              items={[
                {
                  label: 'ETA',
                  value: (
                    <>
                      {view.eta ? when(view.eta) : 'Not quoted yet'}
                      {view.lastUpdate && <div className="tms-public-sub">Last update {ago(view.lastUpdate.at, now)}</div>}
                    </>
                  ),
                },
                { label: 'Carrier', value: view.carrier?.name, hidden: !view.carrier },
                {
                  label: 'References',
                  value: view.references.map((r) => `${r.label ?? r.code} ${r.value}`).join(' · '),
                  hidden: view.references.length === 0,
                },
              ]}
            />
          </TmsCard>

          {view.contact && (
            <TmsCard title="Your BCAT contact">
              <div className="tms-public-contact">
                <TmsAvatar label={view.contact.name ?? view.broker.name} />
                <div>
                  <div className="tms-public-strong">{view.contact.name ?? view.broker.name}</div>
                  {[view.contact.phone, view.contact.email].filter(Boolean).length > 0 && (
                    <div className="tms-public-sub">{[view.contact.phone, view.contact.email].filter(Boolean).join(' · ')}</div>
                  )}
                </div>
              </div>
            </TmsCard>
          )}
        </div>
      ) : null}
    </TmsPublicFrame>
  )
}

export default CustomerTrackPage
