import { useId } from 'react'

export interface TrendPoint { month: string; label: string; value: number; /** The month still in progress: drawn dashed with an open dot. */ partial?: boolean }

const W = 220
const H = 40
const PAD_X = 6
const PAD_Y = 6

/**
 * A month-over-month line for a KPI card: solid through finished months, dashed into the month in progress, an open
 * dot on that last point so a half-finished month is never read as a collapse. Hover a dot for the month and figure.
 * Draws nothing with fewer than two months.
 */
export function Sparkline({ points, format, color = 'var(--tms-chart-1)', label }: {
  points: TrendPoint[]
  format: (v: number) => string
  color?: string
  label: string
}) {
  const gradId = useId().replace(/:/g, '')
  if (points.length < 2) return null
  const values = points.map((p) => p.value)
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const span = hi - lo || 1
  const x = (i: number) => PAD_X + (i * (W - PAD_X * 2)) / (points.length - 1)
  const y = (v: number) => H - PAD_Y - ((v - lo) / span) * (H - PAD_Y * 2)
  const xy = points.map((p, i) => [x(i), y(p.value)] as const)
  const last = points.length - 1
  const lastPartial = !!points[last].partial
  // Solid up to the last finished month, dashed from there into the month in progress.
  const solidEnd = lastPartial ? last - 1 : last
  const solid = xy.slice(0, solidEnd + 1).map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px.toFixed(1)} ${py.toFixed(1)}`).join(' ')
  const dashed = lastPartial ? `M${xy[last - 1][0].toFixed(1)} ${xy[last - 1][1].toFixed(1)} L${xy[last][0].toFixed(1)} ${xy[last][1].toFixed(1)}` : ''
  const area = `${solid} L${xy[solidEnd][0].toFixed(1)} ${H - PAD_Y} L${xy[0][0].toFixed(1)} ${H - PAD_Y} Z`

  return (
    <div data-testid="kpi-sparkline">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label}, month over month: ${points.map((p) => `${p.label} ${format(p.value)}${p.partial ? ' (to date)' : ''}`).join(', ')}`} style={{ display: 'block', width: '100%', height: 'auto', overflow: 'visible' }}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.22} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        {solidEnd >= 1 && <path d={area} fill={`url(#${gradId})`} stroke="none" />}
        <path d={solid} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        {dashed && <path data-testid="kpi-sparkline-partial" d={dashed} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeDasharray="3 4" />}
        {xy.map(([px, py], i) => {
          const p = points[i]
          const isLast = i === last
          return (
            <circle key={p.month} cx={px} cy={py} r={isLast ? 4 : 2.5} fill={isLast && p.partial ? 'var(--tms-card)' : color} stroke={color} strokeWidth={isLast ? 2 : 0}>
              <title>{`${p.label}: ${format(p.value)}${p.partial ? ' so far (month in progress)' : ''}`}</title>
            </circle>
          )
        })}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: 'var(--tms-muted)', marginTop: 1 }}>
        <span>{points[0].label}</span>
        <span>{points[last].label}{lastPartial ? ' · so far' : ''}</span>
      </div>
    </div>
  )
}
