/**
 * The Google implementation of the route map. Lazy-loaded by `RouteMapView`: nothing from
 * Google is requested for a collapsed panel. Draws exactly what the `MapModel` says —
 * pins, route polyline, breadcrumb dots, the current marker, the approximate-fix circle.
 *
 * The viewport fits once per `fitKey` (the load) and again when `recenter` changes; a poll
 * never refits, so a dispatcher who panned is not yanked back.
 */
import { useEffect } from 'react'
import { APIProvider, AdvancedMarker, Map as GoogleMap, useMap, useMapsLibrary } from '@vis.gl/react-google-maps'
import { useTmsTokens } from '@/features/tms/tmsTokens'
import { MAP_TOKENS, toneColour, type MapColours } from './mapTokens'
import type { MapModel } from './mapModel'

function haloColourOf(model: MapModel, tk: MapColours): string {
  return model.current ? toneColour(model.current.tone, tk) : ''
}

function Overlays({ model, fitKey, recenter }: { model: MapModel; fitKey: string; recenter: number }) {
  const map = useMap()
  const maps = useMapsLibrary('maps')
  const tk = useTmsTokens(MAP_TOKENS)
  // Primitives, not the token object: it is a new object after the first read, which would redraw every overlay for nothing.
  const primary = tk['--tms-primary']
  const muted = tk['--tms-muted']
  const orange = tk['--tms-badge-orange']
  const haloColour = haloColourOf(model, tk)

  // Refit on a new load or a Recenter tap — deliberately not on `model`.
  useEffect(() => {
    const bounds = model.bounds
    if (!map || !bounds) return
    if (bounds.south === bounds.north && bounds.west === bounds.east) {
      map.setCenter({ lat: bounds.south, lng: bounds.west })
      map.setZoom(9)
      return
    }
    map.fitBounds({ south: bounds.south, west: bounds.west, north: bounds.north, east: bounds.east }, 40)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `model.bounds` is read once per fitKey/recenter by design
  }, [map, fitKey, recenter])

  const { path, pathStyle, approxCircle, current } = model
  useEffect(() => {
    if (!map || !maps || pathStyle === 'none') return
    const dashed = pathStyle === 'dashed'
    const line = new maps.Polyline({
      map, path, geodesic: false,
      strokeColor: dashed ? muted : primary,
      // A dashed estimate is drawn as repeating icons on an invisible stroke, the Maps idiom.
      strokeOpacity: dashed ? 0 : 0.85, strokeWeight: 3,
      icons: dashed ? [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, scale: 2.5 }, offset: '0', repeat: '14px' }] : undefined,
    })
    return () => line.setMap(null)
  }, [map, maps, path, pathStyle, primary, muted])

  useEffect(() => {
    if (!map || !maps || !approxCircle) return
    const circle = new maps.Circle({
      map, center: { lat: approxCircle.lat, lng: approxCircle.lng }, radius: approxCircle.radiusM,
      fillColor: orange, fillOpacity: 0.15, strokeColor: orange, strokeOpacity: 0.8, strokeWeight: 1,
    })
    return () => circle.setMap(null)
  }, [map, maps, approxCircle, orange])

  useEffect(() => {
    if (!map || !maps || !current?.haloM) return
    const halo = new maps.Circle({
      map, center: { lat: current.lat, lng: current.lng }, radius: current.haloM,
      fillColor: haloColour, fillOpacity: 0.15, strokeOpacity: 0, clickable: false,
    })
    return () => halo.setMap(null)
  }, [map, maps, current, haloColour])

  return (
    <>
      {model.dots.map((dot) => (
        <AdvancedMarker key={dot.at} position={{ lat: dot.lat, lng: dot.lng }} title={dot.title || undefined}>
          <span className={`tms-map-dot${dot.approx ? ' tms-map-dot-approx' : ''}`} data-testid="tracking-map-dot">
            {dot.label ? <span className="tms-map-dot-label">{dot.label}</span> : null}
          </span>
        </AdvancedMarker>
      ))}
      {model.pins.map((pin, i) => (
        <AdvancedMarker key={`${pin.type}-${i}`} position={{ lat: pin.lat, lng: pin.lng }} title={pin.title}>
          <span className={`tms-map-pin tms-map-pin-${pin.type}`} data-testid={`tracking-map-pin-${pin.type}`}>{pin.glyph}</span>
        </AdvancedMarker>
      ))}
      {current && (
        <AdvancedMarker position={{ lat: current.lat, lng: current.lng }} title={current.title} zIndex={10}>
          <span
            className={`tms-map-current tms-map-current-${current.tone}${current.pulse ? ' tms-map-pulse' : ''}`}
            data-testid="tracking-map-current-marker"
          >
            {current.warn ? <span className="tms-map-warn" aria-label="Large jump from the previous position">!</span> : null}
          </span>
        </AdvancedMarker>
      )}
    </>
  )
}

export interface TrackingRouteMapProps {
  apiKey: string
  mapId: string
  model: MapModel
  fitKey: string
  recenter: number
  /** Google tells us (asynchronously, via `window.gm_authFailure`) that the key was refused. */
  onAuthFailure: () => void
}

export default function TrackingRouteMap({ apiKey, mapId, model, fitKey, recenter, onAuthFailure }: TrackingRouteMapProps) {
  useEffect(() => {
    const w = window as unknown as { gm_authFailure?: () => void }
    const previous = w.gm_authFailure
    w.gm_authFailure = () => { onAuthFailure(); previous?.() }
    return () => { w.gm_authFailure = previous }
  }, [onAuthFailure])

  return (
    <div className="tms-map-google" data-testid="tracking-map-google">
      <APIProvider apiKey={apiKey}>
        <GoogleMap
          mapId={mapId}
          defaultCenter={{ lat: 39.8283, lng: -98.5795 }}
          defaultZoom={4}
          gestureHandling="cooperative"
          streetViewControl={false}
          mapTypeControl={false}
          fullscreenControl={false}
        >
          <Overlays model={model} fitKey={fitKey} recenter={recenter} />
        </GoogleMap>
      </APIProvider>
    </div>
  )
}
