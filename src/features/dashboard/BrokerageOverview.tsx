import { useMemo } from 'react'
import { Bar, BarChart, CartesianGrid, Legend, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Lightbulb } from 'lucide-react'
import type { MonthMeasures } from '@/lib/brokerageRevenue'
import { useIsMobile } from '@/hooks/useIsMobile'
import { money0, moneyCompact, moneyK, netColor, pct, previousMonth } from './brokerageFormat'
import { monthName, monthShort, type Insight } from './brokerageInsights'

const TONE: Record<Insight['tone'], string> = { good: 'var(--tms-badge-green)', watch: 'var(--tms-badge-orange)', neutral: 'var(--tms-chart-9)' }

function Kpi({ label, value, caption, color, testId }: { label: string; value: string; caption: string; color?: string; testId: string }) {
  return (
    <div className="tms-card dash-card" style={{ padding: '14px 18px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--tms-muted)' }}>{label}</div>
      <div data-testid={testId} style={{ fontSize: 28, fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1.1, color: color ?? 'var(--tms-text)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      <div style={{ fontSize: 12, color: 'var(--tms-muted)' }}>{caption}</div>
    </div>
  )
}

/**
 * The Brokerage headline: five figures for the month in progress, to date (revenue, expenses, profit, margin, loads), each with last month in full
 * beside it; one revenue-expenses-profit chart by month for the chosen range; and a few plain-English takeaways. The range picker drives the chart and
 * the takeaways, never the headline figures. Everything finer (rep by month, every figure) sits behind the table at the bottom.
 */
export function BrokerageOverview({ rows, current, loading, insights }: {
  rows: MonthMeasures[]
  current: string
  loading: boolean
  insights: Insight[]
}) {
  const isMobile = useIsMobile()
  const now = rows.find((r) => r.month === current)
  const last = rows.find((r) => r.month === previousMonth(current))
  const mtd = now ?? { month: current, loads: 0, revenueCents: 0, expenseCents: 0, profitCents: 0, marginBps: null }
  const data = useMemo(() => rows.map((r) => ({
    month: monthShort(r.month) + (r.month === current ? ' · to date' : ''),
    revenue: r.revenueCents / 100,
    expenses: r.expenseCents / 100,
    profit: r.profitCents / 100,
  })), [rows, current])
  const dash = loading ? '…' : undefined
  const eyebrow = `${monthName(current)} to date`
  // Last month in full, so the month in progress has something to be read against (it is not the same days, and says so).
  const lastFull = (text: string | undefined) => (last && text !== undefined ? `${monthName(last.month)} in full: ${text}` : `${monthShort(current)}, delivered so far`)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, minmax(0, 1fr))' : 'repeat(5, minmax(0, 1fr))', gap: 14 }}>
        <Kpi testId="brokerage-total-revenue" label={`Revenue · ${eyebrow}`} value={dash ?? money0(mtd.revenueCents)} caption={lastFull(last && moneyCompact(last.revenueCents))} />
        <Kpi testId="brokerage-total-expenses" label={`Expenses · ${eyebrow}`} value={dash ?? money0(mtd.expenseCents)} caption={lastFull(last && moneyCompact(last.expenseCents))} />
        <Kpi testId="brokerage-total-profit" label={`Profit · ${eyebrow}`} value={dash ?? money0(mtd.profitCents)} color={netColor(mtd.profitCents)} caption={lastFull(last && moneyCompact(last.profitCents))} />
        <Kpi testId="brokerage-total-profit-pct" label={`Profit margin · ${eyebrow}`} value={dash ?? pct(mtd.marginBps)} color={netColor(mtd.profitCents)} caption={last ? lastFull(pct(last.marginBps)) : 'Profit ÷ revenue'} />
        <Kpi testId="brokerage-total-loads" label={`Loads delivered · ${eyebrow}`} value={dash ?? String(mtd.loads)} caption={lastFull(last && String(last.loads))} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : 'minmax(0, 2fr) minmax(0, 1fr)', gap: 14, alignItems: 'stretch' }}>
        <div className="tms-card dash-card" data-testid="brokerage-month-chart" style={{ padding: '14px 12px 6px', minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--tms-text)', padding: '0 8px 6px' }}>Revenue, expenses and profit by month</div>
          <ResponsiveContainer width="100%" height={isMobile ? 210 : 230}>
            <BarChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 0 }} barGap={3} barCategoryGap="30%">
              <CartesianGrid stroke="var(--tms-chart-grid)" strokeDasharray="3 4" vertical={false} />
              <XAxis dataKey="month" tick={{ fill: 'var(--tms-chart-axis)', fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={(v) => moneyK(Number(v) * 100)} tick={{ fill: 'var(--tms-chart-axis)', fontSize: 11 }} axisLine={false} tickLine={false} width={48} />
              <ReferenceLine y={0} stroke="var(--tms-chart-9)" />
              <Tooltip
                cursor={{ fill: 'var(--tms-bg)' }}
                formatter={(value, name) => [money0(Number(value) * 100), String(name)]}
                contentStyle={{ background: 'var(--tms-card)', color: 'var(--tms-text)', border: '1px solid var(--tms-border)', borderRadius: 8, fontSize: 12, boxShadow: 'var(--tms-shadow-pop)' }}
              />
              <Legend wrapperStyle={{ fontSize: 11.5 }} iconType="square" iconSize={8} />
              <Bar dataKey="revenue" name="Revenue" fill="var(--tms-chart-1)" radius={[4, 4, 0, 0]} maxBarSize={44} />
              <Bar dataKey="expenses" name="Expenses" fill="var(--tms-chart-4)" radius={[4, 4, 0, 0]} maxBarSize={44} />
              <Bar dataKey="profit" name="Profit" fill="var(--tms-chart-5)" radius={[4, 4, 0, 0]} maxBarSize={44} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="tms-card dash-card" data-testid="brokerage-insights" style={{ padding: '14px 18px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 600, color: 'var(--tms-text)' }}>
            <Lightbulb size={14} style={{ color: 'var(--tms-text-2)' }} /> What stands out
          </div>
          {insights.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--tms-muted)' }}>Takeaways show up once there are delivered loads to compare.</div>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {insights.map((i) => (
                <li key={i.key} style={{ display: 'flex', gap: 9, fontSize: 13, lineHeight: 1.45, color: 'var(--tms-text-2)' }}>
                  <span aria-hidden style={{ width: 3, borderRadius: 2, background: TONE[i.tone], flexShrink: 0 }} />
                  <span>{i.text}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
