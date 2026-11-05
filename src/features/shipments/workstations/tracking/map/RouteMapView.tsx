/**
 * Chooses how a `MapModel` is drawn: Google when a browser key exists and Google accepts it,
 * the offline outline otherwise. Shared by the staff panel and the customer page, so the two
 * can never disagree about what a fix looks like. The Google chunk is `React.lazy` and is
 * only requested when this component renders with a key.
 */
import { Component, lazy, Suspense, useCallback, useState, type ReactNode } from 'react'
import { FallbackRouteMap } from './FallbackRouteMap'
import type { MapModel } from './mapModel'

const TrackingRouteMap = lazy(() => import('./TrackingRouteMap'))

const NO_KEY_CAPTION = 'Google map not configured — showing outline'
const AUTH_CAPTION = 'Google rejected the map key or could not load — showing outline'
const CHUNK_CAPTION = 'Google map could not load — showing outline'

/** A failed lazy chunk (offline, a stale deploy) degrades to the outline instead of blanking the drawer. */
class ChunkBoundary extends Component<{ onFail: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch() { this.props.onFail() }
  render() { return this.state.failed ? null : this.props.children }
}

export function RouteMapView({ model, fitKey, recenter = 0 }: { model: MapModel; fitKey: string; recenter?: number }) {
  const apiKey = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined) || ''
  const mapId = (import.meta.env.VITE_GOOGLE_MAPS_MAP_ID as string | undefined) || 'DEMO_MAP_ID'
  const [authFailed, setAuthFailed] = useState(false)
  const [chunkFailed, setChunkFailed] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  const onAuthFailure = useCallback(() => setAuthFailed(true), [])
  const onChunkFail = useCallback(() => setChunkFailed(true), [])
  const onUnavailable = useCallback(() => setUnavailable(true), [])

  const google = apiKey !== '' && !authFailed && !chunkFailed
  const reason = apiKey === '' ? NO_KEY_CAPTION : authFailed ? AUTH_CAPTION : chunkFailed ? CHUNK_CAPTION : null
  const staff = model.mode === 'staff'
  const caption = [staff ? reason : null, model.caption].filter(Boolean).join(' · ') || null

  return (
    <div
      className="tms-map-body-inner" data-testid="tracking-map" data-mode={google ? 'google' : unavailable ? 'unavailable' : 'fallback'}
      data-fixes={model.meta.fixes} data-breadcrumbs={model.dots.length} data-current-source={model.meta.currentSource ?? ''}
    >
      {google ? (
        <ChunkBoundary onFail={onChunkFail}>
          <Suspense fallback={<p className="tms-map-unavailable tms-muted">Loading map…</p>}>
            <TrackingRouteMap apiKey={apiKey} mapId={mapId} model={model} fitKey={fitKey} recenter={recenter} onAuthFailure={onAuthFailure} />
          </Suspense>
        </ChunkBoundary>
      ) : (
        <FallbackRouteMap model={model} onUnavailable={onUnavailable} />
      )}
      {caption ? <p className="tms-map-caption tms-muted" data-testid="tracking-map-caption">{caption}</p> : null}
    </div>
  )
}
