/**
 * The Empty trucks map (Ryne 2026-11-18): the US with a truck pin for every truck going empty,
 * coloured by how soon, numbered like the ranked cards beside it. A thin line is the run the
 * truck just did (first stop to where it is empty); a dashed line is the empty run to the best
 * open load, green when short, amber when longer, red past 150 miles. The faint diamonds are
 * open loads nobody has. Clicking a pin or a card selects the truck and brightens its lines.
 *
 * Same data and projection as the dashboard's fleet map (us-atlas states + d3-geo Albers USA):
 * no tiles, no keys, no network beyond the lazy map chunk. Sizes are in screen pixels whatever
 * the zoom or the width, so pins stay the same size on a phone and on a wide screen.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { geoAlbersUsa, geoPath, type GeoProjection } from 'd3-geo'
import { feature } from 'topojson-client'
import type { Topology } from 'topojson-specification'
import type { FeatureCollection } from 'geojson'
import { Plus, Minus, Maximize2 } from 'lucide-react'
import { deadheadTier, urgencyOf, type EmptyOpenLoad, type EmptyPoint, type EmptyTruckRow } from './emptyTrucks'
import { TIER_COLOR, URGENCY_COLOR, URGENCY_LABEL, whenText } from './emptyTrucksStyle'

const W = 640
const H = 390
const MIN_K = 1
const MAX_K = 12

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

type XY = [number, number]

/** A gentle arc between two points, with its midpoint for a label. */
function arc(a: XY, b: XY, bend = 0.16): { d: string; mid: XY } {
  const mx = (a[0] + b[0]) / 2
  const my = (a[1] + b[1]) / 2
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const cx = mx - dy * bend
  const cy = my + dx * bend
  return { d: `M${a[0].toFixed(1)} ${a[1].toFixed(1)} Q${cx.toFixed(1)} ${cy.toFixed(1)} ${b[0].toFixed(1)} ${b[1].toFixed(1)}`, mid: [(a[0] + 2 * cx + b[0]) / 4, (a[1] + 2 * cy + b[1]) / 4] }
}

const hasXY = (p: Pick<EmptyPoint, 'lat' | 'lng'>) => p.lat != null && p.lng != null

