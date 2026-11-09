import { useMemo, useState } from 'react'
import { monthRows, monthRowsFromRep, monthsBetween, repRows, trailingMonths } from '@/lib/brokerageRevenue'
import { TZ } from '@/lib/date'
import { BrokerageMonthWidget } from './BrokerageMonthWidget'
import { BrokerageRepWidget } from './BrokerageRepWidget'
import { RangePicker, type Preset } from './BrokerageRangePicker'
import { clampRange, previousMonth, type MonthRange } from './brokerageFormat'
import { useBrokerageDashboard } from './useBrokerageDashboard'

const MONTH_PRESETS: Preset[] = [
  { key: '13', label: '12 months + this', range: (c) => ({ from: trailingMonths(c, 13)[0], to: c }) },
  { key: '6', label: '6 months', range: (c) => ({ from: trailingMonths(c, 6)[0], to: c }) },
  { key: 'ytd', label: 'Year to date', range: (c) => ({ from: `${c.slice(0, 4)}-01`, to: c }) },
]
const REP_PRESETS: Preset[] = [
  { key: 'this', label: 'This month', range: (c) => ({ from: c, to: c }) },
  { key: 'last', label: 'Last month', range: (c) => ({ from: previousMonth(c), to: previousMonth(c) }) },
  { key: 'q', label: 'Last 3 months', range: (c) => ({ from: trailingMonths(c, 3)[0], to: c }) },
  { key: 'ytd', label: 'Year to date', range: (c) => ({ from: `${c.slice(0, 4)}-01`, to: c }) },
]

const asOfLabel = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ })

/**
 * Brokerage (BCAT Logistics) revenue, expense, profit and profit % by month and by sales rep, as cards under the main
 * Dashboard (not a page of its own). Same page grant as the Dashboard (`dashboard`); figures read from the
 * DashboardRollup rows the other dashboards read.
 */
export function BrokerageSection() {
  const current = new Date().toISOString().slice(0, 7)
  const [monthRange, setMonthRange] = useState<MonthRange>(() => clampRange(MONTH_PRESETS[0].range(current), current))
  const [repRange, setRepRange] = useState<MonthRange>(() => clampRange(REP_PRESETS[1].range(current), current))

  const from = monthRange.from < repRange.from ? monthRange.from : repRange.from
  const to = monthRange.to > repRange.to ? monthRange.to : repRange.to
  const data = useBrokerageDashboard(from, to)

  const monthList = useMemo(() => monthsBetween(monthRange.from, monthRange.to), [monthRange])
  const repMonths = useMemo(() => monthsBetween(repRange.from, repRange.to), [repRange])
  // Company callers: the month view is the rollup's day rows. A rep caller never reads those (they are company
  // totals): their month view is summed from their own rep rows.
  const own = data.scope === 'OWN'
  const byMonth = useMemo(
    () => (own ? monthRowsFromRep(data.repMonths, monthList, data.divisions) : monthRows(data.rows, monthList, data.divisions)),
    [own, data.rows, data.repMonths, data.divisions, monthList],
  )
  const repMonthRows = useMemo(
    () => (own ? monthRowsFromRep(data.repMonths, repMonths, data.divisions) : monthRows(data.rows, repMonths, data.divisions)),
    [own, data.rows, data.repMonths, data.divisions, repMonths],
  )
  const byRep = useMemo(() => repRows(data.repMonths, repMonths, data.divisions, data.names), [data.repMonths, data.divisions, data.names, repMonths])
  // A month the rollup holds but whose per-rep object is not written yet (before the first recompute after deploy).
  const repReady = own || repMonths.every((m) => !data.rows.some((r) => r.payload.month === m) || data.repMonths.some((r) => r.month === m))

  return (
    <section aria-label="Brokerage" data-testid="brokerage-section">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--tms-text)' }}>Brokerage</h2>
          <span style={{ fontSize: 12.5, color: 'var(--tms-muted)' }}>
            {`BCAT Logistics${own ? ' · your loads' : ''}${data.asOf ? ` · as of ${asOfLabel(data.asOf)}` : ''}`}
          </span>
        </div>
        <details className="tms-card" data-testid="brokerage-help" style={{ padding: '10px 16px', fontSize: 12.5, color: 'var(--tms-text-2)' }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600, color: 'var(--tms-text)' }}>How these figures are counted</summary>
          <ul style={{ margin: '8px 0 0', paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <li><b>Scope:</b> shipments whose revenue division is Brokerage (BCAT Logistics) and any division under it. Ivan Cartage, its subsidiaries and untagged shipments are not here. Voided and canceled shipments, and loads whose carrier was TONU'd, are not counted.</li>
            <li><b>Month:</b> the month a load was delivered (its delivery appointment, else the day it was marked delivered), the same date the Company strips and the lane history use. A load is counted once it is delivered and priced.</li>
            <li><b>Revenue:</b> what the customer is charged for the load (the sum of its customer charge lines: line haul, fuel and accessorials), the same figure the TMS revenue and margin cards use.</li>
            <li><b>Expense:</b> what the carrier charges us for the load (the sum of its carrier charge lines: carrier rate and carrier accessorials), the same cost those margin cards use.</li>
            <li><b>Profit</b> = revenue − expense. <b>Profit %</b> = profit ÷ revenue; a month or rep with no revenue shows a dash.</li>
            <li><b>Sales rep:</b> the rep on the load or shipment (profile name, group reps such as Ivan Cartage, BCAT and Owner Operators as their own rows, or the typed rep name when there is no login). Loads with no rep are the &quot;No sales rep&quot; row, so the rep total equals the month total.</li>
            <li>Figures come from the dashboard rollup and are recomputed within minutes of a change; they are not a general-ledger close (an uninvoiced load counts at its customer rate, and a later invoice adjustment moves it).</li>
          </ul>
        </details>

        {data.state === 'unavailable' && (
          <div role="status" data-testid="brokerage-unavailable" className="tms-card" style={{ padding: 16, fontSize: 13, color: 'var(--tms-badge-orange)' }}>
            The dashboard rollup is not ready for these months (a month is missing or still being recomputed). Try again in a few minutes.
          </div>
        )}
        {data.state === 'error' && (
          <div role="alert" className="tms-card" style={{ padding: 16, fontSize: 13, color: 'var(--tms-badge-red)' }}>The Brokerage figures could not be loaded.</div>
        )}

        {data.state !== 'unavailable' && data.state !== 'error' && (
          <>
            <section aria-label="By month" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--tms-text)' }}>By month</h2>
                <RangePicker label="Month view" range={monthRange} current={current} presets={MONTH_PRESETS} onChange={setMonthRange} />
              </div>
              <BrokerageMonthWidget rows={byMonth} current={current} state={data.state === 'loading' ? 'loading' : 'ready'} />
            </section>

            <section aria-label="By sales rep" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--tms-text)' }}>By sales rep</h2>
                <RangePicker label="Rep view" range={repRange} current={current} presets={REP_PRESETS} onChange={setRepRange} />
              </div>
              {data.state === 'loading'
                ? <div className="tms-card" aria-busy="true" style={{ minHeight: 160 }} />
                : <BrokerageRepWidget rows={byRep} monthRows={repMonthRows} ready={repReady} />}
            </section>
          </>
        )}
      </div>
    </section>
  )
}
