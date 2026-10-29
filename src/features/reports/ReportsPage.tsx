/**
 * `/reports` — the numbers the office is allowed to quote (spec §3.9; `I-plan.md`
 * "Reporting").
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
 */
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { BarChart3, Download, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { RepPicker } from '@/components/RepPicker'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
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
import { cn } from '@/lib/utils'
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

const TH = 'px-2 py-2 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground'
const TD = 'px-2 py-2 align-top'
const MONEY = 'px-2 py-2 text-right tabular-nums align-top'
const SELECT = 'mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-sm'
const FIELD_LABEL = 'text-[10px] uppercase tracking-wider text-muted-foreground'

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
    <dl aria-label={label} className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
      {cells.map((c) => (
        <div key={c.label} className="rounded-md border border-border bg-card px-3 py-2">
          <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">{c.label}</dt>
          <dd className="text-base font-semibold tabular-nums">{c.value}</dd>
          {c.hint && <p className="text-[11px] text-muted-foreground">{c.hint}</p>}
        </div>
      ))}
    </dl>
  )
}

function Empty({ children }: { children: string }) {
  return <p className="py-8 text-center text-sm text-muted-foreground">{children}</p>
}

function FailedMonths({ failed }: { failed: FailedMonth[] }) {
  if (failed.length === 0) return null
  return (
    <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
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
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
        <BarChart3 size={18} />
        <h1 className="text-lg font-semibold">Reports</h1>
        <Badge variant="outline">{periodLabel}</Badge>
        <div className="ml-auto flex items-end gap-2">
          <div>
            <Label className={FIELD_LABEL} htmlFor="report-from">From</Label>
            <select
              id="report-from"
              aria-label="From month"
              className={cn(SELECT, 'w-40')}
              value={period.from}
              onChange={(e) => setFrom(e.target.value)}
            >
              {months.map((ym) => <option key={ym} value={ym}>{monthLabel(ym)}</option>)}
            </select>
          </div>
          <div>
            <Label className={FIELD_LABEL} htmlFor="report-to">To</Label>
            <select
              id="report-to"
              aria-label="To month"
              className={cn(SELECT, 'w-40')}
              value={period.to}
              onChange={(e) => setTo(e.target.value)}
            >
              {months.map((ym) => <option key={ym} value={ym}>{monthLabel(ym)}</option>)}
            </select>
          </div>
          <Button variant="ghost" size="icon" className="h-9 w-9" aria-label="Refresh reports" onClick={refresh}>
            <RefreshCw size={14} />
          </Button>
        </div>
      </header>

      <nav role="tablist" aria-label="Report panels" className="flex gap-1 overflow-x-auto border-b border-border px-5">
        {REPORT_TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            type="button"
            aria-selected={tab === t.key}
            aria-label={t.label}
            onClick={() => setTab(t.key)}
            className={cn(
              'flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm',
              tab === t.key ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="flex-1 overflow-auto px-5 py-3">
        {tab === 'profit' && <ProfitPanel period={period} staffNames={staffNames} refreshKey={refreshKey} />}
        {tab === 'pipeline' && <PipelinePanel />}
        {tab === 'ar' && <ArPanel period={period} asOf={asOf} periodLabel={periodLabel} refreshKey={refreshKey} />}
        {tab === 'ap' && <ApPanel asOf={asOf} periodLabel={periodLabel} />}
        {tab === 'quotes' && <QuotesPanel period={period} refreshKey={refreshKey} />}
        {tab === 'commissions' && (
          <CommissionsPanel period={period} staffNames={staffNames} refreshKey={refreshKey} />
        )}
      </div>
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
    <div className="space-y-4">
      <FailedMonths failed={failedMonths} />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
        <div>
          <Label className={FIELD_LABEL} htmlFor="report-group-by">Group by</Label>
          <select
            id="report-group-by"
            aria-label="Group by"
            className={SELECT}
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value as ReportGroupBy)}
          >
            {GROUP_BY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <FilterSelect label="Division" value={filters.divisionKey} options={options.divisions} onChange={(v) => setFilter('divisionKey', v)} />
        <FilterSelect label="Team" value={filters.teamKey} options={options.teams} onChange={(v) => setFilter('teamKey', v)} />
        <FilterSelect label="Mode" value={filters.mode} options={options.modes} onChange={(v) => setFilter('mode', v)} />
        <FilterSelect label="Equipment" value={filters.equipmentType} options={options.equipment} onChange={(v) => setFilter('equipmentType', v)} />
        <FilterSelect label="Customer" value={filters.customerId} options={options.customers} onChange={(v) => setFilter('customerId', v)} />
        <FilterSelect label="Carrier" value={filters.carrierId} options={options.carriers} onChange={(v) => setFilter('carrierId', v)} />
        <div>
          {/* The canonical rep control, so a report filters by the same username the
              order carries — a rep with no load in the window answers with no rows. */}
          <Label className={FIELD_LABEL}>Rep</Label>
          <div className="mt-1">
            <RepPicker
              value={filters.repId ?? ''}
              placeholder="All"
              onChange={(v) => setFilter('repId', v)}
            />
          </div>
        </div>
      </div>

      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}

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
            <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
              {note}{' '}
              <Link to="/finances" className="underline">Own-fleet profitability lives on Finances.</Link>
            </p>
          )}

          {report.excluded > 0 && (
            <p className="text-xs text-muted-foreground">
              {report.excluded} canceled or TONU&apos;d load{report.excluded === 1 ? '' : 's'} excluded.
            </p>
          )}

          <div className="flex justify-end">
            <Button variant="outline" size="sm" aria-label="Download profit CSV" onClick={downloadCsv}>
              <Download size={14} className="mr-1" /> CSV
            </Button>
          </div>

          <table className="w-full text-sm" aria-label="Profit by group">
            <thead>
              <tr className="border-b border-border">
                <th className={TH} scope="col">{groupLabel}</th>
                <th className={cn(TH, 'text-right')} scope="col">Loads</th>
                <th className={cn(TH, 'text-right')} scope="col">Revenue</th>
                <th className={cn(TH, 'text-right')} scope="col">Cost</th>
                <th className={cn(TH, 'text-right')} scope="col">Profit</th>
                <th className={cn(TH, 'text-right')} scope="col">Margin</th>
                <th className={cn(TH, 'text-right')} scope="col">Miles</th>
                <th className={cn(TH, 'text-right')} scope="col">RPM</th>
                <th className={cn(TH, 'text-right')} scope="col">CPM</th>
                <th className={cn(TH, 'text-right')} scope="col">Own fleet</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((row) => (
                <tr key={row.key || row.label} className="border-b border-border/60">
                  <td className={TD}>{row.label}</td>
                  <td className={MONEY}>{row.loads}</td>
                  <td className={MONEY}>{formatMoneyCents(row.revenueCents)}</td>
                  <td className={MONEY}>{formatMoneyCents(row.costCents)}</td>
                  <td className={cn(MONEY, 'font-medium')}>{formatMoneyCents(row.profitCents)}</td>
                  {/* An own-fleet row's cost is a settlement we have not loaded, so its
                      margin is not a margin: say so rather than print a flattering one. */}
                  <td className={MONEY}>{row.ownFleet === row.loads && row.loads > 0 ? '—' : formatMarginBps(row.marginBps)}</td>
                  <td className={MONEY}>{row.miles}</td>
                  <td className={MONEY}>{formatPerMile(row.rpmCents)}</td>
                  <td className={MONEY}>{row.ownFleet === row.loads && row.loads > 0 ? '—' : formatPerMile(row.cpmCents)}</td>
                  <td className={MONEY}>{row.ownFleet || '—'}</td>
                </tr>
              ))}
              <tr className="border-b-2 border-border font-medium">
                <td className={TD}>Total</td>
                <td className={MONEY}>{totals.loads}</td>
                <td className={MONEY}>{formatMoneyCents(totals.revenueCents)}</td>
                <td className={MONEY}>{formatMoneyCents(totals.costCents)}</td>
                <td className={MONEY}>{formatMoneyCents(totals.profitCents)}</td>
                <td className={MONEY}>{formatMarginBps(totals.marginBps)}</td>
                <td className={MONEY}>{totals.miles}</td>
                <td className={MONEY}>{formatPerMile(totals.rpmCents)}</td>
                <td className={MONEY}>{formatPerMile(totals.cpmCents)}</td>
                <td className={MONEY}>{totals.ownFleet || '—'}</td>
              </tr>
            </tbody>
          </table>

          <section aria-label="Profit by month" className="space-y-2">
            <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">By month</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {byMonth.rows.map((row) => (
                <div key={row.key} className="rounded-md border border-border bg-card px-3 py-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{monthLabel(row.key)}</p>
                  <p className="text-base font-semibold tabular-nums">{formatMoneyCents(row.profitCents)}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {row.loads} load{row.loads === 1 ? '' : 's'} · {formatMarginBps(row.marginBps)}
                  </p>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  )
}

