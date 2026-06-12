import { useEffect, useMemo, useState } from 'react'
import {
  APIProvider, Map, AdvancedMarker, Pin, InfoWindow,
  useMap, useMapsLibrary,
} from '@vis.gl/react-google-maps'
import { formatDistanceToNow } from 'date-fns'
import { MapPin } from 'lucide-react'
import {
  listTruckLocations, listTruckLocationHistory, type TruckLocation,
} from '@/lib/apiClient'

const API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined
// Advanced markers require a Map ID. A real cloud-styled ID can be supplied via
// VITE_GOOGLE_MAPS_MAP_ID; otherwise Google's DEMO_MAP_ID renders fine.
const MAP_ID = (import.meta.env.VITE_GOOGLE_MAPS_MAP_ID as string | undefined) ?? 'DEMO_MAP_ID'

const STALE_MS = 2 * 60 * 60 * 1000   // dim trucks not reporting for >2h
const US_CENTER = { lat: 39.5, lng: -98.35 }

type LatLng = { lat: number; lng: number }

// ── Card shell (matches dashboard card styling) ──────────────────────────────

function CardShell({ sub, children, right }: { sub?: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--ds-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)', display: 'flex', alignItems: 'center', gap: 7 }}>
            <MapPin size={15} /> Fleet — Live Locations
          </div>
          {sub && <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 2 }}>{sub}</div>}
        </div>
        {right && <div style={{ flexShrink: 0 }}>{right}</div>}
      </div>
      {children}
    </div>
  )
}

// ── Map helpers (use the loaded Maps libraries, no global google types) ──────

function FitBounds({ locations }: { locations: TruckLocation[] }) {
  const map = useMap()
  const core = useMapsLibrary('core')
  useEffect(() => {
    if (!map || !core || locations.length === 0) return
    if (locations.length === 1) {
      map.setCenter({ lat: locations[0].lat, lng: locations[0].lon })
      map.setZoom(9)
      return
    }
    const bounds = new core.LatLngBounds()
    locations.forEach((l) => bounds.extend({ lat: l.lat, lng: l.lon }))
    map.fitBounds(bounds, 64)
  }, [map, core, locations])
  return null
}

function Breadcrumb({ points }: { points: LatLng[] }) {
  const map = useMap()
  const maps = useMapsLibrary('maps')
  useEffect(() => {
    if (!map || !maps || points.length < 2) return
    const line = new maps.Polyline({
      path: points, geodesic: true,
      strokeColor: '#1ea8f3', strokeOpacity: 0.9, strokeWeight: 3,
    })
    line.setMap(map)
    return () => line.setMap(null)
  }, [map, maps, points])
  return null
}

// ── Widget ───────────────────────────────────────────────────────────────────

export function TruckMapWidget() {
  const [locations, setLocations] = useState<TruckLocation[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [trailData, setTrailData] = useState<{ id: string; points: LatLng[] } | null>(null)
  // Captured once at mount — used only to flag stale (>2h) truck markers.
  const [now] = useState(() => Date.now())

  useEffect(() => {
    listTruckLocations()
      .then(setLocations)
      .catch((e) => console.error('listTruckLocations failed', e))
      .finally(() => setLoading(false))
  }, [])

  // Load breadcrumb history for the clicked truck.
  useEffect(() => {
    if (!selectedId) return
    let cancelled = false
    listTruckLocationHistory(selectedId)
      .then((h) => { if (!cancelled) setTrailData({ id: selectedId, points: h.map((p) => ({ lat: p.lat, lng: p.lon })) }) })
      .catch(() => { if (!cancelled) setTrailData({ id: selectedId, points: [] }) })
    return () => { cancelled = true }
  }, [selectedId])

  // Only show the trail belonging to the currently-selected truck.
  const trail = useMemo(
    () => (selectedId && trailData?.id === selectedId ? trailData.points : []),
    [selectedId, trailData],
  )

  const selected = useMemo(
    () => locations.find((l) => l.truckId === selectedId) ?? null,
    [locations, selectedId],
  )

  const freshest = useMemo(() => {
    if (locations.length === 0) return null
    return locations.reduce((a, b) => (a.locatedAt > b.locatedAt ? a : b)).locatedAt
  }, [locations])

  const sub = loading
    ? 'Loading…'
    : locations.length === 0
      ? 'No truck positions yet'
      : `${locations.length} truck${locations.length === 1 ? '' : 's'}` +
        (freshest ? ` · updated ${formatDistanceToNow(new Date(freshest), { addSuffix: true })}` : '')

  // Missing API key — render a helpful inline notice instead of a blank map.
  if (!API_KEY) {
    return (
      <CardShell sub="Map unavailable">
        <div style={{ padding: 24, fontSize: 13, color: 'var(--ds-t3)', lineHeight: 1.6 }}>
          Google Maps API key not configured. Set <code style={{ fontFamily: 'var(--font-mono)' }}>VITE_GOOGLE_MAPS_API_KEY</code> in
          your environment (and Amplify build settings) to enable the live fleet map.
        </div>
      </CardShell>
    )
  }

  return (
    <CardShell sub={sub}>
      <div style={{ height: 380, width: '100%' }}>
        <APIProvider apiKey={API_KEY}>
          <Map
            mapId={MAP_ID}
            defaultCenter={US_CENTER}
            defaultZoom={4}
            gestureHandling="greedy"
            disableDefaultUI={false}
            style={{ width: '100%', height: '100%' }}
          >
            <FitBounds locations={locations} />
            {trail.length >= 2 && <Breadcrumb points={trail} />}

            {locations.map((loc) => {
              const stale = now - new Date(loc.locatedAt).getTime() > STALE_MS
              return (
                <AdvancedMarker
                  key={loc.truckId}
                  position={{ lat: loc.lat, lng: loc.lon }}
                  onClick={() => setSelectedId(loc.truckId)}
                >
                  <Pin
                    background={stale ? '#94a3b8' : '#1ea8f3'}
                    borderColor={stale ? '#64748b' : '#0b5d8a'}
                    glyphColor="#fff"
                  >
                    {loc.unitNumber}
                  </Pin>
                </AdvancedMarker>
              )
            })}

            {selected && (
              <InfoWindow
                position={{ lat: selected.lat, lng: selected.lon }}
                onCloseClick={() => setSelectedId(null)}
              >
                <div style={{ fontFamily: 'inherit', minWidth: 160 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>Unit {selected.unitNumber}</div>
                  {selected.description && (
                    <div style={{ fontSize: 12, color: '#475569', marginTop: 2 }}>{selected.description}</div>
                  )}
                  <div style={{ fontSize: 12, color: '#475569', marginTop: 4 }}>
                    {selected.speed != null ? `${Math.round(selected.speed)} mph` : 'Stationary'}
                  </div>
                  <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>
                    Updated {formatDistanceToNow(new Date(selected.locatedAt), { addSuffix: true })}
                  </div>
                </div>
              </InfoWindow>
            )}
          </Map>
        </APIProvider>
      </div>
    </CardShell>
  )
}
