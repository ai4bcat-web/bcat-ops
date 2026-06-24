import { useEffect, useMemo, useRef, useState } from 'react'
import { geoAlbersUsa, geoPath, type GeoProjection } from 'd3-geo'
import { feature } from 'topojson-client'
import type { Topology } from 'topojson-specification'
import type { FeatureCollection } from 'geojson'
import { Plus, Minus, Maximize2 } from 'lucide-react'
import type { TruckLocation } from '@/lib/apiClient'

const W = 590, H = 360
const MIN_K = 1, MAX_K = 14

const isMoving = (loc: TruckLocation) =>
  (loc.motion ?? '').toLowerCase() === 'driving' || (typeof loc.speed === 'number' && loc.speed > 1)

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

/**
 * Real US map (Census state boundaries) with each truck's last-known position as a dot,
 * pan + zoom enabled (scroll / buttons to zoom toward the cursor, drag to pan) so trucks
 * clustered in one city can be separated. us-atlas TopoJSON + d3-geo Albers-USA — free,
 * no tiles, no API key. Map data lazy-loaded as its own chunk.
 */
export function FleetMiniMap({ locations }: { locations: TruckLocation[] }) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [statePaths, setStatePaths] = useState<string[]>([])
  const [projection, setProjection] = useState<GeoProjection | null>(null)
  // View transform on the map group: screen = translate(x,y) · scale(k).
  const [t, setT] = useState({ k: 1, x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number } | null>(null)

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

  // Pointer (client) → SVG viewBox coordinates.
  const toSvg = (clientX: number, clientY: number) => {
    const r = svgRef.current?.getBoundingClientRect()
    if (!r) return { x: 0, y: 0 }
    return { x: ((clientX - r.left) / r.width) * W, y: ((clientY - r.top) / r.height) * H }
  }

  // Zoom by `factor` keeping the point (sx,sy in SVG coords) fixed under the cursor.
  const zoomAt = (factor: number, sx: number, sy: number) => {
    setT((prev) => {
      const k = clamp(prev.k * factor, MIN_K, MAX_K)
      if (k === prev.k) return prev
      // group coord under the cursor stays put: sx = x + gx*k  →  x' = sx - gx*k'
      const gx = (sx - prev.x) / prev.k
      const gy = (sy - prev.y) / prev.k
      let x = sx - gx * k
      let y = sy - gy * k
      if (k === 1) { x = 0; y = 0 }
      return { k, x, y }
    })
  }

  // Non-passive wheel listener so preventDefault stops page scroll while zooming.
  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const { x, y } = toSvg(e.clientX, e.clientY)
      zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, x, y)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const onPointerDown = (e: React.PointerEvent) => {
    if (t.k <= 1) return
    drag.current = { x: e.clientX, y: e.clientY }
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current || !svgRef.current) return
    const r = svgRef.current.getBoundingClientRect()
    const dx = ((e.clientX - drag.current.x) / r.width) * W
    const dy = ((e.clientY - drag.current.y) / r.height) * H
    drag.current = { x: e.clientX, y: e.clientY }
    setT((prev) => ({ ...prev, x: prev.x + dx, y: prev.y + dy }))
  }
  const endDrag = () => { drag.current = null }

  const zoomBtn = (factor: number) => zoomAt(factor, W / 2, H / 2)
  const reset = () => setT({ k: 1, x: 0, y: 0 })

  const ctrlBtn: React.CSSProperties = {
    width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 6,
    color: 'var(--ds-t2)', cursor: 'pointer', padding: 0,
  }
  const k = t.k

  return (
    <div style={{ padding: 12 }}>
      <div style={{ position: 'relative' }}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`} width="100%"
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerLeave={endDrag}
          style={{ display: 'block', borderRadius: 8, background: 'var(--ds-bg)', border: '1px solid var(--ds-border)',
            cursor: k > 1 ? (drag.current ? 'grabbing' : 'grab') : 'default', touchAction: 'none' }}
          role="img" aria-label="Fleet map"
        >
          {statePaths.length === 0 ? (
            <text x={W / 2} y={H / 2} textAnchor="middle" fontSize={13} fill="var(--ds-t3)">Loading map…</text>
          ) : (
            <g transform={`translate(${t.x} ${t.y}) scale(${k})`}>
              {statePaths.map((d, i) => (
                <path key={i} d={d} fill="rgba(30,168,243,0.05)" stroke="rgba(30,168,243,0.30)" strokeWidth={0.6 / k} strokeLinejoin="round" />
              ))}
              {dots.map((d) => (
                <g key={d.id} transform={`translate(${d.x} ${d.y})`}>
                  <title>{`#${d.unit}${d.moving ? ' · driving' : ' · stopped'}`}</title>
                  <circle r={6.5 / k} fill={d.moving ? 'rgba(34,197,94,0.18)' : 'rgba(148,163,184,0.20)'} />
                  <circle r={3.5 / k} fill={d.moving ? '#16a34a' : '#64748b'} stroke="#fff" strokeWidth={1 / k} />
                </g>
              ))}
            </g>
          )}
        </svg>

        {/* Zoom controls */}
        {statePaths.length > 0 && (
          <div style={{ position: 'absolute', top: 8, right: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <button onClick={() => zoomBtn(1.4)} style={ctrlBtn} aria-label="Zoom in" title="Zoom in"><Plus size={14} /></button>
            <button onClick={() => zoomBtn(1 / 1.4)} style={ctrlBtn} aria-label="Zoom out" title="Zoom out" disabled={k <= 1}><Minus size={14} /></button>
            <button onClick={reset} style={{ ...ctrlBtn, opacity: k > 1 ? 1 : 0.5 }} aria-label="Reset zoom" title="Reset" disabled={k <= 1}><Maximize2 size={13} /></button>
          </div>
        )}
      </div>
      {projection && dots.length === 0 ? (
        <div style={{ fontSize: 11.5, color: 'var(--ds-t3)', textAlign: 'center', marginTop: 6 }}>No GPS coordinates yet</div>
      ) : statePaths.length > 0 && (
        <div style={{ fontSize: 11, color: 'var(--ds-t3)', textAlign: 'center', marginTop: 6 }}>Scroll to zoom · drag to pan</div>
      )}
    </div>
  )
}
