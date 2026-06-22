import { Fragment } from 'react'
import { useAmazonProfitability, type DriverWeekProfit } from '@/hooks/useAmazonProfitability'
import { weekLabelLong } from '@/features/driver-pay/week'

const money = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n)

const TH: React.CSSProperties = { fontSize: 10.5, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em', padding: '8px 12px', textAlign: 'right', whiteSpace: 'nowrap' }
const TD: React.CSSProperties = { fontSize: 13, color: 'var(--ds-t1)', padding: '9px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }

function sum(rows: DriverWeekProfit[], key: 'gross' | 'expenses' | 'driverPay' | 'profit'): number {
  return rows.reduce((s, r) => s + r[key], 0)
}

function Kpi({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ padding: '12px 18px', background: 'var(--ds-surface)' }}>
      <div style={{ fontSize: 11, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, marginTop: 3, color: color ?? 'var(--ds-t1)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  )
}

/**
 * Amazon driver profitability — per driver, per week: the gross they generated, the
 * expenses, the driver's pay, and the resulting profit to the company. Rendered inside
 * the Weekly Profitability card's Amazon tab (no card chrome of its own).
 */
export function AmazonProfitPanel() {
  const { rows, weeks, loading } = useAmazonProfitability()
  const totalProfit = sum(rows, 'profit')

  if (loading && rows.length === 0) {
    return <div style={{ padding: '28px 0', textAlign: 'center', fontSize: 13, color: 'var(--ds-t3)' }}>Loading…</div>
  }
  if (rows.length === 0) {
    return <div style={{ padding: '28px 18px', textAlign: 'center', fontSize: 13, color: 'var(--ds-t3)' }}>No Amazon driver pay recorded yet. Import trips on the Driver Pay page to see profitability here.</div>
  }

  return (
    <>
      {/* Roll-up across all weeks */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 1, background: 'var(--ds-border)', borderBottom: '1px solid var(--ds-border)' }}>
        <Kpi label="Gross" value={money(sum(rows, 'gross'))} />
        <Kpi label="Expenses" value={money(sum(rows, 'expenses'))} />
        <Kpi label="Driver pay" value={money(sum(rows, 'driverPay'))} />
        <Kpi label="Profit to company" value={money(totalProfit)} color={totalProfit >= 0 ? '#15803d' : '#dc2626'} />
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
    </>
  )
}
