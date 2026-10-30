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

interface LatLng { lat: number; lng: number }

function RoutePolyline({ from, to }: { from: LatLng; to: LatLng }) {
  const map = useMap()

  useEffect(() => {
    const maps = window.google?.maps
    if (!map || !maps) return
    const poly = new maps.Polyline({
      path: [from, to],
      geodesic: true,
      strokeColor: '#f4c50c',
      strokeOpacity: 0.9,
      strokeWeight: 3,
      map,
    })
    return () => { poly.setMap(null) }
  }, [map, from, to])

  return null
}

export interface TrackingDetailMapProps {
  apiKey?: string
  mapId?: string
  lastKnown: LatLng | null
  delivery: LatLng | null
  deliveryName?: string | null
}

export function TrackingDetailMap({ apiKey, mapId, lastKnown, delivery, deliveryName }: TrackingDetailMapProps) {
  if (!apiKey) {
    return (
      <div className="tms-detail-map-empty">
        Map not configured: set VITE_GOOGLE_MAPS_API_KEY and VITE_GOOGLE_MAPS_MAP_ID.
      </div>
    )
  }

  const markers: { position: LatLng; title: string; color?: string }[] = []
  if (lastKnown) markers.push({ position: lastKnown, title: 'Last known position', color: '#f4c50c' })
  if (delivery) markers.push({ position: delivery, title: deliveryName ?? 'Delivery stop', color: '#09e2e5' })

  const center = lastKnown ?? delivery ?? { lat: 39.8283, lng: -98.5795 }

  return (
    <div className="tms-detail-map">
      <APIProvider apiKey={apiKey}>
        <GoogleMap
          mapId={mapId}
          defaultCenter={center}
          defaultZoom={lastKnown && delivery ? 7 : 4}
          gestureHandling="cooperative"
          disableDefaultUI={false}
        >
          {markers.map((m, i) => (
            <AdvancedMarker key={i} position={m.position} title={m.title}>
              <div
                className="tms-detail-map-pin"
                style={{ background: m.color }}
                aria-label={m.title}
              />
            </AdvancedMarker>
          ))}
          {lastKnown && delivery && <RoutePolyline from={lastKnown} to={delivery} />}
        </GoogleMap>
      </APIProvider>
    </div>
  )
}
