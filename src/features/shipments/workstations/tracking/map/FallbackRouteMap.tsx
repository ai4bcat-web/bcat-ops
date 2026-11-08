/**
 * The offline route map: Census state outlines (us-atlas TopoJSON + d3-geo Albers-USA, the
 * same free pattern as the fleet board map) with the pins, the route, the breadcrumb dots, the
 * current marker and the approximate-fix circle drawn on top. Used with no Google key, when
 * Google rejects the key, or when the Google chunk fails to load.
 *
 * If the outline data itself cannot be loaded the panel degrades once more to plain text
 * (`tracking-map-unavailable`) — the position is still readable, nothing else is lost.
 */
import { useEffect, useMemo, useState } from 'react'
import { geoAlbersUsa, geoPath, type GeoProjection } from 'd3-geo'
import { feature } from 'topojson-client'
import type { Topology } from 'topojson-specification'
import type { FeatureCollection } from 'geojson'
import { useTmsTokens } from '@/features/tms/tmsTokens'
import { MAP_TOKENS, toneColour } from './mapTokens'
import type { MapModel } from './mapModel'

const W = 590
const H = 300
const PAD = 28
/** Metres per degree of latitude: converts the approximate-fix radius to a pixel radius. */
const M_PER_DEG = 111_320

function pointFeature(p: { lat: number; lng: number }) {
  return { type: 'Feature' as const, properties: {}, geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] } }
}

export function FallbackRouteMap({ model, onUnavailable }: { model: MapModel; onUnavailable?: () => void }) {
  const tk = useTmsTokens(MAP_TOKENS)
  const [states, setStates] = useState<FeatureCollection | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    import('us-atlas/states-10m.json')
      .then((mod) => {
        if (!alive) return
        const topo = (mod.default ?? mod) as unknown as Topology
        setStates(feature(topo, topo.objects.states) as unknown as FeatureCollection)
      })
      .catch(() => { if (alive) { setFailed(true); onUnavailable?.() } })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once; `onUnavailable` is a stable setter
  }, [])

  const { bounds } = model
  const projection = useMemo<GeoProjection | null>(() => {
    if (!states) return null
    if (bounds && (bounds.south !== bounds.north || bounds.west !== bounds.east)) {
      const frame = {
        type: 'FeatureCollection' as const,
        features: [pointFeature({ lat: bounds.south, lng: bounds.west }), pointFeature({ lat: bounds.north, lng: bounds.east })],
      }
      return geoAlbersUsa().fitExtent([[PAD, PAD], [W - PAD, H - PAD]], frame)
    }
    return geoAlbersUsa().fitSize([W, H], states)
  }, [states, bounds])

  const paths = useMemo(() => {
    if (!states || !projection) return []
    const path = geoPath(projection)
    return states.features.map((f) => path(f) ?? '').filter(Boolean)
  }, [states, projection])

  if (failed) {
    return (
      <p className="tms-map-unavailable tms-muted" data-testid="tracking-map-unavailable">
        Map unavailable{model.current ? ` — ${model.current.title}` : ''}
      </p>
    )
  }

  const xy = (p: { lat: number; lng: number }): [number, number] | null => projection?.([p.lng, p.lat]) ?? null
  const routeXY = model.path.map(xy)
  // Projection drops points outside the US; the visible segments stay as separate runs.
  const route = routeXY.filter((p): p is [number, number] => p != null).map((p) => p.join(',')).join(' ')
  const currentXY = model.current ? xy(model.current) : null
  const circleXY = model.approxCircle ? xy(model.approxCircle) : null
  const pxPerMetre = projection && model.approxCircle
    ? (() => {
        const a = xy(model.approxCircle)
        const b = xy({ lat: model.approxCircle.lat + 1, lng: model.approxCircle.lng })
        return a && b ? Math.abs(b[1] - a[1]) / M_PER_DEG : 0
      })()
    : 0

  return (
    <div className="tms-map-fallback" data-testid="tracking-map-fallback">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" role="img" aria-label="Route map" className="tms-map-svg" style={{ background: tk['--tms-surface'] }}>
        {paths.length === 0 ? (
          <text x={W / 2} y={H / 2} textAnchor="middle" fontSize={13} fill={tk['--tms-muted']}>Loading map…</text>
        ) : (
          <g>
            {paths.map((d, i) => (
              <path key={i} d={d} fill={tk['--tms-card']} stroke={tk['--tms-badge-blue-tint']} strokeWidth={0.8} strokeLinejoin="round" />
            ))}
            {route && model.pathStyle !== 'none' && (
              <polyline
                data-testid="tracking-map-route" points={route} fill="none" stroke={tk['--tms-primary']} strokeWidth={2}
                strokeOpacity={0.85} strokeDasharray={model.pathStyle === 'dashed' ? '6 4' : undefined} strokeLinejoin="round"
              />
            )}
            {model.dots.map((dot) => {
              const p = xy(dot)
              if (!p) return null
              return (
                <g key={dot.at} transform={`translate(${p[0]} ${p[1]})`} data-testid="tracking-map-dot">
                  {dot.title ? <title>{dot.title}</title> : null}
                  <circle r={2.4} fill={tk['--tms-badge-blue']} fillOpacity={dot.approx ? 0.4 : 0.9} />
                  {dot.label ? <text x={4} y={-4} fontSize={8} fill={tk['--tms-muted']}>{dot.label}</text> : null}
                </g>
              )
            })}
            {model.pins.map((pin, i) => {
              const p = xy(pin)
              if (!p) return null
              const colour = pin.type === 'pickup' ? tk['--tms-badge-green'] : pin.type === 'delivery' ? tk['--tms-badge-blue'] : tk['--tms-muted']
              return (
                <g key={`${pin.type}-${i}`} transform={`translate(${p[0]} ${p[1]})`} data-testid={`tracking-map-pin-${pin.type}`}>
                  <title>{pin.title}</title>
                  <circle r={pin.type === 'stop' ? 3.5 : 7} fill={colour} stroke={tk['--tms-card']} strokeWidth={1.2} />
                  {pin.glyph ? <text y={3} textAnchor="middle" fontSize={9} fontWeight={700} fill={tk['--tms-card']}>{pin.glyph}</text> : null}
                </g>
              )
            })}
            {model.approxCircle && circleXY && (
              <g transform={`translate(${circleXY[0]} ${circleXY[1]})`} data-testid="tracking-map-approx">
                <title>{model.approxCircle.title}</title>
                <circle r={Math.max(8, model.approxCircle.radiusM * pxPerMetre)} fill={tk['--tms-badge-orange']} fillOpacity={0.15} stroke={tk['--tms-badge-orange']} strokeDasharray="4 3" strokeWidth={1.2} />
              </g>
            )}
            {model.current && currentXY && (
              <g transform={`translate(${currentXY[0]} ${currentXY[1]})`} data-testid="tracking-map-current-marker">
                <title>{model.current.title}</title>
                {model.current.haloM ? <circle r={Math.max(10, model.current.haloM * pxPerMetre)} fill={toneColour(model.current.tone, tk)} fillOpacity={0.15} /> : null}
                <circle r={9} fill={toneColour(model.current.tone, tk)} fillOpacity={0.25} />
                <circle r={5.5} fill={toneColour(model.current.tone, tk)} stroke={tk['--tms-card']} strokeWidth={1.4} />
                {model.current.warn ? <text y={-11} textAnchor="middle" fontSize={11} fill={tk['--tms-badge-red']}>!</text> : null}
              </g>
            )}
          </g>
        )}
      </svg>
    </div>
  )
}
