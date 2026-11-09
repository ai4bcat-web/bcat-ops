import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Navigation, Phone, Square } from 'lucide-react'
import { fetchCarrierTracking, postTrackingPing, postTrackingStatus, TrackingError, type CarrierTrackingView, type DriverStatusKey } from '@/lib/trackingClient'
import { haversineMiles } from '@/lib/polyline'
import { TmsAlert, TmsButton, TmsCard, TmsMetaList, TmsPublicFrame } from '@/features/tms/kit'

const when = (iso: string) => new Date(iso).toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })

/** What the browser's geolocation errors mean to a driver holding a phone. */
function geoMessage(err: GeolocationPositionError): string {
  if (err.code === err.PERMISSION_DENIED) return 'Location is blocked for this page. Turn it on in your phone settings, then tap again.'
  if (err.code === err.POSITION_UNAVAILABLE) return 'Your phone could not get a fix. Step outside the cab and tap again.'
  return 'That took too long. Tap again when you have signal.'
}

/** A phone that has moved this far since the last post sends a fix without waiting out the cadence. */
const MOVED_MILES = 3
/** How often a quiet watch is checked against the cadence; a stationary phone raises no position events. */
const DRIVER_STATUS_BUTTONS: { key: DriverStatusKey; label: string }[] = [
  { key: 'EN_ROUTE', label: 'I am en route to pickup' },
  { key: 'ON_SITE_PICKUP', label: 'On site at pickup' },
  { key: 'DEPARTED_PICKUP', label: 'Departed pickup, in transit' },
  { key: 'ON_SITE_DELIVERY', label: 'On site at delivery' },
  { key: 'DELIVERED', label: 'Delivered' },
]
const CHECK_MS = 30_000
const MINUTE_MS = 60_000

interface WakeLockHandle { release(): Promise<void> }
type WakeLockNav = Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLockHandle> } }

/**
 * The public page behind a carrier driver's ping link. No sign-in; the token in the
 * URL is the key. The driver reads what is shared and agrees; only then does the page
 * ask the phone for its location, send it at once and keep sending it every few
 * minutes while the page stays open. No customer, no rates.
 */
