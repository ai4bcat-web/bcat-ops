import { useEffect, useMemo, useState } from 'react'
import { geoAlbersUsa, geoPath, type GeoProjection } from 'd3-geo'
import { feature } from 'topojson-client'
import type { Topology } from 'topojson-specification'
import type { FeatureCollection } from 'geojson'
import type { TruckLocation } from '@/lib/apiClient'

const W = 590, H = 360

const isMoving = (loc: TruckLocation) =>
  (loc.motion ?? '').toLowerCase() === 'driving' || (typeof loc.speed === 'number' && loc.speed > 1)

/**
 * Real US map (Census state boundaries) with each truck's last-known position as a dot.
 * Uses us-atlas TopoJSON + d3-geo's Albers-USA projection — free, no tiles, no API key.
 * The TopoJSON + projection lib are lazy-loaded so they stay out of the main bundle.
 * Green = moving, slate = stopped; rows without coordinates (or outside the US) are skipped.
 */
export function FleetMiniMap({ locations }: { locations: TruckLocation[] }) {
  const [statePaths, setStatePaths] = useState<string[]>([])
  const [projection, setProjection] = useState<GeoProjection | null>(null)

  useEffect(() => {
    let alive = true
    import('us-atlas/states-10m.json')
      .then((mod) => {
        if (!alive) return
        const topo = (mod.default ?? mod) as unknown as Topology
        const fc = feature(topo, topo.objects.states) as unknown as FeatureCollection
        const proj = geoAlbersUsa().fitSize([W, H], fc)
        const path = geoPath(proj)
        setProjection(() => proj)
        setStatePaths(fc.features.map((f) => path(f) ?? '').filter(Boolean))
      })
      .catch((err) => console.error('[FleetMiniMap] failed to load US map', err))
    return () => { alive = false }
  }, [])

  const dots = useMemo(() => {
    if (!projection) return []
    return locations
      .filter((l) => typeof l.lat === 'number' && typeof l.lon === 'number')
      .map((l) => {
        const xy = projection([l.lon as number, l.lat as number])
        return xy ? { id: l.truckId, unit: l.unitNumber, x: xy[0], y: xy[1], moving: isMoving(l) } : null
      })
      .filter((d): d is { id: string; unit: string; x: number; y: number; moving: boolean } => d !== null)
  }, [projection, locations])

  return (
    <div style={{ padding: 12 }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block', borderRadius: 8, background: 'var(--ds-bg)', border: '1px solid var(--ds-border)' }} role="img" aria-label="Fleet map">
        {statePaths.length === 0 ? (
          <text x={W / 2} y={H / 2} textAnchor="middle" fontSize={13} fill="var(--ds-t3)">Loading map…</text>
        ) : (
          <g>
            {statePaths.map((d, i) => (
              <path key={i} d={d} fill="rgba(30,168,243,0.05)" stroke="rgba(30,168,243,0.30)" strokeWidth={0.6} strokeLinejoin="round" />
            ))}
            {dots.map((d) => (
              <g key={d.id} transform={`translate(${d.x} ${d.y})`}>
                <title>{`#${d.unit}${d.moving ? ' · driving' : ' · stopped'}`}</title>
                <circle r={6.5} fill={d.moving ? 'rgba(34,197,94,0.18)' : 'rgba(148,163,184,0.20)'} />
                <circle r={3.5} fill={d.moving ? '#16a34a' : '#64748b'} stroke="#fff" strokeWidth={1} />
              </g>
            ))}
          </g>
        )}
      </svg>
      {projection && dots.length === 0 && (
        <div style={{ fontSize: 11.5, color: 'var(--ds-t3)', textAlign: 'center', marginTop: 6 }}>No GPS coordinates yet</div>
      )}
    </div>
  )
}
