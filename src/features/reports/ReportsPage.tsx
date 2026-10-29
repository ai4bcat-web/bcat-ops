/**
 * Reports — the numbers the office is allowed to quote (spec §3.9; `I-plan.md`
 * "Reporting"), as the Reports tab of My Brokerage.
 *
 * Six panels over one period: profit cut however you ask for it, the board's pipeline,
 * both sides of the ledger, the quote funnel and what the reps are owed. It is not a
 * chart builder — each panel answers one question an office actually asks, and every
 * figure on the page comes out of a lib (`@/lib/reporting`, `@/lib/arAging`,
 * `@/lib/customerCredit`) over real rows. Nothing here does arithmetic of its own.
 *
 * Two honesty rules run through all of it:
 *
 * - A panel with nothing in it says so. Printing `$0.00` over an empty window reads as
 *   "we made nothing", when the truth is "nothing was read".
 * - Own-fleet loads carry revenue here but no cost — their cost is driver settlements and
 *   fleet expenses — so their margin is flagged, never quietly averaged in. Own-fleet
 *   profitability lives on `/finances`, which runs over trips and expenses instead.
 *
 * Reads are memoised per month in `@/lib/reportsClient`, so switching tabs and re-cutting
 * the table costs nothing, and a month that fails is named rather than silently missing.
 *
 * Step R re-skinned it onto the MVMNT kit; `BrokeragePage` owns the h1, so this is a body.
 */
import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Download, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { RepPicker } from '@/components/RepPicker'
import { TmsBadge, TmsButton, TmsCard, TmsField, TmsSelect, TmsTabs } from '@/features/tms/kit'
import { useArWorklist } from '@/hooks/useArWorklist'
import { useDirectory } from '@/hooks/useDirectory'
import { useOpenBills } from '@/hooks/useOpenBills'
import { useOpenInvoices } from '@/hooks/useOpenInvoices'
import { useShipments } from '@/hooks/useShipments'
import { useStaff } from '@/hooks/useStaff'
import { getTmsSettings, graphqlErrorText } from '@/lib/apiClient'
import {
  AGING_BUCKETS, AGING_BUCKET_LABEL, apAgingCsv, avgDaysToInvoice, avgDaysToPay, deliveredNotInvoiced,
} from '@/lib/arAging'
import { creditSummaryForCustomer } from '@/lib/customerCredit'
import { chicagoDateStr } from '@/lib/date'
import { saveBlob } from '@/lib/download'
import {
  commissionReport, pipelineCounts, profitReport, quoteFunnel, reportCsv,
} from '@/lib/reporting'
import {
  clearReportCache, loadCommissions, loadInvoices, loadQuotes, loadReportBundle,
  type FailedMonth, type MonthlyRead,
} from '@/lib/reportsClient'
import { displayName } from '@/lib/roles'
import { AgingStrip } from '@/features/ar/AgingStrip'
import { AP_STRIP_LABELS } from '@/features/ar/agingStripLabels'
import { monthLabel } from '@/features/ar/arViews'
import {
  GROUP_BY_OPTIONS, REPORT_TABS, defaultRange, filterOptionsFrom, formatMarginBps, formatMoneyCents, formatPerMile,
  monthChoices, ownFleetNote, type ReportTabKey,
} from './reportViews'
import type {
  LaneRateSampleRecord, OrderRecord, ReportFilters, ReportGroupBy, ShipmentRecord, TmsSettings,
} from '@/types/tms'

/** Numbers read down a column, so they are right-aligned and tabular. */
const NUM: CSSProperties = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
const STACK: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 16 }
const TILE: CSSProperties = {
  border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)', padding: '8px 12px',
}

/** The report period: two `'YYYY-MM'` ends, inclusive. */
interface ReportPeriod {
  from: string
  to: string
}

const EMPTY_FILTERS: ReportFilters = {}

/* ── Shared pieces ───────────────────────────────────────────────────────── */

