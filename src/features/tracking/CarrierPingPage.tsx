import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { CheckCircle2, MapPin, Navigation, Phone, Truck } from 'lucide-react'
import { fetchCarrierTracking, postTrackingPing, TrackingError, type CarrierTrackingView } from '@/lib/trackingClient'

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
    <div style={{ minHeight: '100vh', background: '#f4f6f8', color: '#15202b', fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif', padding: '24px 16px' }}>
      <div style={{ maxWidth: 480, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <Truck size={22} style={{ color: '#1ea8f3' }} />
          <div>
            <div style={{ fontSize: 12, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#5c6b7a', fontWeight: 600 }}>BCAT Logistics · driver check-in</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{view ? `Load ${view.loadNumber}` : error ? 'Check-in' : 'Loading…'}</div>
          </div>
        </div>

        {error ? (
          <div style={{ background: '#fff', border: '1px solid #e3e8ee', borderRadius: 12, padding: 20, fontSize: 15 }}>
            {error.status === 404 ? 'This tracking link is no longer active. Call BCAT dispatch for a current one.' : error.message}
          </div>
        ) : view ? (
          <div style={{ display: 'grid', gap: 12 }}>
            <div style={{ background: '#fff', border: '1px solid #e3e8ee', borderRadius: 12, padding: '16px 18px', display: 'grid', gap: 10 }}>
              <div>
                <div style={{ fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#5c6b7a', fontWeight: 600 }}>Status</div>
                <div style={{ fontSize: 15, fontWeight: 600 }}>{view.statusLabel}</div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '24px 1fr', gap: 10, alignItems: 'start' }}>
                <span style={{ color: '#1ea8f3', marginTop: 2 }}><MapPin size={16} /></span>
                <div>
                  <div style={{ fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#5c6b7a', fontWeight: 600 }}>Next stop</div>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>
                    {nextStop ? [nextStop.city, nextStop.state].filter(Boolean).join(', ') || nextStop.name || 'Next stop' : 'All stops complete'}
                  </div>
                  {nextStop?.appt && <div style={{ fontSize: 13, color: '#5c6b7a', marginTop: 2 }}>Appointment {when(nextStop.appt)}</div>}
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={share}
              disabled={sending}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                width: '100%', padding: '22px 18px', border: 'none', borderRadius: 12,
                background: sending ? '#8ac9ef' : '#1ea8f3', color: '#fff',
                fontSize: 19, fontWeight: 700, fontFamily: 'inherit',
                cursor: sending ? 'default' : 'pointer',
              }}
            >
              <Navigation size={20} />
              {sending ? 'Sending…' : 'Share my location'}
            </button>

            {pingError && (
              <div style={{ background: '#fff4f4', border: '1px solid #f3c4c4', borderRadius: 12, padding: '14px 16px', fontSize: 14, color: '#8a1f1f' }}>
                {pingError}
              </div>
            )}

            {sent && !pingError && (
              <div style={{ background: '#f1fbf4', border: '1px solid #bfe6cc', borderRadius: 12, padding: '14px 16px', fontSize: 14, color: '#14612f', display: 'flex', gap: 8, alignItems: 'center' }}>
                <CheckCircle2 size={16} />
                Thanks — the office has your location as of {when(sent)}.
              </div>
            )}

            {view.pings.length > 0 && (
              <div style={{ background: '#fff', border: '1px solid #e3e8ee', borderRadius: 12, padding: '16px 18px' }}>
                <div style={{ fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#5c6b7a', fontWeight: 600, marginBottom: 8 }}>Your recent check-ins</div>
                <div style={{ display: 'grid', gap: 6 }}>
                  {view.pings.slice(0, 5).map((ping) => (
                    <div key={ping.at} style={{ fontSize: 14 }}>
                      {when(ping.at)}
                      {ping.lat != null && ping.lng != null && (
                        <span style={{ color: '#5c6b7a' }}> · {ping.lat.toFixed(3)}, {ping.lng.toFixed(3)}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{ fontSize: 13, color: '#5c6b7a', textAlign: 'center', display: 'flex', gap: 6, justifyContent: 'center', alignItems: 'center' }}>
              <Phone size={14} />
              {view.contactPhone ? <a href={`tel:${view.contactPhone}`} style={{ color: '#1ea8f3' }}>{view.contactPhone}</a> : 'Call BCAT dispatch at (224) 875-6477.'}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

export default CarrierPingPage
