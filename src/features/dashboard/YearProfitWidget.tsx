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
const netColor = (n: number) => (n > 0 ? '#15803d' : n < 0 ? '#dc2626' : 'var(--ds-t2)')
const COLORS = { ivan: '#2563eb', oo: '#7c3aed', amazon: '#f59e0b', total: '#111827' }

/**
 * The year so far, month over month, each profit source on its own: Ivan local + box
 * truck (fleet net, same math as the Finances P&L and the Profit Review), owner-operators
 * (profit to the company) and Amazon (profit to the company), with the combined line on
 * top. Kept short so the rest of the dashboard stays above the fold.
 */
export function YearProfitWidget() {
  const isMobile = useIsMobile()
  const now = new Date()
  const monthsThisYear = getMonth(now) + 1
  const { months: ivanMonths, loading: ivanLoading } = useProfitReview(monthsThisYear)
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
    <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', alignItems: 'stretch' }}>
        {/* Year to date, by source */}
        <div style={{ padding: '14px 20px', minWidth: isMobile ? undefined : 300, borderRight: isMobile ? 'none' : '1px solid var(--ds-border)', borderBottom: isMobile ? '1px solid var(--ds-border)' : 'none' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Wallet size={15} style={{ color: 'var(--ds-blue)' }} />
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ds-t1)' }}>Combined profit · {now.getFullYear()} to date</span>
          </div>
          <div style={{ fontSize: 30, fontWeight: 800, lineHeight: 1.1, marginTop: 6, color: netColor(ytd.total), fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em' }}>{loading ? '…' : money0(ytd.total)}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, auto)', gap: '6px 16px', marginTop: 10, fontSize: 11.5 }}>
            {([['Ivan + box truck', ytd.ivan, COLORS.ivan], ['Owner operators', ytd.oo, COLORS.oo], ['Amazon', ytd.amazon, COLORS.amazon]] as const).map(([label, v, color]) => (
              <div key={label}>
                <div style={{ color: 'var(--ds-t3)', display: 'flex', alignItems: 'center', gap: 5 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: color, display: 'inline-block' }} />{label}</div>
                <div style={{ fontWeight: 700, color: netColor(v), fontVariantNumeric: 'tabular-nums' }}>{loading ? '…' : money0(v)}</div>
              </div>
            ))}
          </div>
          {thisMonth && !loading && (
            <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--ds-t3)' }}>
              {thisMonth.month}{thisMonth.partial ? ' to date' : ''}: <span style={{ fontWeight: 700, color: netColor(thisMonth.total) }}>{money0(thisMonth.total)}</span>
            </div>
          )}
        </div>

        {/* Month over month, each source its own bar, the combined total as a line */}
        <div style={{ flex: 1, minWidth: 0, padding: '10px 12px 4px' }}>
          <ResponsiveContainer width="100%" height={isMobile ? 190 : 170}>
            <ComposedChart data={data} margin={{ top: 6, right: 12, bottom: 0, left: 0 }} barGap={2} barCategoryGap="28%">
              <CartesianGrid stroke="rgba(15,23,42,0.06)" strokeDasharray="3 4" vertical={false} />
              <XAxis dataKey="month" tick={{ fill: '#6b7588', fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={(v) => moneyK(Number(v))} tick={{ fill: '#6b7588', fontSize: 11 }} axisLine={false} tickLine={false} width={48} />
              <ReferenceLine y={0} stroke="#9ca3af" />
              <Tooltip formatter={(value, name) => [money0(Number(value)), String(name)]} labelFormatter={(l, p) => { const d = p?.[0]?.payload as { partial?: boolean } | undefined; return `${l}${d?.partial ? ' (to date)' : ''}` }}
                contentStyle={{ background: 'white', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 12, boxShadow: 'var(--sh-md)' }} />
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
