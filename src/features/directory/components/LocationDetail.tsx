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
 * (only a real Google map on real, unexpired coordinates), and the loads that were
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

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 12, marginTop: 10 }}>
      <div style={{ minHeight: 180, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--ds-border, #e5e7eb)' }}>
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
        <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--ds-t2)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          Load history · {history.length}
        </div>
        {history.length === 0 ? (
          <Note>No loads have a stop linked to this location yet.</Note>
        ) : (
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', marginTop: 6 }}>
            <thead>
              <tr style={{ color: 'var(--ds-t3)', textAlign: 'left' }}>
                <th style={th}>Pro #</th><th style={th}>Customer</th><th style={th}>Stop</th><th style={th}>Appt</th><th style={th}>Dwell</th>
              </tr>
            </thead>
            <tbody>
              {history.slice(0, 50).map(({ load, stop }) => {
                const dwell = dwellMinutes(stop)
                return (
                  <tr key={`${load.id}:${stop.id}`} style={{ borderTop: '1px solid var(--ds-border, #e5e7eb)' }}>
                    <td style={td}>{load.aljexId}</td>
                    <td style={td}>{load.customer ?? '—'}</td>
                    <td style={td}>{stop.type === 'pickup' ? 'PU' : 'DEL'}</td>
                    <td style={td}>{stop.appt ? formatDateTime(stop.appt) : '—'}</td>
                    <td style={td} title={dwell === null ? 'Dwell needs recorded arrival and departure times' : undefined}>
                      {dwell === null ? '—' : `${Math.round(dwell)} min`}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

const th: React.CSSProperties = { padding: '4px 6px', fontWeight: 600 }
const td: React.CSSProperties = { padding: '4px 6px', color: 'var(--ds-t2)' }

function Note({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: 12, fontSize: 12, color: 'var(--ds-t3)' }}>{children}</div>
}
