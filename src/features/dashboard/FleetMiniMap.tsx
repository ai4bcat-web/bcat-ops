import type { TruckLocation } from '@/lib/apiClient'

// Equirectangular projection of the continental US into a 590×360 box.
const LON_MIN = -125, LON_MAX = -66.5, LAT_MIN = 24, LAT_MAX = 49.5
const W = 590, H = 360
const projX = (lon: number) => ((lon - LON_MIN) / (LON_MAX - LON_MIN)) * W
const projY = (lat: number) => ((LAT_MAX - lat) / (LAT_MAX - LAT_MIN)) * H

// Simplified lower-48 silhouette (rough — a recognizable backdrop, not survey-grade),
// authored directly in the projected box above.
const US_OUTLINE =
  'M 27 27 L 79 237 L 151 257 L 277 333 L 352 292 L 444 303 L 452 335 L 460 300 ' +
  'L 499 196 L 514 124 L 560 96 L 585 64 L 585 18 L 302 9 Z'

const isMoving = (loc: TruckLocation) =>
  (loc.motion ?? '').toLowerCase() === 'driving' || (typeof loc.speed === 'number' && loc.speed > 1)

/**
 * Tiny US map plotting each truck's last-known position as a dot. Green = moving,
 * slate = stopped. Rows without coordinates are skipped.
 */
export function FleetMiniMap({ locations }: { locations: TruckLocation[] }) {
  const pts = locations.filter((l) => typeof l.lat === 'number' && typeof l.lon === 'number')

  return (
    <div style={{ padding: 12 }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block', borderRadius: 8, background: 'var(--ds-bg)', border: '1px solid var(--ds-border)' }} role="img" aria-label="Fleet map">
        {/* graticule */}
        <g stroke="rgba(15,23,42,0.05)" strokeWidth={1}>
          {[0.25, 0.5, 0.75].map((f) => <line key={`h${f}`} x1={0} y1={H * f} x2={W} y2={H * f} />)}
          {[0.2, 0.4, 0.6, 0.8].map((f) => <line key={`v${f}`} x1={W * f} y1={0} x2={W * f} y2={H} />)}
        </g>
        {/* US outline */}
        <path d={US_OUTLINE} fill="rgba(30,168,243,0.05)" stroke="rgba(30,168,243,0.35)" strokeWidth={1.5} strokeLinejoin="round" />
        {/* truck dots */}
        {pts.map((l) => {
          const x = Math.max(4, Math.min(W - 4, projX(l.lon!)))
          const y = Math.max(4, Math.min(H - 4, projY(l.lat!)))
          const moving = isMoving(l)
          return (
            <g key={l.truckId} transform={`translate(${x} ${y})`}>
              <title>{`#${l.unitNumber}${moving ? ' · driving' : ' · stopped'}`}</title>
              <circle r={6.5} fill={moving ? 'rgba(34,197,94,0.18)' : 'rgba(148,163,184,0.18)'} />
              <circle r={3.5} fill={moving ? '#16a34a' : '#64748b'} stroke="#fff" strokeWidth={1} />
            </g>
          )
        })}
      </svg>
      {pts.length === 0 && (
        <div style={{ fontSize: 11.5, color: 'var(--ds-t3)', textAlign: 'center', marginTop: 6 }}>No GPS coordinates yet</div>
      )}
    </div>
  )
}
