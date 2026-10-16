import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Truck, MapPin, Clock, Route } from 'lucide-react'
import { fetchTracking, TrackingError, type TrackingView } from '@/lib/trackingClient'
import { FleetMiniMap } from '@/features/dashboard/FleetMiniMap'
import type { TruckLocation } from '@/lib/apiClient'

const when = (iso: string) => new Date(iso).toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
const agoMin = (iso: string, now: number) => Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))

/**
 * The public page behind a truck's tracking link. No sign-in; the code in the URL is the
 * key. Shows the truck, its driver, where it was last seen and when, and the load under
 * way with its ETA. Refreshes itself every minute.
 */
export function TrackPage() {
  const { code = '' } = useParams()
  const [view, setView] = useState<TrackingView | null>(null)
  const [error, setError] = useState<{ status: number; message: string } | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let alive = true
    const tick = async () => {
      try { const v = await fetchTracking(code); if (alive) { setView(v); setError(null); setNow(Date.now()) } }
      catch (e) { if (alive) setError(e instanceof TrackingError ? { status: e.status, message: e.message } : { status: 0, message: 'Could not load tracking' }) }
    }
    void tick()
    const t = setInterval(tick, 60_000)
    return () => { alive = false; clearInterval(t) }
  }, [code])

  const location: TruckLocation[] = view?.position
    ? [{ truckId: 'this', unitNumber: view.unit, lat: view.position.lat, lon: view.position.lon, locatedAt: view.position.locatedAt, description: view.position.description ?? undefined, source: 'motive', syncedAt: view.generatedAt } as unknown as TruckLocation]
    : []

  return (
    <div style={{ minHeight: '100vh', background: '#f4f6f8', color: '#15202b', fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif', padding: '24px 16px' }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <Truck size={22} style={{ color: '#1ea8f3' }} />
          <div>
            <div style={{ fontSize: 12, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#5c6b7a', fontWeight: 600 }}>BCAT Logistics · live tracking</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{view ? `Truck ${view.unit}` : error ? 'Tracking' : 'Loading…'}</div>
          </div>
        </div>

        {error ? (
          <div style={{ background: '#fff', border: '1px solid #e3e8ee', borderRadius: 12, padding: 20, fontSize: 15 }}>
            {error.status === 404 ? 'This tracking link is no longer active. Ask BCAT dispatch for a current one.' : error.message}
          </div>
        ) : view ? (
          <div style={{ display: 'grid', gap: 12 }}>
            <div style={{ background: '#fff', border: '1px solid #e3e8ee', borderRadius: 12, overflow: 'hidden' }}>
              {location.length ? <FleetMiniMap locations={location} /> : <div style={{ padding: 24, color: '#5c6b7a' }}>No position reported yet.</div>}
            </div>
            <div style={{ background: '#fff', border: '1px solid #e3e8ee', borderRadius: 12, padding: '16px 18px', display: 'grid', gap: 12 }}>
              {view.driver && <Row icon={<Truck size={16} />} label="Driver" value={view.driver} />}
              <Row icon={<MapPin size={16} />} label="Last seen" value={view.position ? `${view.position.description ?? `${view.position.lat.toFixed(3)}, ${view.position.lon.toFixed(3)}`}` : 'No position yet'} sub={view.position ? `${when(view.position.locatedAt)} · ${agoMin(view.position.locatedAt, now)} min ago` : undefined} />
              {view.load ? (
                <Row icon={<Route size={16} />} label="Current load" value={`${view.load.lane}${view.load.pro ? ` · PRO ${view.load.pro}` : ''}`} sub={view.load.eta ? `ETA ${when(view.load.eta.at)}${view.load.eta.basis === 'appt' ? ' (appointment)' : ''}` : undefined} />
              ) : (
                <Row icon={<Route size={16} />} label="Current load" value="Not on a load right now" />
              )}
              <Row icon={<Clock size={16} />} label="Updates" value="Position refreshes about every 10 minutes; this page checks every minute." />
            </div>
            <div style={{ fontSize: 12, color: '#5c6b7a', textAlign: 'center' }}>Questions? Call BCAT dispatch at (224) 875-6477.</div>
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
