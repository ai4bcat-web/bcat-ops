import { useMemo } from 'react'
import { Truck } from 'lucide-react'
import { BarChart, Bar, Cell, LabelList, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { useProfitReview } from '@/hooks/useProfitReview'
import { buildCostShare, SHARE_KEYS, type CostShareRow, type ShareKey } from '@/lib/localFleetCostShare'
import { DashCard } from './DashCard'

const MONTHS_BACK = 6
const CHART_HEIGHT = 250
const LABELS: Record<ShareKey, string> = { fuel: 'Fuel', driverPay: 'Driver pay', insurance: 'Insurance', maintenance: 'Maintenance' }
const COLORS: Record<ShareKey, string> = { fuel: 'var(--tms-chart-4)', driverPay: 'var(--tms-chart-6)', insurance: 'var(--tms-chart-8)', maintenance: 'var(--tms-chart-7)' }
const LEFTOVER = 'var(--tms-chart-9)'
const REVENUE_ONLY = 'var(--tms-chart-10)'
const SEGMENT_TEXT = 'var(--tms-chart-label)'
/** A segment must be this tall (px) to carry its percent inside. */
const MIN_LABEL_HEIGHT = 15

const money0 = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
const moneyK = (n: number) => `$${Math.round(n / 1000)}k`
const pctText = (n: number | null) => (n == null ? '—' : `${n.toFixed(1)}%`)
const pctWhole = (n: number | null) => (n == null ? '' : `${Math.round(n)}%`)

/** A stacked column's segments: the dollars of each category, then what is left of the revenue. */
interface StackRow extends CostShareRow { revenueOnly: number }
const toStack = (r: CostShareRow): StackRow => ({ ...r, revenueOnly: r.noCosts ? r.revenue : 0 })

function ShareTooltip({ active, payload }: { active?: boolean; payload?: { payload: StackRow }[] }) {
  const row = active ? payload?.[0]?.payload : undefined
  if (!row) return null
  return (
    <div style={{ background: 'var(--tms-card)', color: 'var(--tms-text)', border: '1px solid var(--tms-border)', borderRadius: 8, fontSize: 12, boxShadow: 'var(--tms-shadow-pop)', padding: '8px 10px', minWidth: 210 }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>{row.month}{row.partial ? ' (to date)' : ''} · {money0(row.revenue)} revenue</div>
      {row.noCosts ? (
        <div style={{ color: 'var(--tms-muted)' }}>Costs were not on file this month.</div>
      ) : (
        <>
          {SHARE_KEYS.map((k) => (
            <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, fontVariantNumeric: 'tabular-nums' }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: COLORS[k], flexShrink: 0 }} />
              <span style={{ flex: 1 }}>{LABELS[k]}</span>
              <span style={{ fontWeight: 600 }}>{pctText(row.pct[k])}</span>
              <span style={{ color: 'var(--tms-muted)', minWidth: 64, textAlign: 'right' }}>{money0(row[k])}</span>
            </div>
          ))}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontVariantNumeric: 'tabular-nums', marginTop: 3, paddingTop: 3, borderTop: '1px solid var(--tms-border)' }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: LEFTOVER, flexShrink: 0 }} />
            <span style={{ flex: 1 }}>{row.overRevenue ? 'Over revenue by' : 'Left over'}</span>
            <span style={{ fontWeight: 600 }}>{pctText(row.leftoverPct)}</span>
            <span style={{ color: 'var(--tms-muted)', minWidth: 64, textAlign: 'right' }}>{money0(row.revenue - row.fuel - row.driverPay - row.insurance - row.maintenance)}</span>
          </div>
        </>
      )}
    </div>
  )
}

/** The month under each column: its name, its revenue, and the share left over after the four costs. */
function MonthTick({ x, y, payload, rows }: { x?: number; y?: number; payload?: { value: string }; rows: StackRow[] }) {
  const row = rows.find((r) => r.key === payload?.value)
  if (!row) return null
  const cx = x ?? 0
  const cy = y ?? 0
  return (
    <g transform={`translate(${cx},${cy})`}>
      <text y={14} textAnchor="middle" fill="var(--tms-text)" fontSize={12} fontWeight={600}>{row.month}{row.partial ? ' (to date)' : ''}</text>
      <text y={29} textAnchor="middle" fill="var(--tms-text)" fontSize={11.5} style={{ fontVariantNumeric: 'tabular-nums' }}>{money0(row.revenue)}</text>
      <text y={43} textAnchor="middle" fill="var(--tms-chart-axis)" fontSize={11} style={{ fontVariantNumeric: 'tabular-nums' }}>
        {row.noCosts ? 'costs not on file' : `${pctWhole(row.leftoverPct)} left`}
      </text>
    </g>
  )
}

/** The percent printed inside a segment; skipped when the segment is too short to hold it. */
function segmentLabel(rows: StackRow[], pick: (r: StackRow) => number | null) {
  return function SegmentLabel(props: { x?: number | string; y?: number | string; width?: number | string; height?: number | string; index?: number }) {
    const r = props.index == null ? undefined : rows[props.index]
    const h = Number(props.height ?? 0)
    if (!r || h < MIN_LABEL_HEIGHT) return null
    const text = pctWhole(pick(r))
    if (!text) return null
    return (
      <text x={Number(props.x ?? 0) + Number(props.width ?? 0) / 2} y={Number(props.y ?? 0) + h / 2} textAnchor="middle" dominantBaseline="central" fontSize={11} fontWeight={600} fill={SEGMENT_TEXT} style={{ fontVariantNumeric: 'tabular-nums', pointerEvents: 'none' }}>{text}</text>
    )
  }
}

