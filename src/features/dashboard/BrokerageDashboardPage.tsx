import { useMemo, useState } from 'react'
import { monthRows, monthRowsFromRep, monthRowsThroughDay, monthsBetween, repMonthMatrix, trailingMonths } from '@/lib/brokerageRevenue'
import { TZ, chicagoDateStr } from '@/lib/date'
import { BrokerageOverview } from './BrokerageOverview'
import { BrokerageRepChart } from './BrokerageRepChart'
import { BrokerageRepWidget } from './BrokerageRepWidget'
import { brokerageInsights, type SamePeriod } from './brokerageInsights'
import { FIRST_MONTH, clampRange, previousMonth, type MonthRange } from './brokerageFormat'
import { useBrokerageDashboard } from './useBrokerageDashboard'

interface Preset { key: string; label: string; range: (current: string) => MonthRange }
const PRESETS: Preset[] = [
  { key: '3', label: '3 months', range: (c) => ({ from: trailingMonths(c, 3)[0], to: c }) },
  { key: '6', label: '6 months', range: (c) => ({ from: trailingMonths(c, 6)[0], to: c }) },
  { key: '12', label: '12 months', range: (c) => ({ from: trailingMonths(c, 12)[0], to: c }) },
  { key: 'ytd', label: 'Year to date', range: (c) => ({ from: `${c.slice(0, 4)}-01`, to: c }) },
]

const asOfLabel = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ })

/**
 * Brokerage (BCAT Logistics) at a glance, as a section under the main Dashboard (not a page of its own): headline
 * figures, revenue and profit by month, a few plain-English takeaways and who earns what by sales rep. The finer
 * month-by-rep table is one click away. Same page grant as the Dashboard (`dashboard`); figures read from the
 * DashboardRollup rows the other dashboards read.
 */