/** One row of figures. A cell with no answer passes `—`; nothing here invents a zero. */
function FigureStrip({ label, cells }: { label: string; cells: { label: string; value: string; hint?: string }[] }) {
  return (
    <dl aria-label={label} className="tms-grid tms-grid-4" style={{ margin: 0 }}>
      {cells.map((c) => (
        <div key={c.label} style={TILE}>
          <dt className="tms-field-label" style={{ textTransform: 'uppercase', letterSpacing: '.04em' }}>{c.label}</dt>
          <dd style={{ margin: 0, fontSize: 16, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{c.value}</dd>
          {c.hint && <p className="tms-field-hint" style={{ margin: 0 }}>{c.hint}</p>}
        </div>
      ))}
    </dl>
  )
}

function Empty({ children }: { children: string }) {
  return <p className="tms-muted" style={{ padding: '32px 0', textAlign: 'center', fontSize: 14, margin: 0 }}>{children}</p>
}

function Loading() {
  return <p className="tms-muted" style={{ margin: 0, fontSize: 14 }}>Loading…</p>
}

function Table({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="tms-table-wrap">
      <table className="tms-table" aria-label={label}>{children}</table>
    </div>
  )
}

function FailedMonths({ failed }: { failed: FailedMonth[] }) {
  if (failed.length === 0) return null
  return (
    <p
      style={{
        margin: 0, border: '1px solid var(--tms-badge-red)', borderRadius: 'var(--tms-radius)',
        padding: '8px 12px', fontSize: 14, color: 'var(--tms-badge-red)',
      }}
    >
      {failed.map((f) => `${monthLabel(f.month)}: ${f.message}`).join(' · ')} — the figures below are missing
      {failed.length === 1 ? ' that month' : ' those months'}.
    </p>
  )
}

/**
 * One window's worth of rows from a monthly index, loaded when the panel is on screen.
 *
 * The loaders memoise per month, so a tab the office keeps flicking back to re-reads
 * nothing; `refreshKey` is what the page's refresh button bumps after clearing the cache.
 */
function useWindowRows<T>(
  load: (from: string, to: string) => Promise<MonthlyRead<T>>,
  period: ReportPeriod,
  refreshKey: number,
): { rows: T[]; failedMonths: FailedMonth[]; loading: boolean } {
  const [state, setState] = useState<{ rows: T[]; failedMonths: FailedMonth[]; loading: boolean }>({
    rows: [], failedMonths: [], loading: true,
  })

  // Non-async on purpose: `react-hooks/set-state-in-effect` cannot see through an
  // `async` function, so every state write lives in an explicit promise chain.
  useEffect(() => {
    let alive = true
    load(period.from, period.to)
      .then((read) => { if (alive) setState({ rows: read.rows, failedMonths: read.failedMonths, loading: false }) })
      .catch((e: unknown) => {
        if (!alive) return
        setState({ rows: [], failedMonths: [], loading: false })
        toast.error(graphqlErrorText(e) || 'That window could not be read')
      })
    return () => { alive = false }
  }, [load, period.from, period.to, refreshKey])

  return state
}

/* ── Page ────────────────────────────────────────────────────────────────── */

export function ReportsPage() {
  // One clock for the page: the period picker, the aging buckets and the credit answers
  // all read as of the same Chicago day.
  const [asOf] = useState(() => chicagoDateStr(new Date()))
  const [tab, setTab] = useState<ReportTabKey>('profit')
  const [period, setPeriod] = useState<ReportPeriod>(() => defaultRange(asOf))
  const [refreshKey, setRefreshKey] = useState(0)

  const months = useMemo(() => monthChoices(asOf), [asOf])
  const { byId } = useStaff()
  const staffNames = useMemo(() => {
    const names: Record<string, string> = {}
    for (const [id, profile] of Object.entries(byId)) names[id] = displayName(profile)
    return names
  }, [byId])

  const refresh = () => {
    clearReportCache()
    setRefreshKey((k) => k + 1)
  }

  // `from` after `to` would silently report nothing; moving the other end with it is what
  // the office means by dragging the window.
  const setFrom = (from: string) => setPeriod((p) => ({ from, to: from > p.to ? from : p.to }))
  const setTo = (to: string) => setPeriod((p) => ({ from: to < p.from ? to : p.from, to }))

  const periodLabel = period.from === period.to
    ? monthLabel(period.to)
    : `${monthLabel(period.from)} – ${monthLabel(period.to)}`

  return (
    <div style={STACK}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 12 }}>
        <TmsBadge tone="gray">{periodLabel}</TmsBadge>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'flex-end', gap: 8 }}>
          <TmsField label="From" htmlFor="report-from">
            <TmsSelect
              id="report-from"
              aria-label="From month"
              value={period.from}
              onChange={(e) => setFrom(e.target.value)}
              style={{ width: 160 }}
            >
              {months.map((ym) => <option key={ym} value={ym}>{monthLabel(ym)}</option>)}
            </TmsSelect>
          </TmsField>
          <TmsField label="To" htmlFor="report-to">
            <TmsSelect
              id="report-to"
              aria-label="To month"
              value={period.to}
              onChange={(e) => setTo(e.target.value)}
              style={{ width: 160 }}
            >
              {months.map((ym) => <option key={ym} value={ym}>{monthLabel(ym)}</option>)}
            </TmsSelect>
          </TmsField>
          <TmsButton size="sm" aria-label="Refresh reports" onClick={refresh}>
            <RefreshCw size={14} />
          </TmsButton>
        </div>
      </div>

      <TmsTabs
        tabs={REPORT_TABS.map((t) => ({ key: t.key, label: t.label }))}
        active={tab}
        onSelect={(key) => setTab(key as ReportTabKey)}
      />

      {tab === 'profit' && <ProfitPanel period={period} staffNames={staffNames} refreshKey={refreshKey} />}
      {tab === 'pipeline' && <PipelinePanel />}
      {tab === 'ar' && <ArPanel period={period} asOf={asOf} periodLabel={periodLabel} refreshKey={refreshKey} />}
      {tab === 'ap' && <ApPanel asOf={asOf} periodLabel={periodLabel} />}
      {tab === 'quotes' && <QuotesPanel period={period} refreshKey={refreshKey} />}
      {tab === 'commissions' && (
        <CommissionsPanel period={period} staffNames={staffNames} refreshKey={refreshKey} />
      )}
    </div>
  )
}