function FilterSelect({ label, value, options, onChange }: {
  label: string
  value: string | null | undefined
  options: { value: string; label: string }[]
  onChange: (value: string) => void
}) {
  return (
    <div>
      <Label className={FIELD_LABEL}>{label}</Label>
      <select
        aria-label={`Filter ${label.toLowerCase()}`}
        className={SELECT}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">All</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  )
}

/* ── Pipeline ────────────────────────────────────────────────────────────── */

function PipelinePanel() {
  const { shipments, loading, error } = useShipments()
  const counts = useMemo(() => pipelineCounts(shipments), [shipments])

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        The board as it stands right now — not the report period: a shipment sits on a rung until it moves.
      </p>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {loading && counts.length === 0 && <p className="text-sm text-muted-foreground">Loading…</p>}
      {!loading && counts.length === 0 && <Empty>No shipments on the board.</Empty>}
      {counts.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          {counts.map((c) => (
            <div key={c.status} className="rounded-md border border-border bg-card px-3 py-2">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{c.status || 'Unknown'}</p>
              <p className="text-xl font-semibold tabular-nums">{c.count}</p>
            </div>
          ))}
        </div>
      )}
    </div>
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
    <div className="space-y-4">
      <AgingStrip
        openCents={open.aging.totalCents}
        lateCents={open.aging.lateCents}
        deliveredNotInvoicedCents={uninvoicedCents}
        deliveredNotInvoicedCount={uninvoiced.length}
        avgDaysToInvoice={lag}
        avgDaysToPay={dso}
        paidMonthLabel={periodLabel}
      />

      <section aria-label="Aging buckets" className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {AGING_BUCKETS.map((b) => (
          <div key={b} className="rounded-md border border-border bg-card px-3 py-2">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{AGING_BUCKET_LABEL[b]}</p>
            <p className="text-base font-semibold tabular-nums">{formatMoneyCents(open.aging.byBucket[b])}</p>
          </div>
        ))}
      </section>
      {open.aging.byCustomer.length === 0 && !open.loading && <Empty>Nothing is owed to us.</Empty>}

      <section aria-label="Delivered, not invoiced" className="space-y-2">
        <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Delivered, not invoiced</h2>
        {uninvoiced.length === 0 ? (
          <Empty>No delivered load is waiting to be billed.</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className={TH} scope="col">Shipment</th>
                <th className={TH} scope="col">Customer</th>
                <th className={cn(TH, 'text-right')} scope="col">Waiting</th>
                <th className={cn(TH, 'text-right')} scope="col">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {uninvoiced.map((row) => (
                <tr key={row.orderId} className="border-b border-border/60">
                  <td className={TD}>
                    <Link to={`/shipments/${row.shipmentId}`} className="underline">{row.shipmentNumber}</Link>
                  </td>
                  <td className={TD}>{row.customerName || row.customerId}</td>
                  <td className={MONEY}>{row.daysWaiting}d</td>
                  <td className={MONEY}>{formatMoneyCents(row.revenueCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-label="Credit exposure" className="space-y-2">
        <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Credit exposure</h2>
        {exposure.length === 0 ? (
          <Empty>No customer is carrying exposure.</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className={TH} scope="col">Customer</th>
                <th className={cn(TH, 'text-right')} scope="col">Exposure</th>
                <th className={cn(TH, 'text-right')} scope="col">Limit</th>
                <th className={cn(TH, 'text-right')} scope="col">Available</th>
                <th className={TH} scope="col">Standing</th>
              </tr>
            </thead>
            <tbody>
              {exposure.map(({ customer, summary }) => (
                <tr key={customer.id} className="border-b border-border/60">
                  <td className={TD}>
                    <Link to={`/customers/${customer.id}`} className="underline">{customer.name}</Link>
                  </td>
                  <td className={MONEY}>{formatMoneyCents(summary.usedCents)}</td>
                  <td className={MONEY}>
                    {summary.policy.creditLimitCents == null ? 'No limit' : formatMoneyCents(summary.policy.creditLimitCents)}
                  </td>
                  <td className={MONEY}>
                    {summary.availableCents == null ? '—' : formatMoneyCents(summary.availableCents)}
                  </td>
                  <td className={TD}>
                    {summary.hold && <Badge variant="destructive" className="mr-1">Hold</Badge>}
                    {summary.blockReasons.length > 0 && <Badge variant="destructive" className="mr-1">Blocked</Badge>}
                    {summary.warning && summary.blockReasons.length === 0 && <Badge variant="outline">Near limit</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
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
    <div className="space-y-4">
      {error && <p className="text-sm text-destructive">{error}</p>}

      <AgingStrip
        labels={AP_STRIP_LABELS}
        openCents={aging.totalCents}
        lateCents={aging.lateCents}
        deliveredNotInvoicedCents={inReview.reduce((sum, b) => sum + b.balanceCents, 0)}
        deliveredNotInvoicedCount={inReview.length}
        avgDaysToPay={null}
        paidMonthLabel={periodLabel}
      />

      <section aria-label="AP aging buckets" className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {AGING_BUCKETS.map((b) => (
          <div key={b} className="rounded-md border border-border bg-card px-3 py-2">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{AGING_BUCKET_LABEL[b]}</p>
            <p className="text-base font-semibold tabular-nums">{formatMoneyCents(aging.byBucket[b])}</p>
          </div>
        ))}
      </section>

      {loading && aging.byParty.length === 0 && <p className="text-sm text-muted-foreground">Loading…</p>}
      {!loading && aging.byParty.length === 0 ? (
        <Empty>We owe nothing.</Empty>
      ) : (
        <>
          <div className="flex justify-end">
            <Button variant="outline" size="sm" aria-label="Download AP aging CSV" onClick={downloadCsv}>
              <Download size={14} className="mr-1" /> CSV
            </Button>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className={TH} scope="col">Carrier</th>
                {AGING_BUCKETS.map((b) => (
                  <th key={b} className={cn(TH, 'text-right')} scope="col">{AGING_BUCKET_LABEL[b]}</th>
                ))}
                <th className={cn(TH, 'text-right')} scope="col">Total</th>
                <th className={cn(TH, 'text-right')} scope="col">Late</th>
                <th className={cn(TH, 'text-right')} scope="col">Oldest</th>
              </tr>
            </thead>
            <tbody>
              {aging.byParty.map((row) => (
                <tr key={row.partyId} className="border-b border-border/60">
                  <td className={TD}>{row.partyName || row.partyId}</td>
                  {AGING_BUCKETS.map((b) => <td key={b} className={MONEY}>{formatMoneyCents(row.byBucket[b])}</td>)}
                  <td className={cn(MONEY, 'font-medium')}>{formatMoneyCents(row.totalCents)}</td>
                  <td className={MONEY}>{row.lateCount || '—'}</td>
                  <td className={MONEY}>{row.oldestDays ? `${row.oldestDays}d` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
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
    <div className="space-y-4">
      <FailedMonths failed={failedMonths} />
      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
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
    <div className="space-y-4">
      <FailedMonths failed={failedMonths} />
      <p className="text-xs text-muted-foreground">
        Canceled rows are in neither the count nor the money.{' '}
        <Link to="/commissions" className="underline">The approval board is on Commissions.</Link>
      </p>
      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {!loading && report.rows.length === 0 ? (
        <Empty>No commissions were triggered in this window.</Empty>
      ) : (
        report.rows.length > 0 && (
          <table className="w-full text-sm" aria-label="Commissions by rep">
            <thead>
              <tr className="border-b border-border">
                <th className={TH} scope="col">Rep</th>
                <th className={cn(TH, 'text-right')} scope="col">Rows</th>
                <th className={cn(TH, 'text-right')} scope="col">Gross</th>
                <th className={cn(TH, 'text-right')} scope="col">Net</th>
                <th className={cn(TH, 'text-right')} scope="col">Unapproved</th>
                <th className={cn(TH, 'text-right')} scope="col">Paid</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((row) => (
                <tr key={row.repId || row.repName} className="border-b border-border/60">
                  <td className={TD}>{row.repName}</td>
                  <td className={MONEY}>{row.count}</td>
                  <td className={MONEY}>{formatMoneyCents(row.amountCents)}</td>
                  <td className={cn(MONEY, 'font-medium')}>{formatMoneyCents(row.netCents)}</td>
                  <td className={MONEY}>{formatMoneyCents(row.unapprovedCents)}</td>
                  <td className={MONEY}>{formatMoneyCents(row.paidCents)}</td>
                </tr>
              ))}
              <tr className="border-b-2 border-border font-medium">
                <td className={TD}>Total</td>
                <td className={MONEY}>{report.totals.count}</td>
                <td className={MONEY}>{formatMoneyCents(report.totals.amountCents)}</td>
                <td className={MONEY}>{formatMoneyCents(report.totals.netCents)}</td>
                <td className={MONEY}>{formatMoneyCents(report.totals.unapprovedCents)}</td>
                <td className={MONEY}>{formatMoneyCents(report.totals.paidCents)}</td>
              </tr>
            </tbody>
          </table>
        )
      )}
    </div>
  )
}
