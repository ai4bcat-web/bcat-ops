import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Building2, Clock, MapPin, Phone, Truck } from 'lucide-react'
import { fetchCustomerTracking, TrackingError, type CustomerTrackingView } from '@/lib/trackingClient'
import { FleetMiniMap } from '@/features/dashboard/FleetMiniMap'
import type { TruckLocation } from '@/lib/apiClient'
import type { ShipmentStatus } from '@/types/tms'

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

  return (
    <div style={{ minHeight: '100vh', background: '#f4f6f8', color: '#15202b', fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif', padding: '24px 16px' }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <Building2 size={22} style={{ color: '#1ea8f3' }} />
          <div>
            <div style={{ fontSize: 12, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#5c6b7a', fontWeight: 600 }}>{view ? `${view.broker.name} · shipment tracking` : 'Shipment tracking'}</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{view ? `Shipment ${view.number}` : error ? 'Tracking' : 'Loading…'}</div>
          </div>
        </div>

        {error ? (
          <div style={{ background: '#fff', border: '1px solid #e3e8ee', borderRadius: 12, padding: 20, fontSize: 15 }}>
            {error.status === 404 ? 'This tracking link is no longer active. Ask your BCAT rep for a current one.' : error.message}
          </div>
        ) : view ? (
          <div style={{ display: 'grid', gap: 12 }}>
            <div style={{ background: '#fff', border: '1px solid #e3e8ee', borderRadius: 12, padding: '16px 18px' }}>
              <div style={{ display: 'flex', gap: 6 }}>
                {STEPS.map((label, i) => (
                  <div key={label} style={{ flex: 1 }}>
                    <div style={{ height: 4, borderRadius: 2, background: i <= step ? '#1ea8f3' : '#e3e8ee' }} />
                    <div style={{ fontSize: 11, marginTop: 6, color: i <= step ? '#15202b' : '#8a97a5', fontWeight: i === step ? 700 : 500 }}>{label}</div>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 15, fontWeight: 600, marginTop: 12 }}>{view.statusLabel}</div>
            </div>

            {view.position && (
              <div style={{ background: '#fff', border: '1px solid #e3e8ee', borderRadius: 12, overflow: 'hidden' }}>
                <FleetMiniMap locations={location} />
                <div style={{ padding: '12px 18px', fontSize: 13, color: '#5c6b7a', borderTop: '1px solid #eef2f6' }}>
                  Last seen {view.position.description ? `near ${view.position.description}` : `at ${view.position.lat.toFixed(3)}, ${view.position.lng.toFixed(3)}`} · {ago(view.position.at, now)}
                </div>
              </div>
            )}

            <div style={{ background: '#fff', border: '1px solid #e3e8ee', borderRadius: 12, padding: '16px 18px', display: 'grid', gap: 14 }}>
              {view.stops.map((stop) => (
                <div key={stop.id} style={{ display: 'grid', gridTemplateColumns: '24px 1fr', gap: 10, alignItems: 'start' }}>
                  <span style={{ color: stop.departedAt ? '#16a34a' : '#1ea8f3', marginTop: 2 }}><MapPin size={16} /></span>
                  <div>
                    <div style={{ fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#5c6b7a', fontWeight: 600 }}>{stop.type === 'pickup' ? 'Pickup' : 'Delivery'}</div>
                    <div style={{ fontSize: 15, fontWeight: 600 }}>{[stop.city, stop.state].filter(Boolean).join(', ') || stop.name || 'Stop'}</div>
                    {stop.appt && <div style={{ fontSize: 13, color: '#5c6b7a', marginTop: 2 }}>Appointment {when(stop.appt)}</div>}
                    {stop.arrivedAt && <div style={{ fontSize: 13, color: '#5c6b7a', marginTop: 2 }}>Arrived {when(stop.arrivedAt)}</div>}
                    {stop.departedAt && <div style={{ fontSize: 13, color: '#16a34a', marginTop: 2 }}>Departed {when(stop.departedAt)}</div>}
                  </div>
                </div>
              ))}
            </div>

            <div style={{ background: '#fff', border: '1px solid #e3e8ee', borderRadius: 12, padding: '16px 18px', display: 'grid', gap: 12 }}>
              <Row icon={<Clock size={16} />} label="ETA" value={view.eta ? when(view.eta) : 'Not quoted yet'} sub={view.lastUpdate ? `Last update ${ago(view.lastUpdate.at, now)}` : undefined} />
              {view.carrier && <Row icon={<Truck size={16} />} label="Carrier" value={view.carrier.name} />}
              {view.references.length > 0 && (
                <Row
                  icon={<MapPin size={16} />}
                  label="References"
                  value={view.references.map((r) => `${r.label ?? r.code} ${r.value}`).join(' · ')}
                />
              )}
            </div>

            {view.contact && (
              <div style={{ background: '#fff', border: '1px solid #e3e8ee', borderRadius: 12, padding: '16px 18px' }}>
                <Row
                  icon={<Phone size={16} />}
                  label="Your BCAT contact"
                  value={view.contact.name ?? view.broker.name}
                  sub={[view.contact.phone, view.contact.email].filter(Boolean).join(' · ') || undefined}
                />
              </div>
            )}

            <div style={{ fontSize: 12, color: '#5c6b7a', textAlign: 'center' }}>This page refreshes every minute.</div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function Row({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub?: string }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '24px 1fr', gap: 10, alignItems: 'start' }}>
      <span style={{ color: '#1ea8f3', marginTop: 2 }}>{icon}</span>
      <div>
        <div style={{ fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#5c6b7a', fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{value}</div>
        {sub && <div style={{ fontSize: 13, color: '#5c6b7a', marginTop: 2 }}>{sub}</div>}
      </div>
    </div>
  )
}

export default CustomerTrackPage