export function EmptyTrucksMap({ rows, openLoads, now, selectedKey, onSelect }: {
  /** The trucks shown, in rank order: pin number = position + 1. */
  rows: readonly EmptyTruckRow[]
  openLoads: readonly EmptyOpenLoad[]
  now: number
  selectedKey: string | null
  onSelect: (key: string) => void
}) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [statePaths, setStatePaths] = useState<string[]>([])
  const [projection, setProjection] = useState<GeoProjection | null>(null)
  const [t, setT] = useState({ k: 1, x: 0, y: 0 })
  const [scale, setScale] = useState(1)
  const [dragging, setDragging] = useState(false)
  const [hoverKey, setHoverKey] = useState<string | null>(null)
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
      .catch((err) => console.error('[EmptyTrucksMap] failed to load US map', err))
    return () => { alive = false }
  }, [])

  // How many screen pixels one map unit is: lets every mark keep a fixed size on screen.
  useEffect(() => {
    const el = svgRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      const w = el.getBoundingClientRect().width
      if (w > 0) setScale(w / W)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const px = (n: number) => n / (t.k * scale)

  const matchedIds = useMemo(() => new Set(rows.flatMap((r) => r.matches.map((m) => m.loadId))), [rows])

  // Everything drawn, projected once.
  const marks = useMemo(() => {
    if (!projection) return { pins: [], runs: [], matchLines: [], open: [] }
    const proj = (p: Pick<EmptyPoint, 'lat' | 'lng'>): XY | null => {
      if (!hasXY(p)) return null
      const xy = projection([p.lng as number, p.lat as number])
      return xy ? [xy[0], xy[1]] : null
    }
    const pins: { row: EmptyTruckRow; rank: number; at: XY; urgency: ReturnType<typeof urgencyOf> }[] = []
    const runs: { row: EmptyTruckRow; d: string }[] = []
    const matchLines: { row: EmptyTruckRow; rank: number; d: string; mid: XY; miles: number | null; pro: string; to: XY; approx: boolean }[] = []
    rows.forEach((row, i) => {
      const at = proj(row.point)
      if (!at) return
      pins.push({ row, rank: i + 1, at, urgency: urgencyOf(row, now) })
      const from = proj(row.from)
      if (from && Math.hypot(from[0] - at[0], from[1] - at[1]) > 3) runs.push({ row, d: arc(from, at, 0.1).d })
      const best = row.kind === 'IDLE' ? row.matches[0] : undefined
      const to = best ? proj(best.pickupPoint) : null
      if (best && to && Math.hypot(to[0] - at[0], to[1] - at[1]) > 1) {
        const a = arc(at, to, 0.18)
        matchLines.push({ row, rank: i + 1, d: a.d, mid: a.mid, miles: best.deadheadMiles, pro: best.pro, to, approx: best.approx })
      }
    })
    const open = openLoads
      .map((o) => ({ o, at: proj(o.point) }))
      .filter((x): x is { o: EmptyOpenLoad; at: XY } => x.at !== null)
    return { pins, runs, matchLines, open }
  }, [projection, rows, openLoads, now])

  // Pointer (client) to SVG coordinates.
  const toSvg = (clientX: number, clientY: number) => {
    const r = svgRef.current?.getBoundingClientRect()
    if (!r) return { x: 0, y: 0 }
    return { x: ((clientX - r.left) / r.width) * W, y: ((clientY - r.top) / r.height) * H }
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
  // The page scrolls, so the wheel only zooms with Ctrl or Cmd held.
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
  }, [])

  const onPointerDown = (e: React.PointerEvent) => {
    if (t.k <= 1 || (e.target as Element).closest('[data-pin]')) return
    drag.current = { x: e.clientX, y: e.clientY }
    setDragging(true)
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current || !svgRef.current) return
    const r = svgRef.current.getBoundingClientRect()
    const dx = ((e.clientX - drag.current.x) / r.width) * W
    const dy = ((e.clientY - drag.current.y) / r.height) * H
    drag.current = { x: e.clientX, y: e.clientY }
    setT((prev) => ({ ...prev, x: prev.x + dx, y: prev.y + dy }))
  }
  const endDrag = () => { drag.current = null; setDragging(false) }

  // Trucks in the same town would sit on top of each other: fan them out around the spot in screen pixels.
  const fan = useMemo(() => {
    const out = new Map<string, XY>()
    const placed = marks.pins.map((p) => ({ key: p.row.key, sx: (p.at[0] * t.k + t.x) * scale, sy: (p.at[1] * t.k + t.y) * scale }))
    const used = new Set<string>()
    for (const a of placed) {
      if (used.has(a.key)) continue
      const group = placed.filter((b) => !used.has(b.key) && Math.hypot(a.sx - b.sx, a.sy - b.sy) < 30)
      group.forEach((g) => used.add(g.key))
      if (group.length < 2) continue
      const r = 17 + group.length * 2.6
      group.forEach((g, i) => {
        const ang = (2 * Math.PI * i) / group.length - Math.PI / 2
        out.set(g.key, [Math.cos(ang) * r, Math.sin(ang) * r])
      })
    }
    return out
  }, [marks.pins, t, scale])

  const ctrlBtn: React.CSSProperties = {
    width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--tms-card)', border: '1px solid var(--tms-border)', borderRadius: 7,
    color: 'var(--tms-text-2)', cursor: 'pointer', padding: 0,
  }
  const ready = statePaths.length > 0
  const sel = selectedKey
  const ordered = [...marks.pins].sort((a, b) => Number(a.row.key === sel) - Number(b.row.key === sel))
  const selPin = marks.pins.find((p) => p.row.key === sel) ?? null
  const hoverLine = hoverKey ? marks.matchLines.find((l) => l.row.key === hoverKey) ?? null : null
  const nothing = ready && marks.pins.length === 0

  // Where a label bubble sits relative to its anchor so it stays on the map.
  const anchorSide = (xy: XY): 'start' | 'end' | 'middle' => {
    const sx = (xy[0] * t.k + t.x) / W
    return sx < 0.22 ? 'start' : sx > 0.78 ? 'end' : 'middle'
  }
  const bubble = (xy: XY, text: string, dy: number, color: string) => {
    const side = anchorSide(xy)
    const wpx = text.length * 5.6 + 14
    const left = side === 'start' ? -px(8) : side === 'end' ? -px(wpx) + px(8) : -px(wpx) / 2
    return (
      <g transform={`translate(${xy[0]} ${xy[1] + px(dy)})`} pointerEvents="none">
        <rect x={left} y={-px(10)} width={px(wpx)} height={px(20)} rx={px(6)} fill="var(--tms-card)" stroke={color} strokeWidth={px(1.2)} opacity={0.97} />
        <text x={left + px(wpx) / 2} y={0} textAnchor="middle" dominantBaseline="central" fontSize={px(10.5)} fontWeight={600} fill="var(--tms-text)">{text}</text>
      </g>
    )
  }

  return (
    <div data-testid="empty-trucks-map" style={{ position: 'relative' }}>
      <style>{`
        .et-pulse{transform-box:fill-box;transform-origin:center;animation:et-pulse 2.2s ease-out infinite}
        @keyframes et-pulse{0%{transform:scale(.7);opacity:.55}100%{transform:scale(2.1);opacity:0}}
        @media (prefers-reduced-motion: reduce){.et-pulse{animation:none;opacity:.22;transform:scale(1.5)}}
        .et-pin{outline:none;cursor:pointer}
        .et-pin .et-focus{display:none}
        .et-pin:focus-visible .et-focus{display:block}
      `}</style>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
        style={{
          display: 'block', width: '100%', aspectRatio: `${W} / ${H}`, borderRadius: 12,
          background: 'color-mix(in srgb, var(--tms-badge-blue-tint) 60%, var(--tms-card))',
          border: '1px solid var(--tms-border)', touchAction: t.k > 1 ? 'none' : 'pan-y',
          cursor: t.k > 1 ? (dragging ? 'grabbing' : 'grab') : 'default',
        }}
        role="img"
        aria-label="Map of the trucks going empty"
      >
        {!ready ? (
          <text x={W / 2} y={H / 2} textAnchor="middle" fontSize={13} fill="var(--tms-muted)">Loading map…</text>
        ) : (
          <g transform={`translate(${t.x} ${t.y}) scale(${t.k})`}>
            {statePaths.map((d, i) => (
              <path key={i} d={d} fill="var(--tms-card)" stroke="var(--tms-border)" strokeWidth={0.8} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
            ))}

            {/* Open loads nobody has: faint diamonds; green ring when a truck is matched to one. */}
            {marks.open.map(({ o, at }) => {
              const matched = matchedIds.has(o.loadId)
              return (
                <g key={o.loadId} transform={`translate(${at[0]} ${at[1]}) rotate(45)`}>
                  <title>{`Open load PRO ${o.pro} · ${o.point.place ?? 'unplaced'} · picks up ${whenText(o.pickupAt, o.pickupTimeKnown)}`}</title>
                  <rect x={-px(3.4)} y={-px(3.4)} width={px(6.8)} height={px(6.8)} fill="var(--tms-muted)" opacity={matched ? 0.85 : 0.4}
                    stroke={matched ? 'var(--tms-badge-green)' : 'none'} strokeWidth={px(1.6)} />
                </g>
              )
            })}

            {/* The run each truck just did, thin and quiet; the selected truck's is bright. */}
            {marks.runs.map(({ row, d }) => {
              const on = row.key === sel || row.key === hoverKey
              return (
                <path key={`run-${row.key}`} d={d} fill="none" stroke={URGENCY_COLOR[urgencyOf(row, now)]} strokeWidth={on ? 2.2 : 1}
                  opacity={on ? 0.85 : 0.28} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              )
            })}

            {/* The empty run to the best open load: dashed, coloured by how far. */}
            {marks.matchLines.map((l) => {
              const on = l.row.key === sel || l.row.key === hoverKey
              const tier = deadheadTier(l.miles)
              return (
                <path key={`m-${l.row.key}`} d={l.d} fill="none" stroke={TIER_COLOR[tier]} strokeWidth={on ? 2.4 : 1.3}
                  strokeDasharray={on ? '6 4' : '4 4'} opacity={on ? 0.95 : 0.5} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              )
            })}

            {/* Pins: the selected truck last, so it sits on top. */}
            {/* Trucks fanned out of a crowded town keep a hairline to the real spot. */}
            {ordered.filter((p) => fan.has(p.row.key)).map(({ row, at, urgency }) => {
              const off = fan.get(row.key) as XY
              return (
                <g key={`leader-${row.key}`} pointerEvents="none">
                  <line x1={at[0]} y1={at[1]} x2={at[0] + px(off[0])} y2={at[1] + px(off[1])} stroke={URGENCY_COLOR[urgency]} strokeWidth={px(1)} opacity={0.6} />
                  <circle cx={at[0]} cy={at[1]} r={px(2.2)} fill={URGENCY_COLOR[urgency]} />
                </g>
              )
            })}
            {ordered.map(({ row, rank, at: trueAt, urgency }) => {
              const off = fan.get(row.key)
              const at: XY = off ? [trueAt[0] + px(off[0]), trueAt[1] + px(off[1])] : trueAt
              const color = URGENCY_COLOR[urgency]
              const on = row.key === sel
              const place = row.point.place ?? 'unknown place'
              const label = `${rank}. ${row.driverName}${row.truck ? ` · truck ${row.truck}` : ''} · ${place} · ${whenText(row.emptyAt, row.timeKnown)} · ${URGENCY_LABEL[urgency]}${row.point.approx ? ' (placed at the middle of its state)' : ''}`
              return (
                <g
                  key={row.key}
                  className="et-pin"
                  data-pin
                  data-testid={`map-pin-${row.key}`}
                  transform={`translate(${at[0]} ${at[1]})`}
                  role="button"
                  tabIndex={0}
                  aria-label={label}
                  aria-pressed={on}
                  onClick={(e) => { e.stopPropagation(); onSelect(row.key) }}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(row.key) } }}
                  onMouseEnter={() => setHoverKey(row.key)}
                  onMouseLeave={() => setHoverKey(null)}
                >
                  <title>{label}</title>
                  {urgency === 'now' ? <circle className="et-pulse" r={px(11)} fill={color} /> : null}
                  {on ? <circle r={px(16)} fill="none" stroke={color} strokeWidth={px(2)} /> : null}
                  <circle className="et-focus" r={px(18)} fill="none" stroke="var(--tms-primary)" strokeWidth={px(2)} strokeDasharray={`${px(3)} ${px(2)}`} />
                  <circle r={px(10.5)} fill={color} stroke="var(--tms-card)" strokeWidth={px(1.8)} opacity={row.point.approx ? 0.6 : 1} />
                  {/* The truck glyph (lucide Truck), drawn at 13 px. */}
                  <g transform={`scale(${px(0.54)}) translate(-12 -12)`} fill="none" stroke="var(--tms-card)" strokeWidth={2.3} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none">
                    <path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" />
                    <path d="M15 18H9" />
                    <path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14" />
                    <circle cx="17" cy="18" r="2" />
                    <circle cx="7" cy="18" r="2" />
                  </g>
                  <g pointerEvents="none">
                    <circle cx={px(9)} cy={px(-9)} r={px(6.4)} fill="var(--tms-card)" stroke={color} strokeWidth={px(1.3)} />
                    <text x={px(9)} y={px(-9)} textAnchor="middle" dominantBaseline="central" fontSize={px(rank > 9 ? 7.4 : 8.6)} fontWeight={800} fill="var(--tms-text)">{rank}</text>
                  </g>
                </g>
              )
            })}

            {/* A label for the selected truck, and the empty run's miles for the truck under the pointer. */}
            {selPin ? bubble(fan.has(selPin.row.key) ? [selPin.at[0] + px((fan.get(selPin.row.key) as XY)[0]), selPin.at[1] + px((fan.get(selPin.row.key) as XY)[1])] : selPin.at, `${selPin.row.driverName} · ${selPin.row.point.place ?? 'unknown place'}`, -30, URGENCY_COLOR[selPin.urgency]) : null}
            {hoverLine ? bubble(hoverLine.mid, `${hoverLine.approx ? '≈ ' : ''}${hoverLine.miles ?? '?'} mi empty · PRO ${hoverLine.pro}`, 0, TIER_COLOR[deadheadTier(hoverLine.miles)]) : null}
          </g>
        )}
      </svg>

      {ready ? (
        <div style={{ position: 'absolute', top: 8, right: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <button type="button" onClick={() => zoomAt(1.5, W / 2, H / 2)} style={ctrlBtn} aria-label="Zoom in" title="Zoom in"><Plus size={14} /></button>
          <button type="button" onClick={() => zoomAt(1 / 1.5, W / 2, H / 2)} style={{ ...ctrlBtn, opacity: t.k > 1 ? 1 : 0.5 }} aria-label="Zoom out" title="Zoom out" disabled={t.k <= 1}><Minus size={14} /></button>
          <button type="button" onClick={() => setT({ k: 1, x: 0, y: 0 })} style={{ ...ctrlBtn, opacity: t.k > 1 ? 1 : 0.5 }} aria-label="Reset zoom" title="Reset zoom" disabled={t.k <= 1}><Maximize2 size={13} /></button>
        </div>
      ) : null}
      {nothing ? (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, color: 'var(--tms-muted)', pointerEvents: 'none' }}>
          Nothing to plot yet
        </div>
      ) : null}
    </div>
  )
}

