import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Navigation, Phone } from 'lucide-react'
import { fetchCarrierTracking, postTrackingPing, TrackingError, type CarrierTrackingView } from '@/lib/trackingClient'
import { TmsAlert, TmsButton, TmsCard, TmsMetaList, TmsPublicFrame } from '@/features/tms/kit'

const when = (iso: string) => new Date(iso).toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })

/** What the browser's geolocation errors mean to a driver holding a phone. */
function geoMessage(err: GeolocationPositionError): string {
  if (err.code === err.PERMISSION_DENIED) return 'Location is blocked for this page. Turn it on in your phone settings, then tap again.'
  if (err.code === err.POSITION_UNAVAILABLE) return 'Your phone could not get a fix. Step outside the cab and tap again.'
  return 'That took too long. Tap again when you have signal.'
}

/**
 * The public page behind a carrier driver's ping link. No sign-in; the token in the
 * URL is the key. One button: it reads the phone's location and sends it, so the
 * office can see where the freight is without calling. No customer, no rates.
 */
export function CarrierPingPage() {
  const { token = '' } = useParams()
  const [view, setView] = useState<CarrierTrackingView | null>(null)
  const [error, setError] = useState<{ status: number; message: string } | null>(null)
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState<string | null>(null)
  const [pingError, setPingError] = useState<string | null>(null)

  // Non-async on purpose: `react-hooks/set-state-in-effect` cannot see through an
  // `async` function, so the state writes live in an explicit promise chain.
  const refresh = useCallback(() => fetchCarrierTracking(token)
    .then((v) => { setView(v); setError(null) })
    .catch((e: unknown) => {
      setError(e instanceof TrackingError ? { status: e.status, message: e.message } : { status: 0, message: 'Could not load tracking' })
    }), [token])

  useEffect(() => {
    refresh()
    // Background tabs stop polling so they do not spend the link's request budget.
    const t = setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 60_000)
    return () => clearInterval(t)
  }, [refresh])

  const share = useCallback(() => {
    if (!navigator.geolocation) {
      setPingError('This phone cannot share its location. Call the office instead.')
      return
    }
    setSending(true)
    setPingError(null)
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const res = await postTrackingPing(token, {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracyM: Number.isFinite(pos.coords.accuracy) ? Math.round(pos.coords.accuracy) : null,
          })
          setSent(res.at)
          await refresh()
        } catch (e) {
          setPingError(e instanceof TrackingError ? e.message : 'Could not send your location. Try again in a minute.')
        } finally {
          setSending(false)
        }
      },
      (err) => { setPingError(geoMessage(err)); setSending(false) },
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
    )
  }, [token, refresh])

  const nextStop = view?.nextStop ?? null

  return (
    <TmsPublicFrame
      brand="BCAT Logistics"
      subtitle="Driver check-in"
      title={view ? `Load ${view.loadNumber}` : error ? 'Check-in' : 'Loading…'}
      width="sm"
      footer={
        <span className="tms-public-footer-line">
          <Phone size={14} />
          {view?.contactPhone ? <a href={`tel:${view.contactPhone}`}>{view.contactPhone}</a> : 'Call BCAT dispatch at (224) 875-6477.'}
        </span>
      }
    >
      {error ? (
        <TmsAlert tone="red">
          {error.status === 404 ? 'This tracking link is no longer active. Call BCAT dispatch for a current one.' : error.message}
        </TmsAlert>
      ) : view ? (
        <div className="tms-public-stack">
          <TmsCard>
            <TmsMetaList
              items={[
                { label: 'Status', value: view.statusLabel },
                {
                  label: 'Next stop',
                  value: (
                    <>
                      {nextStop ? [nextStop.city, nextStop.state].filter(Boolean).join(', ') || nextStop.name || 'Next stop' : 'All stops complete'}
                      {nextStop?.appt && <div className="tms-public-sub">Appointment {when(nextStop.appt)}</div>}
                    </>
                  ),
                },
              ]}
            />
          </TmsCard>

          <TmsButton variant="primary" className="tms-public-cta" onClick={share} disabled={sending}>
            <Navigation size={20} />
            {sending ? 'Sending…' : 'Share my location'}
          </TmsButton>

          {pingError && <TmsAlert tone="red">{pingError}</TmsAlert>}

          {sent && !pingError && (
            <TmsAlert tone="green">Thanks — the office has your location as of {when(sent)}.</TmsAlert>
          )}

          {view.pings.length > 0 && (
            <TmsCard title="Your recent check-ins">
              <ul className="tms-public-list">
                {view.pings.slice(0, 5).map((ping) => (
                  <li key={ping.at}>
                    {when(ping.at)}
                    {ping.lat != null && ping.lng != null && (
                      <span className="tms-muted"> · {ping.lat.toFixed(3)}, {ping.lng.toFixed(3)}</span>
                    )}
                  </li>
                ))}
              </ul>
            </TmsCard>
          )}
        </div>
      ) : null}
    </TmsPublicFrame>
  )
}

export default CarrierPingPage