export function BrokerageSection() {
  // Chicago's month and day (not UTC's): the month in progress and the day it has reached decide what last month is read against.
  const today = chicagoDateStr(new Date())
  const current = today.slice(0, 7)
  const throughDay = Number(today.slice(8, 10))
  const [presetKey, setPresetKey] = useState('6')
  const preset = PRESETS.find((p) => p.key === presetKey) ?? PRESETS[1]
  const range = useMemo(() => clampRange(preset.range(current), current), [preset, current])
  const data = useBrokerageDashboard(range.from, range.to)

  const months = useMemo(() => monthsBetween(range.from, range.to), [range])
  // Company callers: the month view is the rollup's day rows. A rep caller never reads those (they are company
  // totals): their month view is summed from their own rep rows.
  const own = data.scope === 'OWN'
  const byMonth = useMemo(
    () => (own ? monthRowsFromRep(data.repMonths, months, data.divisions) : monthRows(data.rows, months, data.divisions)),
    [own, data.rows, data.repMonths, data.divisions, months],
  )
  // A month the rollup holds but whose per-rep object is not written yet (before the first recompute after deploy).
  const repReady = own || months.every((m) => !data.rows.some((r) => r.payload.month === m) || data.repMonths.some((r) => r.month === m))
  const brokerageMatrix = useMemo(
    () => repMonthMatrix(data.repMonths, months, data.divisions, data.names, 'BROKERAGE'),
    [data.repMonths, months, data.divisions, data.names],
  )
  // Last month's first `throughDay` days, from the company day rows. A rep caller has only month totals (no days): null.
  const same = useMemo<SamePeriod | null>(() => {
    const month = previousMonth(current)
    if (own || data.state !== 'ready' || !data.rows.some((r) => r.payload.month === month)) return null
    // A shorter last month ends on its own last day (the 30th is read against February 28th).
    const lastDay = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate()
    const through = Math.min(throughDay, lastDay)
    const [measures] = monthRowsThroughDay(data.rows, [month], data.divisions, through)
    return measures ? { month, through, measures } : null
  }, [own, data.state, data.rows, data.divisions, current, throughDay])
  const insights = useMemo(
    () => (data.state === 'ready' ? brokerageInsights(byMonth, repReady ? brokerageMatrix.reps : [], brokerageMatrix.grand, current, same) : []),
    [data.state, byMonth, repReady, brokerageMatrix, current, same],
  )

  return (
    <section aria-label="Brokerage" data-testid="brokerage-section">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--tms-text)' }}>Brokerage</h2>
            <span style={{ fontSize: 12.5, color: 'var(--tms-muted)' }}>
              {`BCAT Logistics${own ? ' · your loads' : ''}${data.asOf ? ` · as of ${asOfLabel(data.asOf)}` : ''}`}
            </span>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div role="group" aria-label="Range" style={{ display: 'flex', gap: 4, background: 'var(--tms-bg)', border: '1px solid var(--tms-border)', borderRadius: 9, padding: 3 }}>
              {PRESETS.map((p) => {
                const on = p.key === presetKey
                return (
                  <button
                    key={p.key} type="button" aria-pressed={on} onClick={() => setPresetKey(p.key)}
                    style={{
                      padding: '3px 10px', borderRadius: 7, border: 'none', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit',
                      fontWeight: on ? 600 : 500, background: on ? 'var(--tms-card)' : 'transparent', color: on ? 'var(--tms-text)' : 'var(--tms-muted)', boxShadow: on ? 'var(--tms-shadow)' : 'none',
                    }}
                  >
                    {p.label}
                  </button>
                )
              })}
            </div>
            <details data-testid="brokerage-help" style={{ position: 'relative' }}>
              <summary style={{ cursor: 'pointer', fontSize: 12.5, color: 'var(--tms-muted)', listStyle: 'none', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <span aria-hidden style={{ width: 16, height: 16, borderRadius: '50%', border: '1px solid var(--tms-border)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 10.5, fontWeight: 700 }}>i</span>
                How these figures are counted
              </summary>
              <div className="tms-card" style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 20, width: 'min(560px, 86vw)', padding: '12px 16px', fontSize: 12.5, color: 'var(--tms-text-2)', boxShadow: 'var(--tms-shadow)' }}>
                <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <li><b>Scope:</b> shipments whose revenue division is Brokerage (BCAT Logistics) and any division under it. Ivan Cartage, its subsidiaries and untagged shipments are not here. Voided and canceled shipments, and loads whose carrier was TONU'd, are not counted.</li>
                  <li><b>Month:</b> the month a load was delivered: the actual time at its last delivery stop (read in Chicago time), else its delivered date, else its delivery appointment. The lane history uses the same date. A load is counted once it is delivered and priced.</li>
                  <li><b>Revenue:</b> what the customer is charged for the load (the sum of its customer charge lines: line haul, fuel and accessorials), the same figure the TMS revenue and margin cards use.</li>
                  <li><b>Expense:</b> what the carrier charges us for the load (the sum of its carrier charge lines: carrier rate and carrier accessorials), the same cost those margin cards use.</li>
                  <li><b>The five cards at the top:</b> the month in progress, to date, with the same days of last month beside each (on the 18th, Nov 1–18 against Oct 1–18). A sales rep, who sees only their own month totals, sees last month in full instead. They do not change with the 3 / 6 / 12 months / Year to date buttons; those set the chart, the takeaways and the table below.</li>
                  <li><b>Profit</b> = revenue − expense. <b>Profit margin</b> = profit ÷ revenue; a month or rep with no revenue shows a dash.</li>
                  <li><b>By sales rep:</b> the rep on the load or shipment (profile name, group reps such as Ivan Cartage, BCAT and Owner Operators as their own rows, or the typed rep name when there is no login). Loads with no rep are the &quot;No sales rep&quot; row, so the rep total equals the month total. The Division switch re-cuts the same loads by revenue division (Brokerage includes anything under it).</li>
                  <li><b>Table at the bottom:</b> every rep by month, with the change from the month before. The month in progress is shown to date with no change. Expenses are never colored as good or bad.</li>
                  <li>Figures come from the dashboard rollup and are recomputed within minutes of a change; they are not a general-ledger close (an uninvoiced load counts at its customer rate, and a later invoice adjustment moves it).</li>
                </ul>
              </div>
            </details>
          </div>
        </div>

        {range.from <= FIRST_MONTH && (
          <div data-testid="brokerage-data-start" style={{ fontSize: 12, color: 'var(--tms-muted)' }}>Data starts October 2026</div>
        )}

        {data.state === 'unavailable' && (
          <div role="status" data-testid="brokerage-unavailable" className="tms-card" style={{ padding: '10px 14px', fontSize: 12.5, color: 'var(--tms-text-2)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <span>Brokerage figures are still being recomputed for these months.</span>
            <button type="button" onClick={data.retry} style={{ padding: '4px 12px', borderRadius: 7, border: '1px solid var(--tms-border)', background: 'var(--tms-bg)', color: 'var(--tms-text)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>Retry</button>
          </div>
        )}
        {data.state === 'error' && (
          <div role="alert" className="tms-card" style={{ padding: 16, fontSize: 13, color: 'var(--tms-badge-red)' }}>The Brokerage figures could not be loaded.</div>
        )}

        {data.state !== 'unavailable' && data.state !== 'error' && (
          <>
            <BrokerageOverview rows={byMonth} current={current} loading={data.state === 'loading'} insights={insights} same={same} />

            <section aria-label="By sales rep" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--tms-text)' }}>Who earns what</h3>
              {data.state === 'loading'
                ? <div className="tms-card" aria-busy="true" style={{ minHeight: 160 }} />
                : <BrokerageRepChart repMonths={data.repMonths} divisions={data.divisions} names={data.names} months={months} current={current} ready={repReady} own={own} />}
            </section>

            {data.state === 'ready' && repReady && (
              <details data-testid="brokerage-table-details">
                <summary style={{ cursor: 'pointer', fontSize: 12.5, color: 'var(--tms-muted)', padding: '2px 0' }}>Show the full table by rep and month</summary>
                <div style={{ marginTop: 8 }}>
                  <BrokerageRepWidget
                    repMonths={data.repMonths} divisions={data.divisions} names={data.names} months={months}
                    monthRows={byMonth} current={current} ready={repReady} own={own} hideChart
                  />
                </div>
              </details>
            )}
          </>
        )}
      </div>
    </section>
  )
}
