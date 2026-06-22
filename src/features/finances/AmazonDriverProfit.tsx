import { useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useAmazonProfitability, aggregateAmazon } from '@/hooks/useAmazonProfitability'
import { sundayOf, shiftWeek, weekLabel } from '@/features/driver-pay/week'

const money = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n)

const TH: React.CSSProperties = { fontSize: 10.5, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em', padding: '8px 12px', textAlign: 'right', whiteSpace: 'nowrap' }
const TD: React.CSSProperties = { fontSize: 13, color: 'var(--ds-t1)', padding: '9px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }
const navBtn: React.CSSProperties = { width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 7, cursor: 'pointer', color: 'var(--ds-t2)' }

function Kpi({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ padding: '12px 18px', background: 'var(--ds-surface)' }}>
      <div style={{ fontSize: 11, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, marginTop: 3, color: color ?? 'var(--ds-t1)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  )
}

/**
 * Amazon driver profitability for one pay week — gross, expenses, driver pay and
 * profit to the company per driver. Steps week-by-week (Sunday→Saturday). Rendered
 * inside the Weekly Profitability card's Amazon tab.
 */
export function AmazonProfitPanel() {
  const { rows, loading } = useAmazonProfitability()
  const [weekOffset, setWeekOffset] = useState(0)
  const weekStart = shiftWeek(sundayOf(), -weekOffset)
  const agg = aggregateAmazon(rows, weekStart, weekStart)
  const wr = [...agg.rows].sort((a, b) => a.driverName.localeCompare(b.driverName))

  return (
    <>
      {/* Week stepper */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4, padding: '10px 18px', borderBottom: '1px solid var(--ds-border)' }}>
        <button onClick={() => setWeekOffset((o) => o + 1)} style={navBtn} aria-label="Previous week"><ChevronLeft size={15} /></button>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ds-t2)', minWidth: 130, textAlign: 'center' }}>
          {weekOffset === 0 ? 'This week' : weekLabel(weekStart)}
        </span>
        <button onClick={() => setWeekOffset((o) => Math.max(0, o - 1))} disabled={weekOffset === 0} style={{ ...navBtn, opacity: weekOffset === 0 ? 0.4 : 1 }} aria-label="Next week"><ChevronRight size={15} /></button>
      </div>

      {/* Roll-up for the week */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 1, background: 'var(--ds-border)', borderBottom: '1px solid var(--ds-border)' }}>
        <Kpi label="Gross" value={money(agg.revenue)} />
        <Kpi label="Expenses" value={money(agg.expenses)} />
        <Kpi label="Driver pay" value={money(agg.driverPay)} />
        <Kpi label="Profit to company" value={money(agg.profit)} color={agg.profit >= 0 ? '#15803d' : '#dc2626'} />
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--ds-border)' }}>
              <th style={{ ...TH, textAlign: 'left' }}>Driver</th>
              <th style={TH}>Gross</th>
              <th style={TH}>Expenses</th>
              <th style={TH}>Driver pay</th>
              <th style={TH}>Profit to company</th>
            </tr>
          </thead>
          <tbody>
            {loading && wr.length === 0 && (
              <tr><td colSpan={5} style={{ ...TD, textAlign: 'center', color: 'var(--ds-t3)', padding: '24px' }}>Loading…</td></tr>
            )}
            {!loading && wr.length === 0 && (
              <tr><td colSpan={5} style={{ ...TD, textAlign: 'center', color: 'var(--ds-t3)', padding: '24px' }}>No Amazon driver pay this week.</td></tr>
            )}
            {wr.map((r) => (
              <tr key={r.driverId} style={{ borderBottom: '1px solid var(--ds-border)' }}>
                <td style={{ ...TD, textAlign: 'left' }}>{r.driverName}</td>
                <td style={TD}>{money(r.gross)}</td>
                <td style={{ ...TD, color: 'var(--ds-t2)' }}>{money(r.expenses)}</td>
                <td style={{ ...TD, color: 'var(--ds-t2)' }}>{money(r.driverPay)}</td>
                <td style={{ ...TD, fontWeight: 600, color: r.profit >= 0 ? '#15803d' : '#dc2626' }}>{money(r.profit)}</td>
              </tr>
            ))}
            {wr.length > 0 && (
              <tr style={{ borderTop: '2px solid var(--ds-border)', background: 'var(--ds-bg)' }}>
                <td style={{ ...TD, textAlign: 'left', fontWeight: 700 }}>Total</td>
                <td style={{ ...TD, fontWeight: 700 }}>{money(agg.revenue)}</td>
                <td style={{ ...TD, fontWeight: 700 }}>{money(agg.expenses)}</td>
                <td style={{ ...TD, fontWeight: 700 }}>{money(agg.driverPay)}</td>
                <td style={{ ...TD, fontWeight: 700, color: agg.profit >= 0 ? '#15803d' : '#dc2626' }}>{money(agg.profit)}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}
