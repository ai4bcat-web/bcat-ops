import { useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Legend, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import {
  monthChange, repMonthMatrix, tieOut,
  type DivisionFilter, type DivisionShape, type Measures, type MonthMeasures, type RepMonth, type RepMonthRow, type RepNames,
} from '@/lib/brokerageRevenue'
import { useIsMobile } from '@/hooks/useIsMobile'
import { money0, moneyK, netColor, pct } from './brokerageFormat'

export type RepMetric = 'profit' | 'revenue' | 'expense' | 'loads' | 'all'

const METRICS: { key: RepMetric; label: string }[] = [
  { key: 'profit', label: 'Profit' },
  { key: 'revenue', label: 'Revenue' },
  { key: 'expense', label: 'Expenses' },
  { key: 'loads', label: 'Loads' },
  { key: 'all', label: 'All four' },
]
const DIVISIONS: { key: DivisionFilter; label: string }[] = [
  { key: 'BROKERAGE', label: 'Brokerage' },
  { key: 'ASSETS', label: 'Assets' },
  { key: 'CAR_SHIPPING', label: 'Car shipping' },
  { key: 'ALL', label: 'All divisions' },
]
const FOUR: Exclude<RepMetric, 'all'>[] = ['loads', 'revenue', 'expense', 'profit']
const FOUR_LABEL: Record<Exclude<RepMetric, 'all'>, string> = { loads: 'Loads', revenue: 'Gross revenue', expense: 'Expenses', profit: 'Profit' }
const REP_COLORS = ['var(--tms-chart-1)', 'var(--tms-chart-5)', 'var(--tms-chart-3)', 'var(--tms-chart-6)', 'var(--tms-chart-4)']
const OTHER_COLOR = 'var(--tms-chart-9)'
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`

const valueOf = (m: Measures, metric: Exclude<RepMetric, 'all'>): number =>
  metric === 'loads' ? m.loads : metric === 'revenue' ? m.revenueCents : metric === 'expense' ? m.expenseCents : m.profitCents
const show = (v: number, metric: Exclude<RepMetric, 'all'>) => (metric === 'loads' ? String(v) : money0(v))

const th = { textAlign: 'right', padding: '8px 12px', fontSize: 11, fontWeight: 600, color: 'var(--tms-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' } as const
const td = { textAlign: 'right', padding: '7px 12px', fontSize: 12.5, fontVariantNumeric: 'tabular-nums', color: 'var(--tms-text)', whiteSpace: 'nowrap', verticalAlign: 'top' } as const
const sticky = { position: 'sticky', left: 0, zIndex: 1, background: 'var(--tms-card)', textAlign: 'left' } as const

function Seg<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { key: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div role="group" aria-label={label} style={{ display: 'flex', gap: 3, background: 'var(--tms-bg)', border: '1px solid var(--tms-border)', borderRadius: 9, padding: 3, flexWrap: 'wrap' }}>
      {options.map((o) => {
        const on = o.key === value
        return (
          <button
            key={o.key}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.key)}
            style={{
              padding: '3px 10px', borderRadius: 7, border: 'none', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit',
              fontWeight: on ? 600 : 500, background: on ? 'var(--tms-card)' : 'transparent', color: on ? 'var(--tms-text)' : 'var(--tms-muted)',
              boxShadow: on ? 'var(--tms-shadow)' : 'none',
            }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** One table cell: the figure, and under it the change from the month before (not for the month still in progress). */
function Cell({ value, prev, metric, bold, color, withDelta }: {
  value: number; prev: number | null; metric: Exclude<RepMetric, 'all'>; bold?: boolean; color?: string; withDelta: boolean
}) {
  const change = withDelta && prev !== null ? monthChange(value, prev, metric === 'loads' ? 'loads' : 'money') : null
  // Expenses rising is not good news and not bad news by itself: it stays neutral.
  const tone = !change || change.dir === 'flat' || metric === 'expense'
    ? 'var(--tms-muted)'
    : change.dir === 'up' ? 'var(--tms-badge-green)' : 'var(--tms-badge-red)'
  return (
    <>
      <span style={{ fontWeight: bold ? 700 : 500, color }}>{show(value, metric)}</span>
      {change && <div data-testid="rep-month-delta" style={{ fontSize: 10.5, fontWeight: 600, color: tone }}>{change.dir === 'up' ? '▲ ' : change.dir === 'down' ? '▼ ' : ''}{change.text}</div>}
    </>
  )
}

/**
 * Brokerage load volume, gross revenue, expenses and profit by sales rep, month over month. One table (reps down the
 * side, months across, a Total column), one figure at a time or all four, and a grouped chart of the chosen figure.
 * Every column adds up to that month's row in the month view above it; the month still in progress shows no change.
 */
export function BrokerageRepWidget({ repMonths, divisions, names, months, monthRows, current, ready, own, hideChart }: {
  repMonths: RepMonth[]
  divisions: DivisionShape[]
  names: RepNames
  /** The months across the table, oldest first. */
  months: string[]
  /** The month view's rows for the same months, for the tie-out line (Brokerage only). */
  monthRows: MonthMeasures[]
  /** `YYYY-MM` of the month in progress. */
  current: string
  /** False until every month row carries the rep split (older rows are recomputed by the rollup). */
  ready: boolean
  /** A rep caller sees only their own row. */
  own: boolean
  /** Table only: the Dashboard draws its own charts above. */
  hideChart?: boolean
}) {
  const isMobile = useIsMobile()
  const [metric, setMetric] = useState<RepMetric>('profit')
  const [division, setDivision] = useState<DivisionFilter>('BROKERAGE')
  const matrix = useMemo(() => repMonthMatrix(repMonths, months, divisions, names, division), [repMonths, months, divisions, names, division])
  const chartMetric: Exclude<RepMetric, 'all'> = metric === 'all' ? 'profit' : metric
  const tie = useMemo(
    () => (division === 'BROKERAGE' ? tieOut(monthRows, matrix.totalsByMonth) : null),
    [division, monthRows, matrix.totalsByMonth],
  )

  const chart = useMemo(() => {
    const top = matrix.reps.slice(0, REP_COLORS.length)
    const rest = matrix.reps.slice(REP_COLORS.length)
    const series = [
      ...top.map((r, i) => ({ key: r.repKey || 'none', label: r.label, color: REP_COLORS[i], rows: [r] })),
      ...(rest.length ? [{ key: 'other', label: 'Other reps', color: OTHER_COLOR, rows: rest }] : []),
    ]
    const data = matrix.months.map((month, i) => {
      const point: Record<string, number | string> = { month: monthLabel(month) + (month === current ? ' (to date)' : '') }
      for (const s of series) {
        const sum = s.rows.reduce((acc, r) => acc + valueOf(r.byMonth[i], chartMetric), 0)
        point[s.key] = chartMetric === 'loads' ? sum : sum / 100
      }
      return point
    })
    return { series, data }
  }, [matrix, chartMetric, current])

  if (!ready) {
    return (
      <div className="tms-card" data-testid="brokerage-rep-widget" style={{ padding: 20, fontSize: 13, color: 'var(--tms-muted)' }}>
        The sales-rep split is not ready for these months yet. It fills in as each month is recomputed; the month view above is already complete.
      </div>
    )
  }

  const metrics: Exclude<RepMetric, 'all'>[] = metric === 'all' ? FOUR : [metric]

  const repBlock = (r: RepMonthRow, i: number) => metrics.map((mt, k) => (
    <tr
      key={`${r.repKey || 'none'}-${mt}`}
      data-testid={k === 0 ? (r.repKey === '' ? 'brokerage-rep-none' : 'brokerage-rep-row') : undefined}
      style={{ borderBottom: k === metrics.length - 1 ? '1px solid var(--tms-border)' : undefined }}
    >
      {k === 0 && (
        <td rowSpan={metrics.length} style={{ ...td, ...sticky, fontWeight: 600, fontStyle: r.repKey === '' ? 'italic' : undefined, borderBottom: '1px solid var(--tms-border)' }}>
          <span aria-hidden style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, marginRight: 7, background: i < REP_COLORS.length && r.repKey !== '' ? REP_COLORS[i] : OTHER_COLOR }} />
          {r.label}
        </td>
      )}
      {metric === 'all' && <td style={{ ...td, textAlign: 'left', color: 'var(--tms-muted)', fontSize: 11.5 }}>{FOUR_LABEL[mt]}</td>}
      {r.byMonth.map((m, mi) => (
        <td key={matrix.months[mi]} style={td}>
          <Cell
            value={valueOf(m, mt)}
            prev={mi > 0 ? valueOf(r.byMonth[mi - 1], mt) : null}
            metric={mt}
            withDelta={matrix.months[mi] !== current}
            color={mt === 'profit' ? netColor(m.profitCents) : undefined}
            bold={mt === 'profit'}
          />
        </td>
      ))}
      <td style={{ ...td, fontWeight: 700, background: 'var(--tms-bg)' }}>
        <span style={{ color: mt === 'profit' ? netColor(r.total.profitCents) : undefined }}>{show(valueOf(r.total, mt), mt)}</span>
        {mt === 'profit' && <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--tms-muted)' }}>{pct(r.total.marginBps)}</div>}
      </td>
    </tr>
  ))

  return (
    <div className="tms-card" data-testid="brokerage-rep-widget">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', padding: '12px 14px 0' }}>
        <Seg label="Figure" value={metric} options={METRICS} onChange={setMetric} />
        {!own && <Seg label="Division" value={division} options={DIVISIONS} onChange={setDivision} />}
      </div>

      {matrix.reps.length === 0 ? (
        <div data-testid="brokerage-rep-empty" style={{ padding: 24, fontSize: 13, color: 'var(--tms-muted)' }}>No delivered loads with a rate in these months for this division.</div>
      ) : (
        <>
          {!hideChart && <div style={{ padding: '10px 14px 0' }}>
            <ResponsiveContainer width="100%" height={isMobile ? 220 : 260}>
              <BarChart data={chart.data} margin={{ top: 6, right: 8, bottom: 0, left: 0 }} barGap={2} barCategoryGap="24%">
                <CartesianGrid stroke="var(--tms-chart-grid)" strokeDasharray="3 4" vertical={false} />
                <XAxis dataKey="month" tick={{ fill: 'var(--tms-chart-axis)', fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis
                  tickFormatter={(v) => (chartMetric === 'loads' ? String(v) : moneyK(Number(v) * 100))}
                  tick={{ fill: 'var(--tms-chart-axis)', fontSize: 11 }} axisLine={false} tickLine={false} width={48}
                />
                <ReferenceLine y={0} stroke="var(--tms-chart-9)" />
                <Tooltip
                  formatter={(value, name) => [chartMetric === 'loads' ? String(value) : money0(Number(value) * 100), String(name)]}
                  contentStyle={{ background: 'var(--tms-card)', color: 'var(--tms-text)', border: '1px solid var(--tms-border)', borderRadius: 8, fontSize: 12, boxShadow: 'var(--tms-shadow-pop)' }}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} iconType="square" iconSize={8} />
                {chart.series.map((s) => <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[2, 2, 0, 0]} />)}
              </BarChart>
            </ResponsiveContainer>
          </div>}

          <div style={{ overflowX: 'auto', padding: '4px 6px 12px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }} data-testid="brokerage-rep-table">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--tms-border)' }}>
                  <th style={{ ...th, ...sticky }}>Sales rep</th>
                  {metric === 'all' && <th style={{ ...th, textAlign: 'left' }}>Figure</th>}
                  {matrix.months.map((m) => <th key={m} style={th}>{monthLabel(m)}{m === current ? ' · to date' : ''}</th>)}
                  <th style={{ ...th, background: 'var(--tms-bg)' }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {matrix.reps.map(repBlock)}
                {metrics.map((mt, k) => (
                  <tr key={`total-${mt}`} data-testid={k === 0 ? 'brokerage-rep-total' : undefined} style={{ background: 'var(--tms-bg)' }}>
                    {k === 0 && <td rowSpan={metrics.length} style={{ ...td, ...sticky, background: 'var(--tms-bg)', fontWeight: 700 }}>Total</td>}
                    {metric === 'all' && <td style={{ ...td, textAlign: 'left', color: 'var(--tms-muted)', fontSize: 11.5 }}>{FOUR_LABEL[mt]}</td>}
                    {matrix.totalsByMonth.map((m, mi) => (
                      <td key={matrix.months[mi]} style={td}>
                        <Cell
                          value={valueOf(m, mt)}
                          prev={mi > 0 ? valueOf(matrix.totalsByMonth[mi - 1], mt) : null}
                          metric={mt}
                          withDelta={matrix.months[mi] !== current}
                          color={mt === 'profit' ? netColor(m.profitCents) : undefined}
                          bold
                        />
                      </td>
                    ))}
                    <td style={{ ...td, fontWeight: 700 }}>
                      <span style={{ color: mt === 'profit' ? netColor(matrix.grand.profitCents) : undefined }}>{show(valueOf(matrix.grand, mt), mt)}</span>
                      {mt === 'profit' && <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--tms-muted)' }}>{pct(matrix.grand.marginBps)}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {tie && (
              <div data-testid="brokerage-tie" data-ok={tie.ok} style={{ margin: '8px 8px 0', fontSize: 11.5, color: tie.ok ? 'var(--tms-muted)' : 'var(--tms-badge-red)' }}>
                {tie.ok
                  ? 'Every month column equals the month view above for the same months.'
                  : `Rep totals differ from the month view by ${money0(tie.revenueDiffCents)} revenue / ${money0(tie.expenseDiffCents)} expense (${tie.loadsDiff} loads).`}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
