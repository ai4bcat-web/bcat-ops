import { useMemo } from 'react'
import { Wallet } from 'lucide-react'
import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ReferenceLine } from 'recharts'
import { useProfitReview } from '@/hooks/useProfitReview'
import { monthMetrics } from '@/lib/profitReview'
import { useAmazonProfitability, aggregateAmazon } from '@/hooks/useAmazonProfitability'
import { useOwnerOperatorProfitability, aggregateOwnerOperator } from '@/hooks/useOwnerOperatorProfitability'
import { useIsMobile } from '@/hooks/useIsMobile'
import { startOfMonth, endOfMonth, format, getMonth } from 'date-fns'

const money0 = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
const moneyK = (n: number) => `${n < 0 ? '−' : ''}$${Math.round(Math.abs(n) / 1000)}k`
const netColor = (n: number) => (n > 0 ? 'var(--tms-badge-green)' : n < 0 ? 'var(--tms-badge-red)' : 'var(--tms-text-2)')
const COLORS = { ivan: 'var(--tms-chart-5)', oo: 'var(--tms-chart-6)', amazon: 'var(--tms-chart-4)', total: 'var(--tms-chart-3)' }

/**
 * The year so far, month over month, each profit source on its own: Ivan local + box
 * truck (fleet net, same math as the Finances P&L and the Profit Review), owner-operators
 * (profit to the company) and Amazon (profit to the company), with the combined line on
 * top. Kept short so the rest of the dashboard stays above the fold.
 */
/** Expense data starts here; earlier months have revenue but no costs and read as losses. */
const PROFIT_START = '2026-06'

export function YearProfitWidget() {
  const isMobile = useIsMobile()
  const now = new Date()
  const monthsThisYear = getMonth(now) + 1
  const { months: allIvanMonths, loading: ivanLoading } = useProfitReview(monthsThisYear)
  const ivanMonths = useMemo(() => allIvanMonths.filter((m) => m.key >= PROFIT_START), [allIvanMonths])
  const { rows: amzRows, loading: amzLoading } = useAmazonProfitability()
  const { rows: ooRows, loading: ooLoading } = useOwnerOperatorProfitability()

  const data = useMemo(() => ivanMonths.map((m) => {
    const base = new Date(`${m.key}-15T12:00:00`)
    const start = format(startOfMonth(base), 'yyyy-MM-dd'), end = format(endOfMonth(base), 'yyyy-MM-dd')
    const ivan = monthMetrics(m).net
    const oo = aggregateOwnerOperator(ooRows, start, end, { prorate: true }).profit
    const amazon = aggregateAmazon(amzRows, start, end, { prorate: true }).profit
    return { month: format(base, 'MMM'), key: m.key, ivan, oo, amazon, total: ivan + oo + amazon, partial: m.daysElapsed < m.daysInMonth }
  }), [ivanMonths, amzRows, ooRows])

  const ytd = useMemo(() => data.reduce((acc, d) => ({ ivan: acc.ivan + d.ivan, oo: acc.oo + d.oo, amazon: acc.amazon + d.amazon, total: acc.total + d.total }), { ivan: 0, oo: 0, amazon: 0, total: 0 }), [data])
  const loading = (ivanLoading && ivanMonths.every((m) => m.revenue === 0)) || amzLoading || ooLoading
  const thisMonth = data[data.length - 1]

  return (
    <div className="tms-card">
      <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', alignItems: 'stretch' }}>
        {/* This month to date, by source; the year so far underneath */}
        <div style={{ padding: '14px 20px', minWidth: isMobile ? undefined : 300, borderRight: isMobile ? 'none' : '1px solid var(--tms-border)', borderBottom: isMobile ? '1px solid var(--tms-border)' : 'none' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Wallet size={15} style={{ color: 'var(--tms-primary)' }} />
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--tms-text)' }}>Combined profit · {thisMonth ? `${thisMonth.month} ${now.getFullYear()}${thisMonth.partial ? ' to date' : ''}` : 'this month'}</span>
          </div>
          <div style={{ fontSize: 30, fontWeight: 800, lineHeight: 1.1, marginTop: 6, color: netColor(thisMonth?.total ?? 0), fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em' }}>{loading || !thisMonth ? '…' : money0(thisMonth.total)}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, auto)', gap: '6px 16px', marginTop: 10, fontSize: 11.5 }}>
            {([['Ivan + box truck', thisMonth?.ivan ?? 0, COLORS.ivan], ['Owner operators', thisMonth?.oo ?? 0, COLORS.oo], ['Amazon', thisMonth?.amazon ?? 0, COLORS.amazon]] as const).map(([label, v, color]) => (
              <div key={label}>
                <div style={{ color: 'var(--tms-muted)', display: 'flex', alignItems: 'center', gap: 5 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: color, display: 'inline-block' }} />{label}</div>
                <div style={{ fontWeight: 700, color: netColor(v), fontVariantNumeric: 'tabular-nums' }}>{loading ? '…' : money0(v)}</div>
              </div>
            ))}
          </div>
          {!loading && data.length > 0 && (
            <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--tms-border)', fontSize: 11.5, color: 'var(--tms-muted)' }}>
              {data[0].month} {now.getFullYear()} to date: <span style={{ fontWeight: 700, color: netColor(ytd.total) }}>{money0(ytd.total)}</span>
              <span style={{ marginLeft: 8 }}>· Ivan {money0(ytd.ivan)} · OO {money0(ytd.oo)} · Amazon {money0(ytd.amazon)}</span>
            </div>
          )}
        </div>

        {/* Month over month, each source its own bar, the combined total as a line */}
        <div style={{ flex: 1, minWidth: 0, padding: '10px 12px 4px' }}>
          <ResponsiveContainer width="100%" height={isMobile ? 190 : 170}>
            <ComposedChart data={data} margin={{ top: 6, right: 12, bottom: 0, left: 0 }} barGap={2} barCategoryGap="28%">
              <CartesianGrid stroke="var(--tms-chart-grid)" strokeDasharray="3 4" vertical={false} />
              <XAxis dataKey="month" tick={{ fill: 'var(--tms-chart-axis)', fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={(v) => moneyK(Number(v))} tick={{ fill: 'var(--tms-chart-axis)', fontSize: 11 }} axisLine={false} tickLine={false} width={48} />
              <ReferenceLine y={0} stroke="var(--tms-chart-9)" />
              <Tooltip formatter={(value, name) => [money0(Number(value)), String(name)]} labelFormatter={(l, p) => { const d = p?.[0]?.payload as { partial?: boolean } | undefined; return `${l}${d?.partial ? ' (to date)' : ''}` }}
                contentStyle={{ background: 'var(--tms-card)', color: 'var(--tms-text)', border: '1px solid var(--tms-border)', borderRadius: 8, fontSize: 12, boxShadow: 'var(--tms-shadow-pop)' }} />
              <Legend wrapperStyle={{ fontSize: 11 }} iconType="square" iconSize={8} />
              <Bar dataKey="ivan" name="Ivan + box truck" fill={COLORS.ivan} radius={[2, 2, 0, 0]} />
              <Bar dataKey="oo" name="Owner operators" fill={COLORS.oo} radius={[2, 2, 0, 0]} />
              <Bar dataKey="amazon" name="Amazon" fill={COLORS.amazon} radius={[2, 2, 0, 0]} />
              <Line type="monotone" dataKey="total" name="Combined" stroke={COLORS.total} strokeWidth={2} dot={{ r: 3 }} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  )
}
