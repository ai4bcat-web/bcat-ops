/**
 * The Dispatch GPS map: a truck pin for every driver with a fix, blue when on a load and orange
 * when empty. Same projection and data as the dashboard's fleet map (us-atlas states + d3-geo
 * Albers USA): no tiles, no keys, no network beyond the lazy map chunk. Pins keep one size on
 * screen at any zoom or window size; trucks in the same town are fanned out around the spot.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { geoAlbersUsa, geoPath, type GeoProjection } from 'd3-geo'
import { feature } from 'topojson-client'
import type { Topology } from 'topojson-specification'
import type { FeatureCollection } from 'geojson'
import { Plus, Minus, Maximize2 } from 'lucide-react'
import { GPS_COLOR, type GpsDriver } from './gps'

const W = 640
const H = 390
const MIN_K = 1
const MAX_K = 14
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

type XY = [number, number]

export function GpsMap({ drivers, selectedId, onSelect }: {
  drivers: readonly GpsDriver[]
  selectedId: string | null
  onSelect: (driverId: string) => void
}) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [statePaths, setStatePaths] = useState<string[]>([])
  const [projection, setProjection] = useState<GeoProjection | null>(null)
  const [t, setT] = useState({ k: 1, x: 0, y: 0 })
  const [scale, setScale] = useState(1)
  const [dragging, setDragging] = useState(false)
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
      .catch((err) => console.error('[GpsMap] failed to load US map', err))
    return () => { alive = false }
  }, [])

  // Screen pixels per map unit (the map is fitted inside its box), so marks keep a fixed size.
  useEffect(() => {
    const el = svgRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) setScale(Math.min(r.width / W, r.height / H))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const px = (n: number) => n / (t.k * scale)

  const pins = useMemo(() => {
    if (!projection) return []
    return drivers
      .map((d) => {
        if (d.lat == null || d.lng == null) return null
        const xy = projection([d.lng, d.lat])
        return xy ? { d, at: [xy[0], xy[1]] as XY } : null
      })
      .filter((p): p is { d: GpsDriver; at: XY } => p !== null)
  }, [projection, drivers])

  // The point under a pointer, in map units, for zooming toward the cursor.
  const toSvg = (clientX: number, clientY: number) => {
    const r = svgRef.current?.getBoundingClientRect()
    if (!r || scale <= 0) return { x: 0, y: 0 }
    const offX = (r.width - W * scale) / 2
    const offY = (r.height - H * scale) / 2
    return { x: (clientX - r.left - offX) / scale, y: (clientY - r.top - offY) / scale }
  }
  const zoomAt = (factor: number, sx: number, sy: number) => {
    setT((prev) => {
      const k = clamp(prev.k * factor, MIN_K, MAX_K)
      if (k === prev.k) return prev
      const gx = (sx - prev.x) / prev.k
      const gy = (sy - prev.y) / prev.k
      return k === 1 ? { k, x: 0, y: 0 } : { k, x: sx - gx * k, y: sy - gy * k }
    })
  }
  // The page can scroll, so the wheel only zooms with Ctrl or Cmd held.
  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const { x, y } = toSvg(e.clientX, e.clientY)
      zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, x, y)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale])

  const onPointerDown = (e: React.PointerEvent) => {
    if (t.k <= 1 || (e.target as Element).closest('[data-pin]')) return
    drag.current = { x: e.clientX, y: e.clientY }
    setDragging(true)
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current || scale <= 0) return
    const dx = (e.clientX - drag.current.x) / scale
    const dy = (e.clientY - drag.current.y) / scale
    drag.current = { x: e.clientX, y: e.clientY }
    setT((prev) => ({ ...prev, x: prev.x + dx, y: prev.y + dy }))
  }
  const endDrag = () => { drag.current = null; setDragging(false) }

  // Trucks in the same town sit on top of each other: fan them out in screen pixels.
  const fan = useMemo(() => {
    const out = new Map<string, XY>()
    const placed = pins.map((p) => ({ key: p.d.driverId, sx: (p.at[0] * t.k + t.x) * scale, sy: (p.at[1] * t.k + t.y) * scale }))
    const used = new Set<string>()
    for (const a of placed) {
      if (used.has(a.key)) continue
      const group = placed.filter((b) => !used.has(b.key) && Math.hypot(a.sx - b.sx, a.sy - b.sy) < 26)
      group.forEach((g) => used.add(g.key))
      if (group.length < 2) continue
      const r = 15 + group.length * 2.6
      group.forEach((g, i) => {
        const ang = (2 * Math.PI * i) / group.length - Math.PI / 2
        out.set(g.key, [Math.cos(ang) * r, Math.sin(ang) * r])
      })
    }
    return out
  }, [pins, t, scale])

  const ctrlBtn: React.CSSProperties = {
    width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--tms-card)', border: '1px solid var(--tms-border)', borderRadius: 7,
    color: 'var(--tms-text-2)', cursor: 'pointer', padding: 0,
  }
  const ready = statePaths.length > 0
  const ordered = [...pins].sort((a, b) => Number(a.d.driverId === selectedId) - Number(b.d.driverId === selectedId))

  return (
    <div data-testid="gps-map" style={{ position: 'relative', width: '100%', height: '100%', minHeight: 260 }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height="100%"
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
        style={{
          display: 'block', width: '100%', height: '100%',
          background: 'color-mix(in srgb, var(--tms-badge-blue-tint) 60%, var(--tms-card))',
          touchAction: t.k > 1 ? 'none' : 'pan-y',
          cursor: t.k > 1 ? (dragging ? 'grabbing' : 'grab') : 'default',
        }}
        role="img"
        aria-label="Map of where every driver is"
      >
        <style>{`
          .gps-pin{outline:none;cursor:pointer}
          .gps-pin .gps-focus{display:none}
          .gps-pin:focus-visible .gps-focus{display:block}
        `}</style>
        {!ready ? (
          <text x={W / 2} y={H / 2} textAnchor="middle" fontSize={13} fill="var(--tms-muted)">Loading map…</text>
        ) : (
          <g transform={`translate(${t.x} ${t.y}) scale(${t.k})`}>
            {statePaths.map((d, i) => (
              <path key={i} d={d} fill="var(--tms-card)" stroke="var(--tms-border)" strokeWidth={0.8} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
            ))}
            {ordered.filter((p) => fan.has(p.d.driverId)).map(({ d, at }) => {
              const off = fan.get(d.driverId) as XY
              return (
                <g key={`leader-${d.driverId}`} pointerEvents="none">
                  <line x1={at[0]} y1={at[1]} x2={at[0] + px(off[0])} y2={at[1] + px(off[1])} stroke={GPS_COLOR[d.status]} strokeWidth={px(1)} opacity={0.6} />
                  <circle cx={at[0]} cy={at[1]} r={px(2.2)} fill={GPS_COLOR[d.status]} />
                </g>
              )
            })}
            {ordered.map(({ d, at: trueAt }) => {
              const off = fan.get(d.driverId)
              const at: XY = off ? [trueAt[0] + px(off[0]), trueAt[1] + px(off[1])] : trueAt
              const color = GPS_COLOR[d.status]
              const on = d.driverId === selectedId
              const label = `${d.name}${d.truck ? ` · truck ${d.truck}` : ''} · ${d.status === 'LOAD' ? `on a load${d.load ? ` (PRO ${d.load.pro})` : ''}` : 'empty'}${d.place ? ` · ${d.place}` : ''}`
              return (
                <g
                  key={d.driverId}
                  className="gps-pin"
                  data-pin
                  data-testid={`gps-pin-${d.driverId}`}
                  data-status={d.status}
                  transform={`translate(${at[0]} ${at[1]})`}
                  role="button"
                  tabIndex={0}
                  aria-label={label}
                  aria-pressed={on}
                  onClick={(e) => { e.stopPropagation(); onSelect(d.driverId) }}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(d.driverId) } }}
                >
                  <title>{label}</title>
                  {on ? <circle r={px(16)} fill="none" stroke={color} strokeWidth={px(2.2)} /> : null}
                  <circle className="gps-focus" r={px(18)} fill="none" stroke="var(--tms-text)" strokeWidth={px(2)} strokeDasharray={`${px(3)} ${px(2)}`} />
                  <circle r={px(10.5)} fill={color} stroke="var(--tms-card)" strokeWidth={px(1.8)} opacity={d.stale ? 0.5 : 1} />
                  <g transform={`scale(${px(0.54)}) translate(-12 -12)`} fill="none" stroke="var(--tms-card)" strokeWidth={2.3} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none">
                    <path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" />
                    <path d="M15 18H9" />
                    <path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14" />
                    <circle cx="17" cy="18" r="2" />
                    <circle cx="7" cy="18" r="2" />
                  </g>
                </g>
              )
            })}
            {/* A name label under the selected truck. */}
            {ordered.filter((p) => p.d.driverId === selectedId).map(({ d, at: trueAt }) => {
              const off = fan.get(d.driverId)
              const at: XY = off ? [trueAt[0] + px(off[0]), trueAt[1] + px(off[1])] : trueAt
              const text = d.name
              const wpx = text.length * 6 + 16
              return (
                <g key="sel-label" transform={`translate(${at[0]} ${at[1] + px(-27)})`} pointerEvents="none">
                  <rect x={-px(wpx) / 2} y={-px(10)} width={px(wpx)} height={px(20)} rx={px(6)} fill="var(--tms-card)" stroke={GPS_COLOR[d.status]} strokeWidth={px(1.2)} />
                  <text x={0} y={0} textAnchor="middle" dominantBaseline="central" fontSize={px(11)} fontWeight={600} fill="var(--tms-text)">{text}</text>
                </g>
              )
            })}
          </g>
        )}
      </svg>
      {ready ? (
        <div style={{ position: 'absolute', top: 10, right: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <button type="button" onClick={() => zoomAt(1.5, W / 2, H / 2)} style={ctrlBtn} aria-label="Zoom in" title="Zoom in"><Plus size={14} /></button>
          <button type="button" onClick={() => zoomAt(1 / 1.5, W / 2, H / 2)} style={{ ...ctrlBtn, opacity: t.k > 1 ? 1 : 0.5 }} aria-label="Zoom out" title="Zoom out" disabled={t.k <= 1}><Minus size={14} /></button>
          <button type="button" onClick={() => setT({ k: 1, x: 0, y: 0 })} style={{ ...ctrlBtn, opacity: t.k > 1 ? 1 : 0.5 }} aria-label="Reset zoom" title="Reset zoom" disabled={t.k <= 1}><Maximize2 size={13} /></button>
        </div>
      ) : null}
      {ready && pins.length === 0 ? (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, color: 'var(--tms-muted)', pointerEvents: 'none' }}>
          No driver has a GPS fix to show
        </div>
      ) : null}
    </div>
  )
}
