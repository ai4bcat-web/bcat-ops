import { useEffect, useMemo, useState } from 'react'
import { Map as GoogleMap, AdvancedMarker, useMap } from '@vis.gl/react-google-maps'
import { geoAlbersUsa, geoPath, type GeoProjection } from 'd3-geo'
import { feature } from 'topojson-client'
import type { Topology } from 'topojson-specification'
import type { FeatureCollection } from 'geojson'

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

/**
 * The rest of the Maps bundle this pane leans on. Declared here rather than on
 * `Window.google` because that global is shared with the board map, and two
 * declarations of the same property must match exactly — widening it would
 * break the other reader for no one's benefit.
 */
interface GoogleMapsExtras {
  LatLngBounds?: new () => { extend(p: LatLng): void }
  DistanceMatrixService?: new () => {
    getDistanceMatrix(
      request: {
        origins: LatLng[]
        destinations: LatLng[]
        travelMode: string
      },
      callback: (
        response: {
          rows: Array<{
            elements: Array<{
              status: string
              distance?: { value: number }
              duration?: { value: number }
            }>
          }>
        } | null,
        status: string,
      ) => void,
    ): void
  }
}

/** The extra Maps APIs, when the bundle the map already loaded exposes them. */
export function googleMapsExtras(): GoogleMapsExtras | undefined {
  return window.google?.maps as unknown as GoogleMapsExtras | undefined
}

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

/**
 * Keeps the framed shipment in view: when the selection changes, refit to the
 * last-known fix and the consignee instead of leaving the previous shipment's
 * pan/zoom on screen.
 */
function ViewportController({ lastKnown, delivery }: { lastKnown: LatLng | null; delivery: LatLng | null }) {
  const map = useMap()

  useEffect(() => {
    const boundsCtor = googleMapsExtras()?.LatLngBounds
    if (!map || !boundsCtor) return
    if (lastKnown && delivery) {
      const bounds = new boundsCtor()
      bounds.extend(lastKnown)
      bounds.extend(delivery)
      map.fitBounds(bounds as never, 64)
      return
    }
    const point = lastKnown ?? delivery
    if (point) {
      map.setCenter(point)
      map.setZoom(7)
    }
  }, [map, lastKnown, delivery])

  return null
}

/* ── No-key fallback ──────────────────────────────────────────────────────────
 * Same free pattern as the fleet board map (Census state boundaries via
 * us-atlas TopoJSON + d3-geo Albers-USA): the last-known fix, the consignee
 * and the route between them stay visible without a Google key.
 */

const W = 590
const H = 300
const PAD = 28

function pointFeature(p: LatLng) {
  return { type: 'Feature' as const, properties: {}, geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] } }
}

function StaticRouteMap({ lastKnown, delivery, deliveryName }: {
  lastKnown: LatLng | null
  delivery: LatLng | null
  deliveryName?: string | null
}) {
  const [states, setStates] = useState<FeatureCollection | null>(null)

  useEffect(() => {
    let alive = true
    import('us-atlas/states-10m.json')
      .then((mod) => {
        if (!alive) return
        const topo = (mod.default ?? mod) as unknown as Topology
        setStates(feature(topo, topo.objects.states) as unknown as FeatureCollection)
      })
      .catch((err) => console.error('[TrackingDetailMap] failed to load US map', err))
    return () => { alive = false }
  }, [])

  const projection = useMemo<GeoProjection | null>(() => {
    if (!states) return null
    // Two distinct points: frame the leg between them. Anything else: the whole US.
    if (lastKnown && delivery && (lastKnown.lat !== delivery.lat || lastKnown.lng !== delivery.lng)) {
      const leg = { type: 'FeatureCollection' as const, features: [pointFeature(lastKnown), pointFeature(delivery)] }
      return geoAlbersUsa().fitExtent([[PAD, PAD], [W - PAD, H - PAD]], leg)
    }
    return geoAlbersUsa().fitSize([W, H], states)
  }, [states, lastKnown, delivery])

  const paths = useMemo(() => {
    if (!states || !projection) return []
    const path = geoPath(projection)
    return states.features.map((f) => path(f) ?? '').filter(Boolean)
  }, [states, projection])

  const lastKnownXY = projection && lastKnown ? projection([lastKnown.lng, lastKnown.lat]) : null
  const deliveryXY = projection && delivery ? projection([delivery.lng, delivery.lat]) : null

  return (
    <div className="tms-detail-map" data-testid="tracking-detail-map">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height="100%"
        role="img"
        aria-label="Route map"
        style={{ display: 'block', background: 'var(--ds-bg, transparent)' }}
      >
        {paths.length === 0 ? (
          <text x={W / 2} y={H / 2} textAnchor="middle" fontSize={13} fill="var(--ds-t3, #94a3b8)">Loading map…</text>
        ) : (
          <g>
            {paths.map((d, i) => (
              <path key={i} d={d} fill="rgba(30,168,243,0.05)" stroke="rgba(30,168,243,0.30)" strokeWidth={0.6} strokeLinejoin="round" />
            ))}
            {lastKnownXY && deliveryXY && (
              <line
                x1={lastKnownXY[0]} y1={lastKnownXY[1]}
                x2={deliveryXY[0]} y2={deliveryXY[1]}
                stroke="#f4c50c" strokeWidth={2} strokeDasharray="6 4" strokeOpacity={0.9}
              />
            )}
            {deliveryXY && (
              <g transform={`translate(${deliveryXY[0]} ${deliveryXY[1]})`}>
                <title>{deliveryName ?? 'Consignee'}</title>
                <circle r={5} fill="#0ea5e9" stroke="#fff" strokeWidth={1.2} />
              </g>
            )}
            {lastKnownXY && (
              <g transform={`translate(${lastKnownXY[0]} ${lastKnownXY[1]})`}>
                <title>Last known position</title>
                <circle r={8} fill="rgba(244,197,12,0.20)" />
                <circle r={4.5} fill="#f4c50c" stroke="#fff" strokeWidth={1.2} />
              </g>
            )}
          </g>
        )}
      </svg>
      {paths.length > 0 && !lastKnownXY && !deliveryXY && (
        <p className="tms-muted" style={{ margin: '4px 0 0', fontSize: 11.5, textAlign: 'center' }}>
          No position or consignee coordinates yet
        </p>
      )}
    </div>
  )
}

export interface TrackingDetailMapProps {
  apiKey?: string
  mapId?: string
  lastKnown: LatLng | null
  delivery: LatLng | null
  deliveryName?: string | null
}

/**
 * The selected shipment's map: last-known fix, consignee and the route between
 * them. With a Google key this is the interactive map (the caller wraps it in
 * an `APIProvider`); without one it falls back to the static US outline so the
 * route and positions are still visible.
 */
export function TrackingDetailMap({ apiKey, mapId, lastKnown, delivery, deliveryName }: TrackingDetailMapProps) {
  if (!apiKey) {
    return <StaticRouteMap lastKnown={lastKnown} delivery={delivery} deliveryName={deliveryName} />
  }

  const markers: { position: LatLng; title: string; color?: string }[] = []
  if (lastKnown) markers.push({ position: lastKnown, title: 'Last known position', color: '#f4c50c' })
  if (delivery) markers.push({ position: delivery, title: deliveryName ?? 'Delivery stop', color: '#0ea5e9' })

  const center = lastKnown ?? delivery ?? { lat: 39.8283, lng: -98.5795 }

  return (
    <div className="tms-detail-map" data-testid="tracking-detail-map">
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
        <ViewportController lastKnown={lastKnown} delivery={delivery} />
      </GoogleMap>
    </div>
  )
}
