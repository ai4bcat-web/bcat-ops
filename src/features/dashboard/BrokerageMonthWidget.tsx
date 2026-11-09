import { useMemo } from 'react'
import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ReferenceLine } from 'recharts'
import { totalsOf, type MonthMeasures } from '@/lib/brokerageRevenue'
import { useIsMobile } from '@/hooks/useIsMobile'
import { money0, moneyK, netColor, pct } from './brokerageFormat'

const COLORS = { revenue: 'var(--tms-chart-5)', expense: 'var(--tms-chart-4)', margin: 'var(--tms-chart-3)' }
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(2, 4)}`

const th = { textAlign: 'right', padding: '6px 10px', fontSize: 11, fontWeight: 600, color: 'var(--tms-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' } as const
const td = { textAlign: 'right', padding: '6px 10px', fontSize: 12.5, fontVariantNumeric: 'tabular-nums', color: 'var(--tms-text)' } as const

/** Brokerage revenue, expense, profit and profit % per month: chart on top, table with a totals row below. */
export function BrokerageMonthWidget({ rows, current, state }: { rows: MonthMeasures[]; current: string; state: 'loading' | 'ready' }) {
  const isMobile = useIsMobile()
  const totals = useMemo(() => totalsOf(rows), [rows])
  const data = useMemo(() => rows.map((r) => ({
    month: monthLabel(r.month),
    revenue: r.revenueCents / 100,
    expense: r.expenseCents / 100,
    // A month with no revenue has no profit % (a gap in the line, a dash in the table).
    margin: r.marginBps == null ? null : r.marginBps / 100,
    partial: r.month === current,
  })), [rows, current])
  const loading = state === 'loading'

  return (
    <div className="tms-card" data-testid="brokerage-month-widget">
      <div style={{ padding: '14px 20px 0', display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, minmax(0, 1fr))' : 'repeat(4, minmax(0, 1fr))', gap: 12 }}>
        {([
          ['Revenue', loading ? '…' : money0(totals.revenueCents), 'var(--tms-text)'],
          ['Expense', loading ? '…' : money0(totals.expenseCents), 'var(--tms-text)'],
          ['Profit', loading ? '…' : money0(totals.profitCents), netColor(totals.profitCents)],
          ['Profit %', loading ? '…' : pct(totals.marginBps), netColor(totals.profitCents)],
        ] as const).map(([label, value, color]) => (
          <div key={label}>
            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--tms-muted)' }}>{label}</div>
            <div data-testid={`brokerage-total-${label.toLowerCase().replace(' %', '-pct')}`} style={{ fontSize: 24, fontWeight: 700, color, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em' }}>{value}</div>
          </div>
        ))}
      </div>

      <div style={{ padding: '10px 12px 0' }}>
        <ResponsiveContainer width="100%" height={isMobile ? 220 : 240}>
          <ComposedChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 0 }} barGap={2} barCategoryGap="26%">
            <CartesianGrid stroke="var(--tms-chart-grid)" strokeDasharray="3 4" vertical={false} />
            <XAxis dataKey="month" tick={{ fill: 'var(--tms-chart-axis)', fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis yAxisId="usd" tickFormatter={(v) => moneyK(Number(v) * 100)} tick={{ fill: 'var(--tms-chart-axis)', fontSize: 11 }} axisLine={false} tickLine={false} width={48} />
            <YAxis yAxisId="pct" orientation="right" tickFormatter={(v) => `${v}%`} tick={{ fill: 'var(--tms-chart-axis)', fontSize: 11 }} axisLine={false} tickLine={false} width={40} />
            <ReferenceLine yAxisId="usd" y={0} stroke="var(--tms-chart-9)" />
            <Tooltip
              formatter={(value, name) => [name === 'Profit %' ? (value == null ? '—' : `${Number(value).toFixed(1)}%`) : money0(Number(value) * 100), String(name)]}
              labelFormatter={(l, p) => `${l}${(p?.[0]?.payload as { partial?: boolean } | undefined)?.partial ? ' (to date)' : ''}`}
              contentStyle={{ background: 'var(--tms-card)', color: 'var(--tms-text)', border: '1px solid var(--tms-border)', borderRadius: 8, fontSize: 12, boxShadow: 'var(--tms-shadow-pop)' }}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} iconType="square" iconSize={8} />
            <Bar yAxisId="usd" dataKey="revenue" name="Revenue" fill={COLORS.revenue} radius={[2, 2, 0, 0]} />
            <Bar yAxisId="usd" dataKey="expense" name="Expense" fill={COLORS.expense} radius={[2, 2, 0, 0]} />
            <Line yAxisId="pct" type="monotone" dataKey="margin" name="Profit %" stroke={COLORS.margin} strokeWidth={2} dot={{ r: 3 }} connectNulls={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div style={{ overflowX: 'auto', padding: '4px 10px 12px' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }} data-testid="brokerage-month-table">
          <thead>
            <tr style={{ borderBottom: '1px solid var(--tms-border)' }}>
              <th style={{ ...th, textAlign: 'left' }}>Month</th><th style={th}>Loads</th><th style={th}>Revenue</th><th style={th}>Expense</th><th style={th}>Profit</th><th style={th}>Profit %</th>
            </tr>
          </thead>
          <tbody>
            {[...rows].reverse().map((r) => (
              <tr key={r.month} style={{ borderBottom: '1px solid var(--tms-border)' }}>
                <td style={{ ...td, textAlign: 'left' }}>{monthLabel(r.month)}{r.month === current ? ' (to date)' : ''}</td>
                <td style={td}>{r.loads}</td>
                <td style={td}>{money0(r.revenueCents)}</td>
                <td style={td}>{money0(r.expenseCents)}</td>
                <td style={{ ...td, color: netColor(r.profitCents), fontWeight: 600 }}>{money0(r.profitCents)}</td>
                <td style={td}>{pct(r.marginBps)}</td>
              </tr>
            ))}
            <tr data-testid="brokerage-month-total" style={{ background: 'var(--tms-bg)' }}>
              <td style={{ ...td, textAlign: 'left', fontWeight: 700 }}>Total</td>
              <td style={{ ...td, fontWeight: 700 }}>{totals.loads}</td>
              <td style={{ ...td, fontWeight: 700 }}>{money0(totals.revenueCents)}</td>
              <td style={{ ...td, fontWeight: 700 }}>{money0(totals.expenseCents)}</td>
              <td style={{ ...td, fontWeight: 700, color: netColor(totals.profitCents) }}>{money0(totals.profitCents)}</td>
              <td style={{ ...td, fontWeight: 700 }}>{pct(totals.marginBps)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}
