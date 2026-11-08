/**
 * One dashboard card: the chart, its numbers table, its group-by override and the
 * expanded view. The card draws the series the page computed — including the card's
 * `note` and its real zero — and never invents a number of its own.
 */
import { useState } from 'react'
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { BarChart3, Gauge, PieChart as PieChartIcon, Table2, TrendingUp } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { TmsChartCard, TmsDialog, TmsEmptyState, TmsKpiCard } from '@/features/tms/kit'
import { formatValue } from '@/lib/dashboardCharts'
import type { ChartDef, ChartSeries, DashboardGroupBy, ValueFormat } from './types'
import { GROUP_BY_OPTIONS } from './dashboardViews'

/** Series colours are theme tokens (green → dark green → near-black, then the rest), so light and dark both read. */
const SERIES_COLORS = Array.from({ length: 12 }, (_, i) => `var(--tms-chart-${i + 1})`)

const AXIS = 'var(--tms-chart-axis)'
const GRID = 'var(--tms-chart-grid)'

const KIND_ICONS: Record<ChartDef['kind'], LucideIcon> = {
  kpis: Gauge,
  bar: BarChart3,
  line: TrendingUp,
  pie: PieChartIcon,
  table: Table2,
}

/**
 * Axis ticks have to fit and still differ from one another: $1.2M, $45k, $2.8k, $850.
 * Rounding thousands too early prints two ticks the same, which reads as a bug.
 */
