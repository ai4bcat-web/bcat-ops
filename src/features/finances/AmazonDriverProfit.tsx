import { Fragment } from 'react'
import { Truck } from 'lucide-react'
import { useAmazonProfitability, type DriverWeekProfit } from '@/hooks/useAmazonProfitability'
import { weekLabelLong } from '@/features/driver-pay/week'

const money = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n)

const TH: React.CSSProperties = { fontSize: 10.5, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em', padding: '8px 12px', textAlign: 'right', whiteSpace: 'nowrap' }
const TD: React.CSSProperties = { fontSize: 13, color: 'var(--ds-t1)', padding: '9px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }

function sum(rows: DriverWeekProfit[], key: 'gross' | 'expenses' | 'driverPay' | 'profit'): number {
  return rows.reduce((s, r) => s + r[key], 0)
}

/**
 * Amazon Driver Profitability — per driver, per week: the gross they generated, the
 * expenses, and the resulting profit to the company.
 */
export function AmazonDriverProfit() {
  const { rows, weeks, loading } = useAmazonProfitability()

  const grandProfit = sum(rows, 'profit')

  return (
    <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--ds-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Truck size={16} style={{ color: 'var(--ds-blue)' }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>Amazon driver profitability</div>
            <div style={{ fontSize: 12, color: 'var(--ds-t3)' }}>What each driver generates for the company, by week</div>
          </div>
        </div>
        {rows.length > 0 && (
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 10.5, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Total profit to company</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: grandProfit >= 0 ? '#15803d' : '#dc2626', fontVariantNumeric: 'tabular-nums' }}>{money(grandProfit)}</div>
          </div>
        )}
      </div>

      {loading && rows.length === 0 ? (
        <div style={{ padding: '28px 0', textAlign: 'center', fontSize: 13, color: 'var(--ds-t3)' }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ padding: '28px 0', textAlign: 'center', fontSize: 13, color: 'var(--ds-t3)' }}>No Amazon driver pay recorded yet.</div>
      ) : (
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
              {weeks.map((week) => {
                const wr = rows.filter((r) => r.periodStart === week)
                return (
                  <Fragment key={week}>
                    <tr style={{ background: 'var(--ds-bg)', borderBottom: '1px solid var(--ds-border)' }}>
                      <td colSpan={5} style={{ ...TD, textAlign: 'left', fontSize: 11.5, fontWeight: 700, color: 'var(--ds-t2)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                        {weekLabelLong(week)}
                      </td>
                    </tr>
                    {wr.map((r) => (
                      <tr key={`${week}-${r.driverId}`} style={{ borderBottom: '1px solid var(--ds-border)' }}>
                        <td style={{ ...TD, textAlign: 'left' }}>{r.driverName}</td>
                        <td style={TD}>{money(r.gross)}</td>
                        <td style={{ ...TD, color: 'var(--ds-t2)' }}>{money(r.expenses)}</td>
                        <td style={{ ...TD, color: 'var(--ds-t2)' }}>{money(r.driverPay)}</td>
                        <td style={{ ...TD, fontWeight: 600, color: r.profit >= 0 ? '#15803d' : '#dc2626' }}>{money(r.profit)}</td>
                      </tr>
                    ))}
                    <tr style={{ borderBottom: '2px solid var(--ds-border)', background: 'var(--ds-bg)' }}>
                      <td style={{ ...TD, textAlign: 'left', fontWeight: 700 }}>Week total</td>
                      <td style={{ ...TD, fontWeight: 700 }}>{money(sum(wr, 'gross'))}</td>
                      <td style={{ ...TD, fontWeight: 700 }}>{money(sum(wr, 'expenses'))}</td>
                      <td style={{ ...TD, fontWeight: 700 }}>{money(sum(wr, 'driverPay'))}</td>
                      <td style={{ ...TD, fontWeight: 700, color: sum(wr, 'profit') >= 0 ? '#15803d' : '#dc2626' }}>{money(sum(wr, 'profit'))}</td>
                    </tr>
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
