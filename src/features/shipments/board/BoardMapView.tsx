import { useEffect } from 'react'
import { APIProvider, Map as GoogleMap, AdvancedMarker, useMap } from '@vis.gl/react-google-maps'

interface GooglePolyline {
  setMap(map: unknown | null): void
}

declare global {
  interface Window {
    google?: {
      maps: {
        Polyline: new (opts: {
          path: Array<{ lat: number; lng: number }>
          geodesic: boolean
          strokeColor: string
          strokeOpacity: number
          strokeWeight: number
          map: unknown
        }) => GooglePolyline
      }
    }
  }
}

export interface BoardMapStop {
  lat?: number | null
  lng?: number | null
  name?: string | null
}

export interface BoardMapRow {
  id: string
  stops?: BoardMapStop[] | null
}

export interface BoardMapViewProps<T extends BoardMapRow> {
  rows: T[]
  apiKey?: string
  mapId?: string
  onOpenShipment: (id: string) => void
}

interface LatLng { lat: number; lng: number }

function validStops(row: BoardMapRow): Array<BoardMapStop & { lat: number; lng: number }> {
  if (!row.stops) return []
  return row.stops
    .map((s) => (s.lat != null && s.lng != null ? { ...s, lat: s.lat, lng: s.lng } : null))
    .filter((p): p is BoardMapStop & { lat: number; lng: number } => p != null)
}

/** Draws one polyline per shipment after the map instance is available. */
function ShipmentPolylines({ paths }: { paths: LatLng[][] }) {
  const map = useMap()

  useEffect(() => {
    const maps = window.google?.maps
    if (!map || !maps) return
    const polylines: GooglePolyline[] = []
    for (const path of paths) {
      if (path.length < 2) continue
      const poly = new maps.Polyline({
        path,
        geodesic: true,
        strokeColor: '#f4c50c',
        strokeOpacity: 0.8,
        strokeWeight: 2,
        map,
      })
      polylines.push(poly)
    }
    return () => {
      for (const poly of polylines) poly.setMap(null)
    }
  }, [map, paths])

  return null
}

/**
 * Map view of the filtered shipments: one marker per stop and one line per shipment.
 *
 * Uses the same Google Maps provider the directory uses; renders a clear message
 * when no API key is configured so the user is never left with a blank square.
 */
export function BoardMapView<T extends BoardMapRow>({ rows, apiKey, mapId, onOpenShipment }: BoardMapViewProps<T>) {
  if (!apiKey) {
    return (
      <div className="tms-board-map tms-board-map-empty">
        Map not configured: set VITE_GOOGLE_MAPS_API_KEY and VITE_GOOGLE_MAPS_MAP_ID.
      </div>
    )
  }

  const markers: { id: string; position: LatLng; title: string }[] = []
  const paths: LatLng[][] = []
  for (const row of rows) {
    const stops = validStops(row)
    if (stops.length > 0) {
      paths.push(stops.map((s) => ({ lat: s.lat, lng: s.lng })))
      for (const stop of stops) {
        markers.push({ id: row.id, position: { lat: stop.lat, lng: stop.lng }, title: stop.name ?? row.id })
      }
    }
  }

  const center = markers[0]?.position ?? { lat: 39.8283, lng: -98.5795 }

  return (
    <div className="tms-board-map">
      <APIProvider apiKey={apiKey}>
        <GoogleMap
          mapId={mapId}
          defaultCenter={center}
          defaultZoom={4}
          gestureHandling="cooperative"
          disableDefaultUI={false}
        >
          {markers.map((m, i) => (
            <AdvancedMarker
              key={`${m.id}:${i}`}
              position={m.position}
              title={m.title}
              onClick={() => onOpenShipment(m.id)}
            />
          ))}
          <ShipmentPolylines paths={paths} />
        </GoogleMap>
      </APIProvider>
    </div>
  )
}

export default BoardMapView