/* ── Profit ──────────────────────────────────────────────────────────────── */

function ProfitPanel({ period, staffNames, refreshKey }: {
  period: ReportPeriod
  staffNames: Record<string, string>
  refreshKey: number
}) {
  const [groupBy, setGroupBy] = useState<ReportGroupBy>('CUSTOMER')
  const [filters, setFilters] = useState<ReportFilters>(EMPTY_FILTERS)
  const [samples, setSamples] = useState<LaneRateSampleRecord[]>([])
  const [failedMonths, setFailed] = useState<FailedMonth[]>([])
  const [loading, setLoading] = useState(true)

  // Non-async on purpose: every state write lives in the promise chain.
  useEffect(() => {
    let alive = true
    loadReportBundle(period)
      .then((bundle) => {
        if (!alive) return
        setSamples(bundle.samples)
        setFailed(bundle.failedMonths)
        setLoading(false)
      })
      .catch((e: unknown) => {
        if (!alive) return
        setSamples([])
        setLoading(false)
        toast.error(graphqlErrorText(e) || 'Those months could not be read')
      })
    return () => { alive = false }
  }, [period, refreshKey])

  const options = useMemo(() => filterOptionsFrom(samples), [samples])
  const report = useMemo(
    () => profitReport(samples, { from: period.from, to: period.to, groupBy, filters, staffNames }),
    [samples, period.from, period.to, groupBy, filters, staffNames],
  )
  // The same window cut by month, so a three-month total can be read as a trend without
  // re-grouping the table the office is looking at.
  const byMonth = useMemo(
    () => profitReport(samples, { from: period.from, to: period.to, groupBy: 'MONTH', filters, staffNames }),
    [samples, period.from, period.to, filters, staffNames],
  )

  const groupLabel = GROUP_BY_OPTIONS.find((o) => o.value === groupBy)?.label ?? 'Group'
  const note = ownFleetNote(report)
  const { totals } = report

  const setFilter = (key: keyof ReportFilters, value: string) =>
    setFilters((f) => ({ ...f, [key]: value || null }))

  const downloadCsv = () => {
    saveBlob(
      new Blob([reportCsv(report.rows, totals, groupLabel)], { type: 'text/csv' }),
      `profit-${groupBy.toLowerCase()}-${period.from}-${period.to}.csv`,
    )
  }

  return (
    <TmsCard title="Profit">
      <div style={STACK}>
        <FailedMonths failed={failedMonths} />

        <div className="tms-grid tms-grid-4">
          <TmsField label="Group by" htmlFor="report-group-by">
            <TmsSelect
              id="report-group-by"
              aria-label="Group by"
              value={groupBy}
              onChange={(e) => setGroupBy(e.target.value as ReportGroupBy)}
            >
              {GROUP_BY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </TmsSelect>
          </TmsField>
          <FilterSelect label="Division" value={filters.divisionKey} options={options.divisions} onChange={(v) => setFilter('divisionKey', v)} />
          <FilterSelect label="Team" value={filters.teamKey} options={options.teams} onChange={(v) => setFilter('teamKey', v)} />
          <FilterSelect label="Mode" value={filters.mode} options={options.modes} onChange={(v) => setFilter('mode', v)} />
          <FilterSelect label="Equipment" value={filters.equipmentType} options={options.equipment} onChange={(v) => setFilter('equipmentType', v)} />
          <FilterSelect label="Customer" value={filters.customerId} options={options.customers} onChange={(v) => setFilter('customerId', v)} />
          <FilterSelect label="Carrier" value={filters.carrierId} options={options.carriers} onChange={(v) => setFilter('carrierId', v)} />
          {/* The canonical rep control, so a report filters by the same username the
              order carries — a rep with no load in the window answers with no rows. */}
          <TmsField label="Rep">
            <RepPicker
              value={filters.repId ?? ''}
              placeholder="All"
              onChange={(v) => setFilter('repId', v)}
            />
          </TmsField>
        </div>

        {loading && <Loading />}

        {!loading && totals.loads === 0 && <Empty>No delivered loads in this window.</Empty>}

        {totals.loads > 0 && (
          <>
            <FigureStrip
              label="Profit totals"
              cells={[
                { label: 'Loads', value: String(totals.loads) },
                { label: 'Revenue', value: formatMoneyCents(totals.revenueCents) },
                { label: 'Cost', value: formatMoneyCents(totals.costCents) },
                { label: 'Profit', value: formatMoneyCents(totals.profitCents) },
                { label: 'Margin', value: formatMarginBps(totals.marginBps) },
                { label: 'RPM', value: formatPerMile(totals.rpmCents), hint: `${totals.miles} mi` },
                { label: 'CPM', value: formatPerMile(totals.cpmCents) },
              ]}
            />

            {note && (
              <p className="tms-muted" style={{ ...TILE, margin: 0, fontSize: 14 }}>
                {note}{' '}
                <Link to="/finances">Own-fleet profitability lives on Finances.</Link>
              </p>
            )}

            {report.excluded > 0 && (
              <p className="tms-field-hint" style={{ margin: 0 }}>
                {report.excluded} canceled or TONU&apos;d load{report.excluded === 1 ? '' : 's'} excluded.
              </p>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <TmsButton size="sm" aria-label="Download profit CSV" onClick={downloadCsv}>
                <Download size={14} /> CSV
              </TmsButton>
            </div>

            <Table label="Profit by group">
              <thead>
                <tr>
                  <th scope="col">{groupLabel}</th>
                  <th scope="col" style={NUM}>Loads</th>
                  <th scope="col" style={NUM}>Revenue</th>
                  <th scope="col" style={NUM}>Cost</th>
                  <th scope="col" style={NUM}>Profit</th>
                  <th scope="col" style={NUM}>Margin</th>
                  <th scope="col" style={NUM}>Miles</th>
                  <th scope="col" style={NUM}>RPM</th>
                  <th scope="col" style={NUM}>CPM</th>
                  <th scope="col" style={NUM}>Own fleet</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((row) => (
                  <tr key={row.key || row.label}>
                    <td>{row.label}</td>
                    <td style={NUM}>{row.loads}</td>
                    <td style={NUM}>{formatMoneyCents(row.revenueCents)}</td>
                    <td style={NUM}>{formatMoneyCents(row.costCents)}</td>
                    <td style={{ ...NUM, fontWeight: 500 }}>{formatMoneyCents(row.profitCents)}</td>
                    {/* An own-fleet row's cost is a settlement we have not loaded, so its
                        margin is not a margin: say so rather than print a flattering one. */}
                    <td style={NUM}>{row.ownFleet === row.loads && row.loads > 0 ? '—' : formatMarginBps(row.marginBps)}</td>
                    <td style={NUM}>{row.miles}</td>
                    <td style={NUM}>{formatPerMile(row.rpmCents)}</td>
                    <td style={NUM}>{row.ownFleet === row.loads && row.loads > 0 ? '—' : formatPerMile(row.cpmCents)}</td>
                    <td style={NUM}>{row.ownFleet || '—'}</td>
                  </tr>
                ))}
                <tr style={{ fontWeight: 500 }}>
                  <td>Total</td>
                  <td style={NUM}>{totals.loads}</td>
                  <td style={NUM}>{formatMoneyCents(totals.revenueCents)}</td>
                  <td style={NUM}>{formatMoneyCents(totals.costCents)}</td>
                  <td style={NUM}>{formatMoneyCents(totals.profitCents)}</td>
                  <td style={NUM}>{formatMarginBps(totals.marginBps)}</td>
                  <td style={NUM}>{totals.miles}</td>
                  <td style={NUM}>{formatPerMile(totals.rpmCents)}</td>
                  <td style={NUM}>{formatPerMile(totals.cpmCents)}</td>
                  <td style={NUM}>{totals.ownFleet || '—'}</td>
                </tr>
              </tbody>
            </Table>

            <section aria-label="Profit by month" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <h2 className="tms-field-label" style={{ margin: 0, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em' }}>By month</h2>
              <div className="tms-grid tms-grid-3">
                {byMonth.rows.map((row) => (
                  <div key={row.key} style={TILE}>
                    <p className="tms-field-label" style={{ margin: 0, textTransform: 'uppercase', letterSpacing: '.04em' }}>{monthLabel(row.key)}</p>
                    <p style={{ margin: 0, fontSize: 16, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{formatMoneyCents(row.profitCents)}</p>
                    <p className="tms-field-hint" style={{ margin: 0 }}>
                      {row.loads} load{row.loads === 1 ? '' : 's'} · {formatMarginBps(row.marginBps)}
                    </p>
                  </div>
                ))}
              </div>
            </section>
          </>
        )}
      </div>
    </TmsCard>
  )
}

function FilterSelect({ label, value, options, onChange }: {
  label: string
  value: string | null | undefined
  options: { value: string; label: string }[]
  onChange: (value: string) => void
}) {
  return (
    <TmsField label={label}>
      <TmsSelect
        aria-label={`Filter ${label.toLowerCase()}`}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">All</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </TmsSelect>
    </TmsField>
  )
}

/* ── Pipeline ────────────────────────────────────────────────────────────── */

function PipelinePanel() {
  const { shipments, loading, error } = useShipments()
  const counts = useMemo(() => pipelineCounts(shipments), [shipments])

  return (
    <TmsCard title="Pipeline">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p className="tms-field-hint" style={{ margin: 0 }}>
          The board as it stands right now — not the report period: a shipment sits on a rung until it moves.
        </p>
        {error && <p style={{ margin: 0, fontSize: 14, color: 'var(--tms-badge-red)' }}>{error}</p>}
        {loading && counts.length === 0 && <Loading />}
        {!loading && counts.length === 0 && <Empty>No shipments on the board.</Empty>}
        {counts.length > 0 && (
          <div className="tms-grid tms-grid-4">
            {counts.map((c) => (
              <div key={c.status} style={TILE}>
                <p className="tms-field-label" style={{ margin: 0, textTransform: 'uppercase', letterSpacing: '.04em' }}>{c.status || 'Unknown'}</p>
                <p style={{ margin: 0, fontSize: 20, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{c.count}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </TmsCard>
  )
}

/* ── AR ──────────────────────────────────────────────────────────────────── */

function ArPanel({ period, asOf, periodLabel, refreshKey }: {
  period: ReportPeriod
  asOf: string
  periodLabel: string
  refreshKey: number
}) {
  const open = useOpenInvoices()
  const unbilled = useArWorklist('UNBILLED')
  const docsNeeded = useArWorklist('DOCS_NEEDED')
  const invoiced = useArWorklist('UNPAID')
  const { customers } = useDirectory()
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const periodInvoices = useWindowRows(loadInvoices, period, refreshKey)

  useEffect(() => {
    let alive = true
    getTmsSettings()
      .then((s) => { if (alive) setSettings(s) })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  // Every order and shipment the AR desk is holding, which is what both the billing lag
  // and the credit exposure are measured over.
  const { orders, shipments, uninvoicedOrders } = useMemo(() => {
    const billable = [...unbilled.rows, ...docsNeeded.rows]
    const all = [...billable, ...invoiced.rows]
    return {
      orders: all.map((r) => r.order),
      shipments: all.map((r) => r.shipment).filter((s): s is ShipmentRecord => s !== null),
      uninvoicedOrders: billable.map((r) => r.order),
    }
  }, [unbilled.rows, docsNeeded.rows, invoiced.rows])

  const uninvoiced = useMemo(
    () => deliveredNotInvoiced(uninvoicedOrders, shipments, asOf),
    [uninvoicedOrders, shipments, asOf],
  )
  const lag = useMemo(
    () => avgDaysToInvoice([...open.invoices, ...periodInvoices.rows], shipments),
    [open.invoices, periodInvoices.rows, shipments],
  )
  const dso = useMemo(() => avgDaysToPay(periodInvoices.rows), [periodInvoices.rows])

  // Exposure is the customer-credit lib's answer over the same orders, not a second sum
  // of the open invoices: credit counts freight that has not been billed yet too.
  const exposure = useMemo(() => {
    const ordersByCustomer = new Map<string, OrderRecord[]>()
    for (const order of orders) {
      const bucket = ordersByCustomer.get(order.customerId)
      if (bucket) bucket.push(order)
      else ordersByCustomer.set(order.customerId, [order])
    }
    return customers
      .map((c) => ({
        customer: c,
        summary: creditSummaryForCustomer(c, settings, { orders: ordersByCustomer.get(c.id) ?? [], shipments }),
      }))
      .filter((row) => row.summary.usedCents > 0)
      .sort((a, b) => b.summary.usedCents - a.summary.usedCents)
  }, [customers, settings, orders, shipments])

  const uninvoicedCents = uninvoiced.reduce((sum, r) => sum + r.revenueCents, 0)

  return (
    <TmsCard title="Accounts receivable">
      <div style={STACK}>
        <AgingStrip
          openCents={open.aging.totalCents}
          lateCents={open.aging.lateCents}
          deliveredNotInvoicedCents={uninvoicedCents}
          deliveredNotInvoicedCount={uninvoiced.length}
          avgDaysToInvoice={lag}
          avgDaysToPay={dso}
          paidMonthLabel={periodLabel}
        />

        <section aria-label="Aging buckets" className="tms-grid tms-grid-4">
          {AGING_BUCKETS.map((b) => (
            <div key={b} style={TILE}>
              <p className="tms-field-label" style={{ margin: 0, textTransform: 'uppercase', letterSpacing: '.04em' }}>{AGING_BUCKET_LABEL[b]}</p>
              <p style={{ margin: 0, fontSize: 16, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{formatMoneyCents(open.aging.byBucket[b])}</p>
            </div>
          ))}
        </section>
        {open.aging.byCustomer.length === 0 && !open.loading && <Empty>Nothing is owed to us.</Empty>}

        <section aria-label="Delivered, not invoiced" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h2 className="tms-field-label" style={{ margin: 0, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em' }}>Delivered, not invoiced</h2>
          {uninvoiced.length === 0 ? (
            <Empty>No delivered load is waiting to be billed.</Empty>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th scope="col">Shipment</th>
                  <th scope="col">Customer</th>
                  <th scope="col" style={NUM}>Waiting</th>
                  <th scope="col" style={NUM}>Revenue</th>
                </tr>
              </thead>
              <tbody>
                {uninvoiced.map((row) => (
                  <tr key={row.orderId}>
                    <td><Link to={`/tms/shipments/${row.shipmentId}`}>{row.shipmentNumber}</Link></td>
                    <td>{row.customerName || row.customerId}</td>
                    <td style={NUM}>{row.daysWaiting}d</td>
                    <td style={NUM}>{formatMoneyCents(row.revenueCents)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </section>

        <section aria-label="Credit exposure" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h2 className="tms-field-label" style={{ margin: 0, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em' }}>Credit exposure</h2>
          {exposure.length === 0 ? (
            <Empty>No customer is carrying exposure.</Empty>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th scope="col">Customer</th>
                  <th scope="col" style={NUM}>Exposure</th>
                  <th scope="col" style={NUM}>Limit</th>
                  <th scope="col" style={NUM}>Available</th>
                  <th scope="col">Standing</th>
                </tr>
              </thead>
              <tbody>
                {exposure.map(({ customer, summary }) => (
                  <tr key={customer.id}>
                    <td><Link to="/tms/customers">{customer.name}</Link></td>
                    <td style={NUM}>{formatMoneyCents(summary.usedCents)}</td>
                    <td style={NUM}>
                      {summary.policy.creditLimitCents == null ? 'No limit' : formatMoneyCents(summary.policy.creditLimitCents)}
                    </td>
                    <td style={NUM}>
                      {summary.availableCents == null ? '—' : formatMoneyCents(summary.availableCents)}
                    </td>
                    <td>
                      {summary.hold && <TmsBadge tone="red">Hold</TmsBadge>}
                      {summary.blockReasons.length > 0 && <TmsBadge tone="red">Blocked</TmsBadge>}
                      {summary.warning && summary.blockReasons.length === 0 && <TmsBadge tone="orange">Near limit</TmsBadge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </section>
      </div>
    </TmsCard>
  )
}

/* ── AP ──────────────────────────────────────────────────────────────────── */

function ApPanel({ asOf, periodLabel }: { asOf: string; periodLabel: string }) {
  const { bills, aging, loading, error } = useOpenBills()

  // IN_REVIEW is money a carrier has billed that nobody has approved: owed, but not
  // payable, which is the AP side of "delivered, not invoiced".
  const inReview = useMemo(() => bills.filter((b) => b.status === 'IN_REVIEW'), [bills])

  const downloadCsv = () => {
    saveBlob(new Blob([apAgingCsv(aging.byParty)], { type: 'text/csv' }), `ap-aging-${asOf}.csv`)
  }

  return (
    <TmsCard title="Accounts payable">
      <div style={STACK}>
        {error && <p style={{ margin: 0, fontSize: 14, color: 'var(--tms-badge-red)' }}>{error}</p>}

        <AgingStrip
          labels={AP_STRIP_LABELS}
          openCents={aging.totalCents}
          lateCents={aging.lateCents}
          deliveredNotInvoicedCents={inReview.reduce((sum, b) => sum + b.balanceCents, 0)}
          deliveredNotInvoicedCount={inReview.length}
          avgDaysToPay={null}
          paidMonthLabel={periodLabel}
        />

        <section aria-label="AP aging buckets" className="tms-grid tms-grid-4">
          {AGING_BUCKETS.map((b) => (
            <div key={b} style={TILE}>
              <p className="tms-field-label" style={{ margin: 0, textTransform: 'uppercase', letterSpacing: '.04em' }}>{AGING_BUCKET_LABEL[b]}</p>
              <p style={{ margin: 0, fontSize: 16, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{formatMoneyCents(aging.byBucket[b])}</p>
            </div>
          ))}
        </section>

        {loading && aging.byParty.length === 0 && <Loading />}
        {!loading && aging.byParty.length === 0 ? (
          <Empty>We owe nothing.</Empty>
        ) : (
          <>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <TmsButton size="sm" aria-label="Download AP aging CSV" onClick={downloadCsv}>
                <Download size={14} /> CSV
              </TmsButton>
            </div>
            <Table>
              <thead>
                <tr>
                  <th scope="col">Carrier</th>
                  {AGING_BUCKETS.map((b) => (
                    <th key={b} scope="col" style={NUM}>{AGING_BUCKET_LABEL[b]}</th>
                  ))}
                  <th scope="col" style={NUM}>Total</th>
                  <th scope="col" style={NUM}>Late</th>
                  <th scope="col" style={NUM}>Oldest</th>
                </tr>
              </thead>
              <tbody>
                {aging.byParty.map((row) => (
                  <tr key={row.partyId}>
                    <td>{row.partyName || row.partyId}</td>
                    {AGING_BUCKETS.map((b) => <td key={b} style={NUM}>{formatMoneyCents(row.byBucket[b])}</td>)}
                    <td style={{ ...NUM, fontWeight: 500 }}>{formatMoneyCents(row.totalCents)}</td>
                    <td style={NUM}>{row.lateCount || '—'}</td>
                    <td style={NUM}>{row.oldestDays ? `${row.oldestDays}d` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </>
        )}
      </div>
    </TmsCard>
  )
}

/* ── Quotes ──────────────────────────────────────────────────────────────── */

function QuotesPanel({ period, refreshKey }: { period: ReportPeriod; refreshKey: number }) {
  const { rows, failedMonths, loading } = useWindowRows(loadQuotes, period, refreshKey)

  // The sell side only: a buy-side row is a carrier's answer to us, and counting those as
  // "quotes won" would double every booked load.
  const funnel = useMemo(
    () => quoteFunnel(rows.filter((q) => q.side === 'SELL').map((q) => ({
      status: q.status,
      sentAt: q.sentAt,
      respondedAt: q.respondedAt,
      amountCents: q.amountCents,
    }))),
    [rows],
  )

  const nothing = funnel.sent === 0 && funnel.won === 0 && funnel.lost === 0

  return (
    <TmsCard title="Quotes">
      <div style={STACK}>
        <FailedMonths failed={failedMonths} />
        {loading && <Loading />}
        {!loading && nothing && <Empty>No customer quotes in this window.</Empty>}
        {!nothing && (
          <FigureStrip
            label="Quote funnel"
            cells={[
              { label: 'Sent', value: String(funnel.sent) },
              { label: 'Won', value: String(funnel.won) },
              { label: 'Lost', value: String(funnel.lost) },
              { label: 'Still out', value: String(funnel.open) },
              { label: 'Win rate', value: formatMarginBps(funnel.winRateBps), hint: 'of the decided ones' },
              {
                label: 'Reply time',
                value: funnel.medianHoursToReply == null ? '—' : `${funnel.medianHoursToReply}h`,
                hint: 'median, sent → answered',
              },
              { label: 'Won value', value: formatMoneyCents(funnel.wonCents) },
            ]}
          />
        )}
      </div>
    </TmsCard>
  )
}

/* ── Commissions ─────────────────────────────────────────────────────────── */

function CommissionsPanel({ period, staffNames, refreshKey }: {
  period: ReportPeriod
  staffNames: Record<string, string>
  refreshKey: number
}) {
  const { rows, failedMonths, loading } = useWindowRows(loadCommissions, period, refreshKey)
  const report = useMemo(() => commissionReport(rows, staffNames), [rows, staffNames])

  return (
    <TmsCard title="Commissions">
      <div style={STACK}>
        <FailedMonths failed={failedMonths} />
        <p className="tms-field-hint" style={{ margin: 0 }}>
          Canceled rows are in neither the count nor the money.{' '}
          <Link to="/tms/brokerage/commissions">The approval board is on Commissions.</Link>
        </p>
        {loading && <Loading />}
        {!loading && report.rows.length === 0 ? (
          <Empty>No commissions were triggered in this window.</Empty>
        ) : (
          report.rows.length > 0 && (
            <Table label="Commissions by rep">
              <thead>
                <tr>
                  <th scope="col">Rep</th>
                  <th scope="col" style={NUM}>Rows</th>
                  <th scope="col" style={NUM}>Gross</th>
                  <th scope="col" style={NUM}>Net</th>
                  <th scope="col" style={NUM}>Unapproved</th>
                  <th scope="col" style={NUM}>Paid</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((row) => (
                  <tr key={row.repId || row.repName}>
                    <td>{row.repName}</td>
                    <td style={NUM}>{row.count}</td>
                    <td style={NUM}>{formatMoneyCents(row.amountCents)}</td>
                    <td style={{ ...NUM, fontWeight: 500 }}>{formatMoneyCents(row.netCents)}</td>
                    <td style={NUM}>{formatMoneyCents(row.unapprovedCents)}</td>
                    <td style={NUM}>{formatMoneyCents(row.paidCents)}</td>
                  </tr>
                ))}
                <tr style={{ fontWeight: 500 }}>
                  <td>Total</td>
                  <td style={NUM}>{report.totals.count}</td>
                  <td style={NUM}>{formatMoneyCents(report.totals.amountCents)}</td>
                  <td style={NUM}>{formatMoneyCents(report.totals.netCents)}</td>
                  <td style={NUM}>{formatMoneyCents(report.totals.unapprovedCents)}</td>
                  <td style={NUM}>{formatMoneyCents(report.totals.paidCents)}</td>
                </tr>
              </tbody>
            </Table>
          )
        )}
      </div>
    </TmsCard>
  )
}