/** What the colours and lines on the map mean. */
export function EmptyTrucksLegend({ hasOpenLoads }: { hasOpenLoads: boolean }) {
  const dot = (color: string, text: string) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: '50%', background: color, display: 'inline-block' }} />{text}
    </span>
  )
  const line = (color: string, dashed: boolean, text: string) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <svg width="22" height="6" aria-hidden="true"><line x1="1" y1="3" x2="21" y2="3" stroke={color} strokeWidth="2" strokeDasharray={dashed ? '5 3' : undefined} strokeLinecap="round" /></svg>{text}
    </span>
  )
  return (
    <div data-testid="empty-trucks-legend" style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', fontSize: 11.5, color: 'var(--tms-muted)', padding: '8px 2px 0' }}>
      {dot(URGENCY_COLOR.now, 'Empty now')}
      {dot(URGENCY_COLOR.soon, 'Within a day')}
      {dot(URGENCY_COLOR.week, 'This week')}
      {dot(URGENCY_COLOR.beyond, 'Later')}
      <span aria-hidden="true" style={{ color: 'var(--tms-border)' }}>|</span>
      {line('var(--tms-text-2)', false, 'Run just done')}
      {line(TIER_COLOR.short, true, 'Empty run up to 75 mi')}
      {line(TIER_COLOR.medium, true, 'Up to 150 mi')}
      {line(TIER_COLOR.long, true, 'Over 150 mi')}
      {hasOpenLoads ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <svg width="10" height="10" aria-hidden="true"><rect x="2" y="2" width="6" height="6" transform="rotate(45 5 5)" fill="var(--tms-muted)" opacity="0.55" /></svg>Open load
        </span>
      ) : null}
      <span style={{ marginLeft: 'auto' }}>Drag to pan · Ctrl or Cmd + scroll to zoom</span>
    </div>
  )
}
