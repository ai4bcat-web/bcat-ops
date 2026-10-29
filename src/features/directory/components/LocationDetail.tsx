import { useMemo, useState } from 'react'
import { APIProvider, Map as GoogleMap, AdvancedMarker } from '@vis.gl/react-google-maps'
import { useAppStore } from '@/store/useAppStore'
import { getStops } from '@/lib/stops'
import { dwellMinutes } from '@/lib/tmsDirectory'
import { formatDateTime } from '@/lib/date'
import type { LocationRecord } from '@/types/tms'
import type { Load, Stop } from '@/types'

const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined
const MAPS_MAP_ID = import.meta.env.VITE_GOOGLE_MAPS_MAP_ID as string | undefined

/**
 * Everything the directory knows about one facility beyond its form fields: the pin
 * (only a real Google map on real, unexpired coordinates), and the shipments that were
 * booked here. Dwell is shown only from recorded arrival/departure events; an
 * appointment time is never turned into a dwell figure.
 */
export function LocationDetail({ location }: { location: LocationRecord }) {
  const [openedAt] = useState(() => Date.now())
  const loads = useAppStore((s) => s.loads)
  const history = useMemo(() => {
    const rows: { load: Load; stop: Stop }[] = []
    for (const load of loads) {
      for (const stop of getStops(load)) if (stop.locationId === location.id) rows.push({ load, stop })
    }
    return rows.sort((a, b) => b.stop.appt.localeCompare(a.stop.appt))
  }, [loads, location.id])

  const hasPin = location.lat != null && location.lng != null
  const pinFresh = hasPin && !!location.geocodeExpiresAt && Date.parse(location.geocodeExpiresAt) > openedAt

  // Unwrapped at the client, but a string must never reach .map here.
  const driverNotes = Array.isArray(location.driverNotes) ? location.driverNotes : []
  return (
    <div className="tms-grid tms-grid-2" style={{ marginTop: 10 }}>
      <div style={{ minHeight: 180, borderRadius: 'var(--tms-radius)', overflow: 'hidden', border: '1px solid var(--tms-border)' }}>
        {!hasPin ? (
          <Note>No geocoded pin yet — search the address in the location form to geocode it.</Note>
        ) : !pinFresh ? (
          <Note>The stored Google geocode has expired — re-run the address search to refresh it before trusting the pin.</Note>
        ) : !MAPS_KEY || !MAPS_MAP_ID ? (
          <Note>Map not configured: set VITE_GOOGLE_MAPS_API_KEY and VITE_GOOGLE_MAPS_MAP_ID. Pin: {location.lat}, {location.lng}</Note>
        ) : (
          <APIProvider apiKey={MAPS_KEY}>
            <GoogleMap
              mapId={MAPS_MAP_ID}
              defaultCenter={{ lat: location.lat!, lng: location.lng! }}
              defaultZoom={15}
              gestureHandling="cooperative"
              disableDefaultUI
              style={{ width: '100%', height: 180 }}
            >
              <AdvancedMarker position={{ lat: location.lat!, lng: location.lng! }} title={location.name} />
            </GoogleMap>
          </APIProvider>
        )}
      </div>
      <div>
        {/* What drivers said, newest first. Written from the driver app; read here. */}
        <div className="tms-field-label">Driver comments · {driverNotes.length}</div>
        {driverNotes.length === 0 ? (
          <Note>No driver has left a note about this place yet. They can, from a stop in the driver app.</Note>
        ) : (
          <ul style={{ margin: '6px 0 12px', padding: 0, listStyle: 'none', fontSize: 12 }}>
            {[...driverNotes].reverse().map((n, i) => (
              <li key={i} className="tms-muted" style={{ padding: '4px 0', borderTop: '1px solid var(--tms-border)' }}>
                <span style={{ fontWeight: 600, color: 'var(--tms-text)' }}>{n.by}</span>
                <span> · {formatDateTime(n.at)}</span>
                <div>{n.text}</div>
              </li>
            ))}
          </ul>
        )}
        <div className="tms-field-label">Shipment history · {history.length}</div>
        {history.length === 0 ? (
          <Note>No shipments have a stop linked to this location yet.</Note>
        ) : (
          <div className="tms-table-wrap" style={{ marginTop: 6 }}>
            <table className="tms-table">
              <thead>
                <tr>
                  <th scope="col">PRO #</th><th scope="col">Customer</th><th scope="col">Stop</th><th scope="col">Appt</th><th scope="col">Dwell</th>
                </tr>
              </thead>
              <tbody>
                {history.slice(0, 50).map(({ load, stop }) => {
                  const dwell = dwellMinutes(stop)
                  return (
                    <tr key={`${load.id}:${stop.id}`}>
                      <td>{load.aljexId}</td>
                      <td>{load.customer ?? '—'}</td>
                      <td>{stop.type === 'pickup' ? 'PU' : 'DEL'}</td>
                      <td>{stop.appt ? formatDateTime(stop.appt) : '—'}</td>
                      <td title={dwell === null ? 'Dwell needs recorded arrival and departure times' : undefined}>
                        {dwell === null ? '—' : `${Math.round(dwell)} min`}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return <div className="tms-muted" style={{ padding: 12, fontSize: 12 }}>{children}</div>
}
