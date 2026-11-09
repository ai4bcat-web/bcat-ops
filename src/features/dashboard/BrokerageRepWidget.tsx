import { useMemo } from 'react'
import { totalsOf, tieOut, type Measures, type RepMeasures } from '@/lib/brokerageRevenue'
import { money0, netColor, pct } from './brokerageFormat'

const th = { textAlign: 'right', padding: '6px 10px', fontSize: 11, fontWeight: 600, color: 'var(--tms-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' } as const
const td = { textAlign: 'right', padding: '6px 10px', fontSize: 12.5, fontVariantNumeric: 'tabular-nums', color: 'var(--tms-text)' } as const

/**
 * Brokerage revenue, expense, profit and profit % per sales rep for the chosen months. Group reps (Ivan Cartage,
 * BCAT, Owner Operators) are rows like any other; "No sales rep" is its own row, so the total ties to the month view.
 */
export function BrokerageRepWidget({ rows, monthRows, ready }: {
  rows: RepMeasures[]
  /** The month view's rows for the same months, for the tie-out line. */
  monthRows: Measures[]
  /** False until every month row carries the rep split (older rows are recomputed by the rollup). */
  ready: boolean
}) {
  const totals = useMemo(() => totalsOf(rows), [rows])
  const tie = useMemo(() => tieOut(monthRows, rows), [monthRows, rows])
  const top = rows.reduce((m, r) => Math.max(m, r.revenueCents), 0)

  if (!ready) {
    return (
      <div className="tms-card" data-testid="brokerage-rep-widget" style={{ padding: 20, fontSize: 13, color: 'var(--tms-muted)' }}>
        The sales-rep split is not ready for these months yet. It fills in as each month is recomputed; the month view above is already complete.
      </div>
    )
  }

  return (
    <div className="tms-card" data-testid="brokerage-rep-widget">
      <div style={{ overflowX: 'auto', padding: '8px 10px 12px' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }} data-testid="brokerage-rep-table">
          <thead>
            <tr style={{ borderBottom: '1px solid var(--tms-border)' }}>
              <th style={{ ...th, textAlign: 'left' }}>Sales rep</th><th style={th}>Loads</th><th style={th}>Revenue</th><th style={th}>Expense</th><th style={th}>Profit</th><th style={th}>Profit %</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.repKey || 'none'} data-testid={r.repKey === '' ? 'brokerage-rep-none' : 'brokerage-rep-row'} style={{ borderBottom: '1px solid var(--tms-border)' }}>
                <td style={{ ...td, textAlign: 'left', position: 'relative', fontStyle: r.repKey === '' ? 'italic' : undefined }}>
                  <span aria-hidden style={{ position: 'absolute', left: 0, top: 3, bottom: 3, width: `${top > 0 ? Math.max(0, (r.revenueCents / top) * 100) : 0}%`, background: 'var(--tms-chart-5)', opacity: 0.12, borderRadius: 3 }} />
                  <span style={{ position: 'relative' }}>{r.label}</span>
                </td>
                <td style={td}>{r.loads}</td>
                <td style={td}>{money0(r.revenueCents)}</td>
                <td style={td}>{money0(r.expenseCents)}</td>
                <td style={{ ...td, color: netColor(r.profitCents), fontWeight: 600 }}>{money0(r.profitCents)}</td>
                <td style={td}>{pct(r.marginBps)}</td>
              </tr>
            ))}
            <tr data-testid="brokerage-rep-total" style={{ background: 'var(--tms-bg)' }}>
              <td style={{ ...td, textAlign: 'left', fontWeight: 700 }}>Total</td>
              <td style={{ ...td, fontWeight: 700 }}>{totals.loads}</td>
              <td style={{ ...td, fontWeight: 700 }}>{money0(totals.revenueCents)}</td>
              <td style={{ ...td, fontWeight: 700 }}>{money0(totals.expenseCents)}</td>
              <td style={{ ...td, fontWeight: 700, color: netColor(totals.profitCents) }}>{money0(totals.profitCents)}</td>
              <td style={{ ...td, fontWeight: 700 }}>{pct(totals.marginBps)}</td>
            </tr>
          </tbody>
        </table>
        <div data-testid="brokerage-tie" data-ok={tie.ok} style={{ marginTop: 8, fontSize: 11.5, color: tie.ok ? 'var(--tms-muted)' : 'var(--tms-badge-red)' }}>
          {tie.ok
            ? 'Rep total equals the month view total for the same months.'
            : `Rep total differs from the month view by ${money0(tie.revenueDiffCents)} revenue / ${money0(tie.expenseDiffCents)} expense (${tie.loadsDiff} loads).`}
        </div>
      </div>
    </div>
  )
}
