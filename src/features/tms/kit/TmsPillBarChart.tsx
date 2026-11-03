import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

export interface PillBarSeries { key: string; label: string }
export interface PillBarDatum { label: string; values: Record<string, number> }

export interface TmsPillBarChartProps {
  /** Oldest to newest. */
  data: PillBarDatum[]
  /** Colour = `--tms-chart-{index+1}`. */
  series: PillBarSeries[]
  /** Tooltip, axis ticks and the sr-only table. */
  format?: (value: number) => string
  height?: number
  /** That bar at full strength, the rest dimmed. */
  highlightIndex?: number | null
  ariaLabel: string
  /** Shown when the data is empty or every value is 0. */
  emptyText?: string
  className?: string
}

interface TooltipEntry { name?: string | number; value?: number | string; color?: string }

function Tip({ active, payload, label, format }: {
  active?: boolean
  payload?: TooltipEntry[]
  label?: string | number
  format: (v: number) => string
}) {
  if (!active || !payload?.length) return null
  return (
    <div className="tms-chart-tip">
      <div className="tms-chart-tip-label">{String(label ?? '')}</div>
      {payload.map((entry, i) => (
        <div key={`${String(entry.name)}-${i}`} className="tms-chart-tip-row">
          <span className="tms-chart-tip-dot" style={{ background: entry.color }} />
          <span>{String(entry.name ?? '')}</span>
          <strong>{format(Number(entry.value ?? 0))}</strong>
        </div>
      ))}
    </div>
  )
}

interface ShapeProps { x?: number; y?: number; width?: number; height?: number; fill?: string; index?: number; payload?: Record<string, unknown> }

/** Weekly stacked "pill" bars; the top-most non-zero segment of each stack is rounded. */
export function TmsPillBarChart({
  data, series, format = String, height = 260, highlightIndex = null, ariaLabel, emptyText = 'No data for this period.', className,
}: TmsPillBarChartProps) {
  const empty = data.length === 0 || data.every((d) => series.every((s) => !(d.values[s.key] > 0)))
  const rows = data.map((d) => ({ label: d.label, ...d.values }))

  const shapeFor = (seriesIndex: number) => function PillShape(props: ShapeProps) {
    const { x = 0, y = 0, width = 0, height: h = 0, fill, index = 0, payload } = props
    if (!(h > 0)) return <g />
    const isTop = series.slice(seriesIndex + 1).every((s) => !(Number(payload?.[s.key]) > 0))
    const r = isTop ? Math.min(width / 2, h) : 0
    const opacity = highlightIndex == null || index === highlightIndex ? 1 : 0.45
    const path = isTop
      ? `M${x},${y + h} L${x},${y + r} A${r},${r} 0 0 1 ${x + r},${y} L${x + width - r},${y} A${r},${r} 0 0 1 ${x + width},${y + r} L${x + width},${y + h} Z`
      : `M${x},${y} h${width} v${h} h${-width} Z`
    return <path d={path} fill={fill} opacity={opacity} />
  }

  return (
    <div className={`tms-pillbar${className ? ` ${className}` : ''}`}>
      {empty ? (
        <div className="tms-pillbar-empty" style={{ height }}>{emptyText}</div>
      ) : (
        <div aria-hidden="true" style={{ height }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--tms-chart-grid)" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: 'var(--tms-chart-axis)', fontSize: 12 }} />
              <YAxis tickLine={false} axisLine={false} width={48} tickFormatter={(v: number) => format(v)} tick={{ fill: 'var(--tms-chart-axis)', fontSize: 12 }} />
              <Tooltip cursor={false} content={<Tip format={format} />} />
              {series.map((s, i) => (
                <Bar
                  key={s.key}
                  dataKey={s.key}
                  name={s.label}
                  stackId="pill"
                  fill={`var(--tms-chart-${i + 1})`}
                  maxBarSize={28}
                  shape={shapeFor(i)}
                  isAnimationActive={false}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      <table className="tms-sr-only">
        <caption>{ariaLabel}</caption>
        <thead>
          <tr>
            <th scope="col">Period</th>
            {series.map((s) => <th key={s.key} scope="col">{s.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {data.map((d, i) => (
            <tr key={`${d.label}-${i}`}>
              <th scope="row">{d.label}</th>
              {series.map((s) => <td key={s.key}>{format(d.values[s.key] ?? 0)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default TmsPillBarChart