/**
 * Our local drivers (the Ivan local fleet plus the box truck, same scope as the Profit Review and the Finances P&L):
 * one column per month whose height is that month's revenue, split into what went to fuel, driver pay, insurance and
 * maintenance, with the rest on top. Months with no costs on file show a plain revenue column. Internal money, so it
 * sits behind the same accounting access as the receivable and payable cards.
 */
export function LocalFleetCostShareCard() {
  const { months, loading } = useProfitReview(MONTHS_BACK)
  const rows = useMemo(() => buildCostShare(months).map(toStack), [months])
  const hasData = rows.some((r) => r.revenue > 0)
  const latest = [...rows].reverse().find((r) => r.revenue > 0 && !r.noCosts)
  const flagged = rows.filter((r) => r.lowEntry.length > 0)
  const noInsurance = rows.some((r) => !r.noCosts && r.revenue > 0) && rows.filter((r) => !r.noCosts && r.revenue > 0).every((r) => r.insurance === 0)
  const labelFor = useMemo(() => ({
    fuel: segmentLabel(rows, (r) => r.pct.fuel),
    driverPay: segmentLabel(rows, (r) => r.pct.driverPay),
    insurance: segmentLabel(rows, (r) => r.pct.insurance),
    maintenance: segmentLabel(rows, (r) => r.pct.maintenance),
    leftover: segmentLabel(rows, (r) => r.leftoverPct),
  }), [rows])

  return (
    <DashCard label="Local drivers · revenue and cost share" icon={<Truck size={15} />} hint="Each column is a month of local fleet revenue, split into fuel, driver pay, insurance, maintenance and what is left" testId="local-fleet-cost-share" ariaBusy={loading && !hasData}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', fontSize: 11.5, color: 'var(--tms-muted)', alignItems: 'center' }}>
        {SHARE_KEYS.map((k) => (
          <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: COLORS[k] }} />
            {LABELS[k]}{latest ? <b style={{ color: 'var(--tms-text)', fontVariantNumeric: 'tabular-nums' }}>{pctText(latest.pct[k])}</b> : null}
          </span>
        ))}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: LEFTOVER }} />
          Left over{latest ? <b style={{ color: 'var(--tms-text)', fontVariantNumeric: 'tabular-nums' }}>{pctText(latest.leftoverPct)}</b> : null}
        </span>
        {latest ? <span>· percents are {latest.month}, % of revenue</span> : null}
      </div>
      {loading && !hasData ? (
        <div style={{ height: CHART_HEIGHT, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12.5, color: 'var(--tms-muted)' }}>Loading…</div>
      ) : (
        <div style={{ overflowX: 'auto', minWidth: 0 }}>
          <div style={{ height: CHART_HEIGHT, minWidth: 460 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={rows} margin={{ top: 6, right: 4, bottom: 0, left: 0 }} barCategoryGap="18%">
                <CartesianGrid stroke="var(--tms-chart-grid)" strokeDasharray="3 4" vertical={false} />
                <XAxis dataKey="key" interval={0} height={54} tickLine={false} axisLine={false} tick={<MonthTick rows={rows} />} />
                <YAxis tickFormatter={(v) => moneyK(Number(v))} tick={{ fill: 'var(--tms-chart-axis)', fontSize: 11 }} axisLine={false} tickLine={false} width={44} />
                <Tooltip content={<ShareTooltip />} cursor={{ fill: 'var(--tms-bg)' }} />
                {SHARE_KEYS.map((k) => (
                  <Bar key={k} dataKey={k} stackId="m" name={LABELS[k]} fill={COLORS[k]} maxBarSize={72} isAnimationActive={false}>
                    {rows.map((r) => <Cell key={r.key} fillOpacity={r.partial ? 0.6 : 1} />)}
                    <LabelList content={labelFor[k]} />
                  </Bar>
                ))}
                <Bar dataKey="leftover" stackId="m" name="Left over" fill={LEFTOVER} maxBarSize={72} isAnimationActive={false}>
                  {rows.map((r) => <Cell key={r.key} fillOpacity={r.partial ? 0.45 : 0.75} />)}
                  <LabelList content={labelFor.leftover} />
                </Bar>
                <Bar dataKey="revenueOnly" stackId="m" name="Revenue" fill={REVENUE_ONLY} maxBarSize={72} radius={[4, 4, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
      <div style={{ fontSize: 11.5, color: 'var(--tms-muted)', display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div>Column height is the month's revenue. Left over is what remains after these four costs, before other fixed costs.</div>
        {rows.some((r) => r.partial) && <div>The current month is to date and drawn lighter; insurance is cut to the days so far.</div>}
        {rows.some((r) => r.noCosts && r.revenue > 0) && <div>Earlier months show revenue only: costs were not on file.</div>}
        {flagged.map((r) => (
          <div key={r.key} style={{ color: 'var(--tms-badge-orange)' }}>
            {r.month}: {r.lowEntry.map((k) => LABELS[k].toLowerCase()).join(' and ')} looks incomplete, so its share reads low and the profit looks better than it is.
          </div>
        ))}
        {noInsurance && <div style={{ color: 'var(--tms-badge-orange)' }}>No insurance is entered for these months. Add the policy lines on the Insurance page.</div>}
      </div>
    </DashCard>
  )
}
