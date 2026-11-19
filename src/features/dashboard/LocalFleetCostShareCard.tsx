import { useMemo } from 'react'
import { Truck } from 'lucide-react'
import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { useProfitReview } from '@/hooks/useProfitReview'
import { buildCostShare, SHARE_KEYS, type CostShareRow, type ShareKey } from '@/lib/localFleetCostShare'
import { DashCard } from './DashCard'

const MONTHS_BACK = 6
const LABELS: Record<ShareKey, string> = { fuel: 'Fuel', driverPay: 'Driver pay', insurance: 'Insurance', maintenance: 'Maintenance' }
const COLORS: Record<ShareKey, string> = { fuel: 'var(--tms-chart-4)', driverPay: 'var(--tms-chart-6)', insurance: 'var(--tms-chart-8)', maintenance: 'var(--tms-chart-7)' }
const BAR = 'var(--tms-chart-10)'

const money0 = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
const moneyK = (n: number) => `$${Math.round(n / 1000)}k`
const pctText = (n: number | null) => (n == null ? '—' : `${n.toFixed(1)}%`)

function ShareTooltip({ active, payload }: { active?: boolean; payload?: { payload: CostShareRow }[] }) {
  const row = active ? payload?.[0]?.payload : undefined
  if (!row) return null
  return (
    <div style={{ background: 'var(--tms-card)', color: 'var(--tms-text)', border: '1px solid var(--tms-border)', borderRadius: 8, fontSize: 12, boxShadow: 'var(--tms-shadow-pop)', padding: '8px 10px', minWidth: 190 }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>{row.month}{row.partial ? ' (to date)' : ''} · {money0(row.revenue)} revenue</div>
      {row.noCosts ? (
        <div style={{ color: 'var(--tms-muted)' }}>Costs were not on file this month.</div>
      ) : SHARE_KEYS.map((k) => (
        <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, fontVariantNumeric: 'tabular-nums' }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: COLORS[k], flexShrink: 0 }} />
          <span style={{ flex: 1 }}>{LABELS[k]}</span>
          <span style={{ fontWeight: 600 }}>{pctText(row.pct[k])}</span>
          <span style={{ color: 'var(--tms-muted)', minWidth: 64, textAlign: 'right' }}>{money0(row[k])}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * Our local drivers (the Ivan local fleet plus the box truck, same scope as the Profit Review and the Finances P&L):
 * revenue each month as bars, and the share of that revenue that went to fuel, driver pay, insurance and maintenance
 * as lines. Internal money, so it sits behind the same accounting access as the receivable and payable cards.
 */
export function LocalFleetCostShareCard() {
  const { months, loading } = useProfitReview(MONTHS_BACK)
  const rows = useMemo(() => buildCostShare(months), [months])
  const hasData = rows.some((r) => r.revenue > 0)
  const latest = [...rows].reverse().find((r) => r.revenue > 0 && !r.noCosts)
  const flagged = rows.filter((r) => r.lowEntry.length > 0)
  const noInsurance = rows.some((r) => !r.noCosts && r.revenue > 0) && rows.filter((r) => !r.noCosts && r.revenue > 0).every((r) => r.insurance === 0)

  return (
    <DashCard label="Local drivers · revenue and cost share" icon={<Truck size={15} />} hint="Local fleet revenue by month, and the percent of it spent on fuel, driver pay, insurance and maintenance" testId="local-fleet-cost-share" ariaBusy={loading && !hasData}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', fontSize: 11.5, color: 'var(--tms-muted)', alignItems: 'center' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 10, height: 8, borderRadius: 2, background: BAR }} />Revenue ($, left)</span>
        {SHARE_KEYS.map((k) => (
          <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 10, height: 3, borderRadius: 2, background: COLORS[k] }} />
            {LABELS[k]} (% of revenue, right){latest ? <b style={{ color: 'var(--tms-text)', fontVariantNumeric: 'tabular-nums' }}>{pctText(latest.pct[k])}</b> : null}
          </span>
        ))}
      </div>
      {loading && !hasData ? (
        <div style={{ height: 210, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12.5, color: 'var(--tms-muted)' }}>Loading…</div>
      ) : (
        <div style={{ height: 210, minWidth: 0 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows} margin={{ top: 6, right: 4, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="var(--tms-chart-grid)" strokeDasharray="3 4" vertical={false} />
              <XAxis dataKey="month" tick={{ fill: 'var(--tms-chart-axis)', fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis yAxisId="rev" tickFormatter={(v) => moneyK(Number(v))} tick={{ fill: 'var(--tms-chart-axis)', fontSize: 11 }} axisLine={false} tickLine={false} width={44} />
              <YAxis yAxisId="pct" orientation="right" tickFormatter={(v) => `${v}%`} tick={{ fill: 'var(--tms-chart-axis)', fontSize: 11 }} axisLine={false} tickLine={false} width={40} />
              <Tooltip content={<ShareTooltip />} cursor={{ fill: 'var(--tms-bg)' }} />
              <Bar yAxisId="rev" dataKey="revenue" name="Revenue" fill={BAR} radius={[4, 4, 0, 0]} maxBarSize={44} />
              {SHARE_KEYS.map((k) => (
                <Line key={k} yAxisId="pct" type="monotone" dataKey={`pct.${k}`} name={LABELS[k]} stroke={COLORS[k]} strokeWidth={2} connectNulls={false}
                  dot={{ r: 3, fill: 'var(--tms-card)', stroke: COLORS[k], strokeWidth: 2 }} activeDot={{ r: 5 }} isAnimationActive={false} />
              ))}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
      <div style={{ fontSize: 11.5, color: 'var(--tms-muted)', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {rows.some((r) => r.partial) && <div>The current month is to date; insurance is cut to the days so far.</div>}
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