export function CarrierPingPage() {
  const { token = '' } = useParams()
  const [view, setView] = useState<CarrierTrackingView | null>(null)
  const [error, setError] = useState<{ status: number; message: string } | null>(null)
  const [agreed, setAgreed] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [done, setDone] = useState(false)
  const [lastSentAt, setLastSentAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [pingError, setPingError] = useState<string | null>(null)
  const [keepAwake, setKeepAwake] = useState(false)
  const [eta, setEta] = useState('')
  const [statusBusy, setStatusBusy] = useState(false)
  const [statusSent, setStatusSent] = useState<DriverStatusKey | null>(null)

  const watchId = useRef<number | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const latest = useRef<GeolocationPosition | null>(null)
  const lastPost = useRef<{ at: number; lat: number; lng: number } | null>(null)
  const inFlight = useRef(false)
  const wakeLock = useRef<WakeLockHandle | null>(null)

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

  const stopWatching = useCallback(() => {
    if (watchId.current != null) navigator.geolocation?.clearWatch(watchId.current)
    watchId.current = null
    if (timer.current != null) clearInterval(timer.current)
    timer.current = null
    latest.current = null
    void wakeLock.current?.release().catch(() => undefined)
    wakeLock.current = null
  }, [])

  // Leaving the page ends the watch: nothing is collected when the page is closed.
  useEffect(() => stopWatching, [stopWatching])

  const everyMin = view?.share?.everyMin ?? 5
  const consentRequired = view?.share?.consentRequired ?? true

  const post = useCallback((pos: GeolocationPosition, trigger: 'tap' | 'watch') => {
    inFlight.current = true
    const { latitude: lat, longitude: lng, accuracy, speed, heading } = pos.coords
    return postTrackingPing(token, {
      lat,
      lng,
      accuracyM: Number.isFinite(accuracy) ? Math.round(accuracy) : null,
      fixAt: new Date(pos.timestamp).toISOString(),
      // The browser reports metres per second; the server stores miles per hour.
      speedMph: speed != null && Number.isFinite(speed) ? Math.round(speed * 2.23694) : null,
      headingDeg: heading != null && Number.isFinite(heading) ? Math.round(heading) : null,
      trigger,
      ...(consentRequired && agreed ? { consent: true as const } : {}),
    })
      .then(() => {
        const at = Date.now()
        lastPost.current = { at, lat, lng }
        setLastSentAt(at)
        setPingError(null)
        return refresh()
      })
      .catch((e: unknown) => {
        if (e instanceof TrackingError && e.status === 410) {
          stopWatching()
          setSharing(false)
          setDone(true)
          return
        }
        if (e instanceof TrackingError && e.status === 429) {
          // Already in: the server has a fix from the last minute, which is what we wanted.
          lastPost.current = { at: Date.now(), lat, lng }
          return
        }
        if (e instanceof TrackingError && e.status === 403) {
          stopWatching()
          setSharing(false)
          setPingError('Sharing needs your agreement first. Tick the box and tap Start sharing.')
          return
        }
        setPingError(e instanceof TrackingError ? e.message : 'Could not send your location. It will try again.')
      })
      .finally(() => { inFlight.current = false })
  }, [token, refresh, stopWatching, consentRequired, agreed])

  /** Sends the newest fix when the cadence is up or the phone has moved; the very first fix goes out at once. */
  const maybePost = useCallback(() => {
    const pos = latest.current
    if (!pos || inFlight.current) return
    const last = lastPost.current
    const moved = last != null &&
      haversineMiles({ lat: last.lat, lng: last.lng }, { lat: pos.coords.latitude, lng: pos.coords.longitude }) > MOVED_MILES
    const due = last == null || Date.now() - last.at >= everyMin * MINUTE_MS || moved
    if (due) void post(pos, last == null ? 'tap' : 'watch')
  }, [post, everyMin])

  const start = useCallback(() => {
    if (!navigator.geolocation) {
      setPingError('This phone cannot share its location. Call the office instead.')
      return
    }
    setPingError(null)
    setSharing(true)
    lastPost.current = null
    watchId.current = navigator.geolocation.watchPosition(
      (pos) => { latest.current = pos; maybePost() },
      (err) => {
        setPingError(geoMessage(err))
        if (err.code === err.PERMISSION_DENIED) { stopWatching(); setSharing(false) }
      },
      { enableHighAccuracy: true, maximumAge: 30_000, timeout: 20_000 },
    )
    timer.current = setInterval(() => { setNow(Date.now()); maybePost() }, CHECK_MS)
    const nav = navigator as WakeLockNav
    if (keepAwake && nav.wakeLock) {
      void nav.wakeLock.request('screen').then((h) => { wakeLock.current = h }).catch(() => undefined)
    }
  }, [maybePost, stopWatching, keepAwake])

  const tapStatus = useCallback(async (key: DriverStatusKey) => {
    setStatusBusy(true)
    try {
      await postTrackingStatus(token, key, key === 'EN_ROUTE' && eta ? new Date(eta).toISOString() : null)
      setStatusSent(key)
      setPingError(null)
      if (key === 'DELIVERED') void refresh()
    } catch (e) {
      setPingError(e instanceof TrackingError ? e.message : 'Could not send your status. Try again.')
    } finally { setStatusBusy(false) }
  }, [token, eta, refresh])

  const stop = useCallback(() => {
    stopWatching()
    setSharing(false)
  }, [stopWatching])

  const nextStop = view?.nextStop ?? null
  const share = view?.share
  const closed = done || share?.active === false
  const supportsWakeLock = typeof navigator !== 'undefined' && 'wakeLock' in navigator
  const sentMinutes = lastSentAt == null ? null : Math.max(0, Math.floor((now - lastSentAt) / MINUTE_MS))

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

          {closed ? (
            <TmsAlert tone="green">Delivery complete — sharing has stopped. Thank you.</TmsAlert>
          ) : sharing ? (
            <>
              <TmsAlert tone="green">
                {sentMinutes == null
                  ? 'Sharing · getting your first location… · keep this page open'
                  : `Sharing · last sent ${sentMinutes < 1 ? 'just now' : `${sentMinutes} min ago`} · keep this page open`}
              </TmsAlert>
              <p className="tms-public-sub">
                Keep this page open and the screen on. A phone that is locked or in another app stops sharing;
                for continuous tracking dispatch can use your ELD.
              </p>
              <TmsButton variant="secondary" className="tms-public-cta" onClick={stop}>
                <Square size={20} />
                Stop sharing
              </TmsButton>
            </>
          ) : (
            <>
              {share && <p className="tms-public-sub" data-testid="consent-text">{share.consentText}</p>}
              {consentRequired && (
                <label className="tms-public-check">
                  <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
                  I agree
                </label>
              )}
              {supportsWakeLock && (
                <label className="tms-public-check">
                  <input type="checkbox" checked={keepAwake} onChange={(e) => setKeepAwake(e.target.checked)} />
                  Keep screen on
                </label>
              )}
              <TmsButton
                variant="primary"
                className="tms-public-cta"
                onClick={start}
                disabled={consentRequired && !agreed}
              >
                <Navigation size={20} />
                Start sharing
              </TmsButton>
            </>
          )}

          {!closed && sharing && (
            <TmsCard title="Update your status">
              <label className="tms-public-sub" htmlFor="driver-eta">ETA to pickup (optional)</label>
              <input id="driver-eta" type="datetime-local" value={eta} onChange={(e) => setEta(e.target.value)} data-testid="driver-eta" />
              <div className="tms-public-stack">
                {DRIVER_STATUS_BUTTONS.map(({ key, label }) => (
                  <TmsButton key={key} variant={statusSent === key ? 'primary' : 'secondary'} className="tms-public-cta" disabled={statusBusy} data-testid={`driver-status-${key}`} onClick={() => void tapStatus(key)}>
                    {label}
                  </TmsButton>
                ))}
              </div>
              {statusSent && <p className="tms-public-sub">Sent: {DRIVER_STATUS_BUTTONS.find((b) => b.key === statusSent)?.label}</p>}
            </TmsCard>
          )}

          {pingError && <TmsAlert tone="red">{pingError}</TmsAlert>}

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
