import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Truck, MapPin, Clock, Route } from 'lucide-react'
import { fetchTracking, TrackingError, type TrackingView } from '@/lib/trackingClient'
import { FleetMiniMap } from '@/features/dashboard/FleetMiniMap'
import type { TruckLocation } from '@/lib/apiClient'
import { TmsAlert, TmsCard, TmsMetaList, TmsPublicFrame } from '@/features/tms/kit'

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
    <TmsPublicFrame
      brand="BCAT Logistics"
      subtitle="Live tracking"
      title={view ? `Truck ${view.unit}` : error ? 'Tracking' : 'Loading…'}
      width="md"
      footer={<span>Questions? Call BCAT dispatch at (224) 875-6477.</span>}
    >
      {error ? (
        <TmsAlert tone="red">
          {error.status === 404 ? 'This tracking link is no longer active. Ask BCAT dispatch for a current one.' : error.message}
        </TmsAlert>
      ) : view ? (
        <div className="tms-public-stack">
          <TmsCard flush>
            {location.length ? <FleetMiniMap locations={location} /> : <div className="tms-public-sub">No position reported yet.</div>}
          </TmsCard>
          <TmsCard>
            <TmsMetaList
              items={[
                { label: <Label icon={<Truck size={14} />}>Driver</Label>, value: view.driver, hidden: !view.driver },
                {
                  label: <Label icon={<MapPin size={14} />}>Last seen</Label>,
                  value: (
                    <>
                      {view.position ? `${view.position.description ?? `${view.position.lat.toFixed(3)}, ${view.position.lon.toFixed(3)}`}` : 'No position yet'}
                      {view.position && <div className="tms-public-sub">{`${when(view.position.locatedAt)} · ${agoMin(view.position.locatedAt, now)} min ago`}</div>}
                    </>
                  ),
                },
                {
                  label: <Label icon={<Route size={14} />}>Current load</Label>,
                  value: view.load ? (
                    <>
                      {`${view.load.lane}${view.load.pro ? ` · PRO ${view.load.pro}` : ''}`}
                      {view.load.eta && <div className="tms-public-sub">{`ETA ${when(view.load.eta.at)}${view.load.eta.basis === 'appt' ? ' (appointment)' : ''}`}</div>}
                    </>
                  ) : 'Not on a load right now',
                },
                { label: <Label icon={<Clock size={14} />}>Updates</Label>, value: 'Position refreshes about every 10 minutes; this page checks every minute.' },
              ]}
            />
          </TmsCard>
        </div>
      ) : null}
    </TmsPublicFrame>
  )
}

function Label({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {icon}
      {children}
    </span>
  )
}