function formatTick(value: number, format: ValueFormat): string {
  if (format === 'cents') {
    const dollars = value / 100
    const abs = Math.abs(dollars)
    if (abs >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}M`
    if (abs >= 10_000) return `$${Math.round(dollars / 1_000)}k`
    if (abs >= 1_000) return `$${(dollars / 1_000).toFixed(1)}k`
    return `$${Math.round(dollars)}`
  }
  if (format === 'bps') return `${(value / 100).toFixed(value % 100 === 0 ? 0 : 1)}%`
  if (format === 'hours') return `${Math.round(value)}h`
  return String(Math.round(value))
}

interface TooltipEntry { name?: string | number; value?: number | string; color?: string }

function ChartTooltip({ active, payload, label, format }: {
  active?: boolean
  payload?: TooltipEntry[]
  label?: string | number
  format: ValueFormat
}) {
  if (!active || !payload?.length) return null
  return (
    <div className="tms-chart-tip">
      <div className="tms-chart-tip-label">{String(label ?? '')}</div>
      {payload.map((entry, i) => (
        <div key={`${String(entry.name)}-${i}`} className="tms-chart-tip-row">
          <span className="tms-chart-tip-dot" style={{ background: entry.color }} />
          <span>{String(entry.name ?? '')}</span>
          <strong>{formatValue(Number(entry.value ?? 0), format)}</strong>
        </div>
      ))}
    </div>
  )
}

/** The rows as a table — the `#` view, the `table` kind, and what the CSV export mirrors. */
export function SeriesTable({ series }: { series: ChartSeries }) {
  const columns = series.columns
  return (
    <div className="tms-table-wrap">
      <table className="tms-table">
        <thead>
          <tr>
            <th scope="col">Name</th>
            {columns
              ? columns.map((column) => <th key={column.key} scope="col">{column.label}</th>)
              : series.groups.map((group) => <th key={group} scope="col">{group === 'total' ? 'Value' : group}</th>)}
          </tr>
        </thead>
        <tbody>
          {series.rows.map((row) => (
            <tr key={row.label}>
              <td>{row.label}</td>
              {columns
                ? columns.map((column) => (
                  <td key={column.key}>
                    {column.format === 'text' || column.format === 'date'
                      ? row.text?.[column.key] ?? ''
                      : formatValue(row.values[column.key] ?? 0, column.format ?? series.valueFormat)}
                  </td>
                ))
                : series.groups.map((group) => (
                  <td key={group}>{formatValue(row.values[group] ?? 0, series.valueFormat)}</td>
                ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ChartBody({ def, series, numbers }: { def: ChartDef; series: ChartSeries; numbers: boolean }) {
  const kind = def.kind
  const hasRows = series.rows.length > 0
  const hasKpis = (series.kpis?.length ?? 0) > 0

  const empty = (
    <TmsEmptyState
      title="No data for these filters."
      message={series.note ?? 'Widen the window or the division chip to see something here.'}
    />
  )

  if (!hasRows && !hasKpis) return empty

  const tiles = hasKpis ? (
    <div className="tms-grid tms-grid-4 tms-kpi-strip">
      {series.kpis?.map((kpi) => (
        <TmsKpiCard key={kpi.label} label={kpi.label} value={kpi.value} sub={kpi.sub} />
      ))}
    </div>
  ) : null

  const chartData = series.rows.map((row) => ({ label: row.label, ...row.values }))
  const showTable = numbers || kind === 'table' || kind === 'kpis'

  // The tiles are data. A card that answered with numbers is not empty, so the
  // empty state belongs only to a card that said nothing at all (the early return
  // above) — never underneath a strip of real KPI figures.
  return (
    <div className="tms-chart-inner">
      {tiles}
      {!hasRows ? null : showTable ? (
        <SeriesTable series={series} />
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          {kind === 'pie' ? (
            <PieChart>
              <Pie data={chartData} dataKey={series.groups[0]} nameKey="label" outerRadius="80%" stroke="var(--tms-card)">
                {chartData.map((row, i) => <Cell key={row.label} fill={SERIES_COLORS[i % SERIES_COLORS.length]} />)}
              </Pie>
              <Legend wrapperStyle={{ fontSize: 12, color: AXIS }} />
              <Tooltip content={<ChartTooltip format={series.valueFormat} />} />
            </PieChart>
          ) : kind === 'line' ? (
            <LineChart data={chartData} margin={{ top: 12, right: 16, bottom: 4, left: 4 }}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="label" stroke={AXIS} tick={{ fontSize: 12 }} />
              <YAxis stroke={AXIS} tick={{ fontSize: 12 }} tickFormatter={(v: number) => formatTick(v, series.valueFormat)} width={64} />
              <Tooltip content={<ChartTooltip format={series.valueFormat} />} />
              {series.groups.length > 1 ? <Legend wrapperStyle={{ fontSize: 12, color: AXIS }} /> : null}
              {series.groups.map((group, i) => (
                <Line
                  key={group}
                  type="monotone"
                  dataKey={group}
                  name={group === 'total' ? def.title : group}
                  stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
                  strokeWidth={2}
                  dot={false}
                />
              ))}
            </LineChart>
          ) : (
            <BarChart data={chartData} margin={{ top: 12, right: 16, bottom: 4, left: 4 }}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="label" stroke={AXIS} tick={{ fontSize: 12 }} interval={0} angle={-20} textAnchor="end" height={54} />
              <YAxis stroke={AXIS} tick={{ fontSize: 12 }} tickFormatter={(v: number) => formatTick(v, series.valueFormat)} width={64} />
              <Tooltip content={<ChartTooltip format={series.valueFormat} />} />
              {series.groups.length > 1 ? <Legend wrapperStyle={{ fontSize: 12, color: AXIS }} /> : null}
              {series.groups.map((group, i) => (
                <Bar
                  key={group}
                  dataKey={group}
                  name={group === 'total' ? def.title : group}
                  fill={SERIES_COLORS[i % SERIES_COLORS.length]}
                />
              ))}
            </BarChart>
          )}
        </ResponsiveContainer>
      )}
      {series.note ? <p className="tms-chart-note">{series.note}</p> : null}
    </div>
  )
}

export interface ChartCardProps {
  def: ChartDef
  /** Already computed by the page, so the CSV export and the card agree exactly. */
  series: ChartSeries
  /** The card's own group-by: `undefined` follows the dashboard, `null` is ungrouped. */
  override?: DashboardGroupBy | null | undefined
  /** Absent for server-computed cards (Step AI), which cannot regroup: the picker is hidden. */
  onOverride?: (groupBy: DashboardGroupBy | null | undefined) => void
}

export function ChartCard({ def, series, override, onOverride }: ChartCardProps) {
  const [numbers, setNumbers] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const picker = onOverride ? (
    <select
      className="tms-select tms-chart-groupby"
      aria-label={`Group ${def.title} by`}
      value={override === undefined ? 'INHERIT' : override ?? 'NONE'}
      onChange={(e) => {
        const next = e.target.value
        onOverride(next === 'INHERIT' ? undefined : next === 'NONE' ? null : next as DashboardGroupBy)
      }}
    >
      <option value="INHERIT">Group: dashboard</option>
      <option value="NONE">Group: none</option>
      {GROUP_BY_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>{`Group: ${option.label}`}</option>
      ))}
    </select>
  ) : undefined

  return (
    <>
      <TmsChartCard
        title={def.title}
        icon={KIND_ICONS[def.kind]}
        className={def.kind === 'table' ? 'tms-chart-wide' : undefined}
        menu={picker}
        onNumbers={() => setNumbers((on) => !on)}
        onExpand={() => setExpanded(true)}
      >
        <ChartBody def={def} series={series} numbers={numbers} />
      </TmsChartCard>
      {expanded ? (
        <TmsDialog
          open={expanded}
          onOpenChange={setExpanded}
          title={def.title}
          className="tms-dialog-xl"
        >
          <div className="tms-chart-expanded">
            <ChartBody def={def} series={series} numbers={numbers} />
          </div>
        </TmsDialog>
      ) : null}
    </>
  )
}

export default ChartCard
