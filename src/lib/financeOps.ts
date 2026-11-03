/**
 * The Financial operations page's arithmetic. Pure: every function takes the data the hook
 * loaded (the brokerage dashboard bundle plus the AR/AP cash windows) and returns figures;
 * "today" is a parameter, there are no clock reads, and the page does no maths of its own.
 *
 * Bucketing is the dashboard's own — `applyFilters` + `sampleRow` + `topLevelOf`, the same
 * path `buildBusinessStrips` takes — so a division's revenue here equals its dashboard strip.
 * "No data" is `null`, never a zero standing in for it.
 */
import type { DashboardData, DashboardFilters } from '@/features/tms/dashboard/types'
import { applyFilters, dateOf, monthOf, pricedSamples, sampleRow } from './dashboardCharts'
import { divisionTree, SEED_DIVISIONS, topLevelOf } from './ownership'
import { isDeliveredStatus } from './podState'
import type { ApPaymentRecord, ArPaymentRecord } from '@/types/tms'

// ── Cash rows (what paymentsClient returns) ──────────────────────────────────

export type ArPaymentLine = Pick<
  ArPaymentRecord,
  | 'id' | 'customerId' | 'kind' | 'receivedAt' | 'method' | 'reference'
  | 'amountCents' | 'appliedCents' | 'unappliedCents' | 'reversedByPaymentId'
>
export type ApPaymentLine = Pick<
  ApPaymentRecord,
  | 'id' | 'carrierId' | 'kind' | 'paidAt' | 'method' | 'reference'
  | 'amountCents' | 'appliedCents' | 'unappliedCents' | 'reversedByPaymentId' | 'pdfKey' | 'remittanceSentAt'
>

// ── Dates (ISO `YYYY-MM-DD` strings, UTC arithmetic, no clock) ───────────────

const DAY_MS = 86_400_000

const toMs = (iso: string): number => {
  const [y, m, d] = iso.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}
const fromMs = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

export const addDaysIso = (iso: string, n: number): string => fromMs(toMs(iso) + n * DAY_MS)

/** First day of the month `offset` months from `iso`'s month. */
export function monthStart(iso: string, offset = 0): string {
  const [y, m] = iso.split('-').map(Number)
  return fromMs(Date.UTC(y, m - 1 + offset, 1))
}

/** `'YYYY-MM'` of the month `offset` months from `iso`'s month. */
export const monthKey = (iso: string, offset = 0): string => monthStart(iso, offset).slice(0, 7)

/** The Monday on or before `iso`. */
export function mondayOf(iso: string): string {
  const dow = new Date(toMs(iso)).getUTCDay()
  return addDaysIso(iso, dow === 0 ? -6 : 1 - dow)
}

const daysInclusive = (from: string, to: string): number => Math.round((toMs(to) - toMs(from)) / DAY_MS) + 1

// ── The window ───────────────────────────────────────────────────────────────

export type FinancePeriod = 'THIS_MONTH' | 'LAST_MONTH' | 'LAST_3_MONTHS'

export const FINANCE_PERIODS: ReadonlyArray<{ key: FinancePeriod; label: string }> = [
  { key: 'THIS_MONTH', label: 'This month' },
  { key: 'LAST_MONTH', label: 'Last month' },
  { key: 'LAST_3_MONTHS', label: 'Last 3 months' },
]

export interface FinanceWindow {
  period: FinancePeriod
  from: string
  to: string
  /** The equal-length window immediately before, for the deltas. */
  previous: { from: string; to: string }
  /** Calendar months the window spans — scales the revenue target. */
  months: number
}

/**
 * `todayChicago` is `YYYY-MM-DD` in the Chicago day. This month / Last 3 months end today;
 * Last month is the whole previous calendar month. Last 3 months starts on the 1st of the
 * month two months back.
 */
export function windowFor(period: FinancePeriod, todayChicago: string): FinanceWindow {
  const from =
    period === 'THIS_MONTH' ? monthStart(todayChicago)
    : period === 'LAST_MONTH' ? monthStart(todayChicago, -1)
    : monthStart(todayChicago, -2)
  const to = period === 'LAST_MONTH' ? addDaysIso(monthStart(todayChicago), -1) : todayChicago
  const length = daysInclusive(from, to)
  const previousTo = addDaysIso(from, -1)
  return {
    period,
    from,
    to,
    previous: { from: addDaysIso(previousTo, -(length - 1)), to: previousTo },
    months: period === 'LAST_3_MONTHS' ? 3 : 1,
  }
}

/** The Mondays of the last `weeks` weeks (current week last). */
export function weekStarts(todayChicago: string, weeks = 8): string[] {
  const newest = mondayOf(todayChicago)
  return Array.from({ length: weeks }, (_, i) => addDaysIso(newest, -7 * (weeks - 1 - i)))
}

/**
 * The one read the page needs: the selected window, its previous window, the 8 chart weeks
 * and the three completed months the target averages — whichever starts earliest.
 */
export function loadRangeFor(win: FinanceWindow, todayChicago: string, weeks = 8): { from: string; to: string } {
  const candidates = [win.previous.from, weekStarts(todayChicago, weeks)[0], monthStart(win.from, -3)]
  return { from: candidates.reduce((a, b) => (a < b ? a : b)), to: todayChicago }
}

/** A filter row with no narrowing: the whole company over `[from, to]`. */
export function windowFilters(from: string, to: string): DashboardFilters {
  return {
    divisions: [], subdivisions: [], from, to,
    mode: null, status: null, customerId: null, carrierId: null, repId: null,
  }
}

// ── KPIs ─────────────────────────────────────────────────────────────────────

export interface FinanceKpis {
  /** Σ profit ÷ brokered priced-sample count; `null` with no brokered sample. */
  avgMarginCents: number | null
  marginBps: number | null
  /** Own-fleet loads in scope: revenue counted, cost not (settlements pay it). */
  ownFleetCount: number
  shipmentsCompleted: number
  /** Σ open carrier-bill balances (a snapshot, not window-bound). */
  pendingPayoutsCents: number | null
  pendingBillCount: number
  /** Σ non-reversed AR credit memos received in the window. */
  creditsCents: number | null
  writeOffsCents: number
  revenueCents: number | null
}

const inRange = (value: string | null | undefined, from: string, to: string): boolean => {
  const day = dateOf(value)
  return day != null && day >= from && day <= to
}

const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0)

export function kpis(data: DashboardData, filters: DashboardFilters, ar: readonly ArPaymentLine[]): FinanceKpis {
  const filtered = applyFilters(data, filters)
  const priced = pricedSamples(filtered.samples)
  const brokered = priced.filter((s) => s.assignmentKind !== 'OWN_ASSET')
  const margined = brokered.filter((s) => s.profitCents != null)
  const profit = sum(margined.map((s) => s.profitCents ?? 0))
  const marginRevenue = sum(margined.map((s) => s.revenueCents ?? 0))

  const live = ar.filter((p) => !p.reversedByPaymentId && inRange(p.receivedAt, filters.from, filters.to))
  const credits = live.filter((p) => p.kind === 'CREDIT_MEMO')

  return {
    avgMarginCents: margined.length > 0 ? Math.round(profit / margined.length) : null,
    marginBps: margined.length > 0 && marginRevenue > 0 ? Math.round((profit / marginRevenue) * 10000) : null,
    ownFleetCount: priced.length - brokered.length,
    shipmentsCompleted: filtered.shipments.filter((s) => isDeliveredStatus(s.status)).length,
    pendingPayoutsCents: filtered.openBills.length > 0 ? sum(filtered.openBills.map((b) => b.balanceCents ?? 0)) : null,
    pendingBillCount: filtered.openBills.length,
    creditsCents: credits.length > 0 ? sum(credits.map((p) => p.amountCents)) : null,
    writeOffsCents: sum(live.filter((p) => p.kind === 'WRITE_OFF').map((p) => p.amountCents)),
    revenueCents: priced.length > 0 ? sum(priced.map((s) => s.revenueCents ?? 0)) : null,
  }
}

export interface FinanceDeltas {
  avgMargin: number | null
  completed: number | null
  credits: number | null
}

/** Percentage points vs the previous window; `null` when there is nothing to compare to. */
function pctChange(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null || previous === 0) return null
  return ((current - previous) / Math.abs(previous)) * 100
}

export function kpiDeltas(current: FinanceKpis, previous: FinanceKpis): FinanceDeltas {
  return {
    avgMargin: pctChange(current.avgMarginCents, previous.avgMarginCents),
    completed: pctChange(current.shipmentsCompleted, previous.shipmentsCompleted),
    credits: pctChange(current.creditsCents, previous.creditsCents),
  }
}

// ── Revenue by division ──────────────────────────────────────────────────────

export const UNTAGGED_KEY = 'UNTAGGED'

export interface DivisionRevenue {
  key: string
  label: string
  revenueCents: number
}

function divisionsOf(data: DashboardData): DashboardData['divisions'] {
  return data.divisions.length > 0 ? data.divisions : (SEED_DIVISIONS as DashboardData['divisions'])
}

/** The top-level division a sample books to, or the untagged key. */
function topOfSample(sample: DashboardData['samples'][number], data: DashboardData): string {
  const row = sampleRow(sample, data)
  const code = row.revSubdivision ?? row.revDivision ?? null
  return (code ? topLevelOf(divisionsOf(data), code) : null) ?? UNTAGGED_KEY
}

/**
 * Revenue per top-level division over the filter window, plus an Untagged segment so the
 * list sums to company revenue (`buildCompanyTotals` documents the dropped-untagged trap).
 * Active divisions always appear; an inactive one only when it carries revenue.
 */
export function revenueByDivision(data: DashboardData, filters: DashboardFilters): DivisionRevenue[] {
  const divisions = divisionsOf(data)
  const totals = new Map<string, number>()
  for (const sample of pricedSamples(applyFilters(data, filters).samples)) {
    const key = topOfSample(sample, data)
    totals.set(key, (totals.get(key) ?? 0) + (sample.revenueCents ?? 0))
  }
  const rows: DivisionRevenue[] = divisionTree(divisions)
    .filter((n) => n.division.parentId == null && (n.division.active !== false || (totals.get(n.division.code) ?? 0) > 0))
    .sort((a, b) => (a.division.sortOrder ?? 0) - (b.division.sortOrder ?? 0))
    .map((n) => ({ key: n.division.code, label: n.division.name, revenueCents: totals.get(n.division.code) ?? 0 }))
  const untagged = totals.get(UNTAGGED_KEY) ?? 0
  if (untagged !== 0) rows.push({ key: UNTAGGED_KEY, label: 'Untagged', revenueCents: untagged })
  return rows
}

// ── Weekly trend ─────────────────────────────────────────────────────────────

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export interface WeeklyRevenue {
  series: Array<{ key: string; label: string }>
  weeks: Array<{ start: string; label: string; values: Record<string, number> }>
  /** Index of the current (newest) week. */
  currentIndex: number
}

/**
 * Revenue per Monday-start week and top-level division, `weeks` weeks ending with the one
 * containing `todayChicago`. A week with no sales is present with zeros; the series list is
 * `revenueByDivision`'s (same division order, Untagged last when it has revenue).
 */
export function weeklyRevenueByDivision(data: DashboardData, todayChicago: string, weeks = 8): WeeklyRevenue {
  const starts = weekStarts(todayChicago, weeks)
  const overall = windowFilters(starts[0], todayChicago)
  const series = revenueByDivision(data, overall).map(({ key, label }) => ({ key, label }))
  const rows = starts.map((start) => ({
    start,
    label: `${MONTH_ABBR[Number(start.slice(5, 7)) - 1]} ${Number(start.slice(8, 10))}`,
    values: Object.fromEntries(series.map((s) => [s.key, 0])) as Record<string, number>,
  }))
  for (const sample of pricedSamples(applyFilters(data, overall).samples)) {
    const day = dateOf(sample.date)
    if (!day) continue
    const row = rows[starts.findLastIndex((start) => start <= day)]
    const key = topOfSample(sample, data)
    if (row && key in row.values) row.values[key] += sample.revenueCents ?? 0
  }
  return { series, weeks: rows, currentIndex: rows.length - 1 }
}

// ── Revenue target (D-S4-1) ──────────────────────────────────────────────────

/** Priced revenue per `YYYY-MM` (the sample's own month), whole company. */
export function monthlyRevenue(data: DashboardData, months: string[]): Record<string, number> {
  const wanted = new Set(months)
  const out: Record<string, number> = Object.fromEntries(months.map((m) => [m, 0]))
  for (const sample of pricedSamples(data.samples)) {
    const month = monthOf(sample.date)
    if (month && wanted.has(month)) out[month] += sample.revenueCents ?? 0
  }
  return out
}

export interface RevenueTarget {
  /** Trailing average × months the window spans; `null` with no prior month of data. */
  targetCents: number | null
  monthlyAverageCents: number | null
  /** How many of the three completed months actually had revenue. */
  basisMonths: number
}

/**
 * The mean revenue of the (up to) 3 completed calendar months before the window, scaled to
 * the months the window spans. Months with no revenue are "no data", not zero.
 */
export function revenueTarget(monthly: Record<string, number>, win: FinanceWindow): RevenueTarget {
  const basis = [-1, -2, -3]
    .map((offset) => monthly[monthKey(win.from, offset)] ?? 0)
    .filter((cents) => cents > 0)
  if (basis.length === 0) return { targetCents: null, monthlyAverageCents: null, basisMonths: 0 }
  const monthlyAverageCents = Math.round(sum(basis) / basis.length)
  return { targetCents: monthlyAverageCents * win.months, monthlyAverageCents, basisMonths: basis.length }
}

/** Revenue ÷ target (uncapped: the label may read 120% while the arc caps full). */
export function targetProgress(revenueCents: number | null, targetCents: number | null): number | null {
  if (revenueCents == null || targetCents == null || targetCents <= 0) return null
  return revenueCents / targetCents
}

/** `$412k` / `$1.2M` / `$850` — the gauge centre and the chart axis. */
export function compactDollars(cents: number): string {
  const dollarsAbs = Math.abs(cents) / 100
  const sign = cents < 0 ? '-' : ''
  if (dollarsAbs >= 1_000_000) return `${sign}$${(dollarsAbs / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (dollarsAbs >= 1_000) return `${sign}$${Math.round(dollarsAbs / 1_000)}k`
  return `${sign}$${Math.round(dollarsAbs)}`
}

export interface RevenueGauge {
  /** 0..1 for the arc (capped); `null` = empty arc. */
  value: number | null
  label: string
  sub: string
}

/** What the Total-revenue gauge prints. The label may exceed 100% while the arc caps full. */
export function revenueGauge(revenueCents: number | null, target: RevenueTarget): RevenueGauge {
  const progress = targetProgress(revenueCents, target.targetCents)
  const label = revenueCents == null ? '—' : compactDollars(revenueCents)
  if (target.targetCents == null) return { value: null, label, sub: 'No prior months to compare' }
  const average = `${target.basisMonths}-month average`
  const sub = progress == null
    ? `Target ${compactDollars(target.targetCents)} · ${average}`
    : `${Math.round(progress * 100)}% of ${compactDollars(target.targetCents)} · ${average}`
  return { value: progress == null ? null : Math.min(progress, 1), label, sub }
}

/** The note under the margin card; same wording `ReportsPage` prints for own-fleet loads. */
export function ownFleetCaption(ownFleetCount: number): string | null {
  if (ownFleetCount <= 0) return null
  return `${ownFleetCount} load${ownFleetCount === 1 ? '' : 's'} here ran on our own trucks. Their revenue is counted, but their cost is paid out in driver settlements and fleet expenses, so their margin is not comparable with a brokered load.`
}

// ── Payment transactions ─────────────────────────────────────────────────────

export type PaymentStatus = 'APPLIED' | 'PARTIAL' | 'UNAPPLIED' | 'REMITTED' | 'RECORDED' | 'REVERSED'

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  APPLIED: 'Applied',
  PARTIAL: 'Partly applied',
  UNAPPLIED: 'Unapplied',
  REMITTED: 'Remitted',
  RECORDED: 'Recorded',
  REVERSED: 'Reversed',
}

export interface PaymentRow {
  id: string
  type: 'AR' | 'AP'
  /** ISO instant as stored (noon UTC on the typed day). */
  at: string
  counterparty: string
  reference: string | null
  method: string | null
  /** Signed: money in is positive, money out negative. */
  amountCents: number
  status: PaymentStatus
  /** AP rows only: the stored remittance advice PDF. */
  pdfKey: string | null
}

export interface PaymentNames {
  customers: ReadonlyMap<string, string>
  carriers: ReadonlyMap<string, string>
}

function arStatus(p: ArPaymentLine): PaymentStatus {
  if (p.reversedByPaymentId) return 'REVERSED'
  if (p.unappliedCents <= 0) return 'APPLIED'
  return p.unappliedCents >= p.amountCents ? 'UNAPPLIED' : 'PARTIAL'
}

/**
 * AR receipts and AP payments (kind PAYMENT; credit memos, write-offs and reversal rows are
 * not transactions) dated inside `[from, to]`, newest first. A payment that was later
 * reversed stays listed, marked Reversed.
 */
export function paymentRows(
  ar: readonly ArPaymentLine[],
  ap: readonly ApPaymentLine[],
  names: PaymentNames,
  window: { from: string; to: string },
): PaymentRow[] {
  const rows: PaymentRow[] = []
  for (const p of ar) {
    if (p.kind !== 'PAYMENT' || !inRange(p.receivedAt, window.from, window.to)) continue
    rows.push({
      id: p.id, type: 'AR', at: p.receivedAt,
      counterparty: names.customers.get(p.customerId) ?? '—',
      reference: p.reference ?? null, method: p.method ?? null,
      amountCents: p.amountCents, status: arStatus(p), pdfKey: null,
    })
  }
  for (const p of ap) {
    if (p.kind !== 'PAYMENT' || !inRange(p.paidAt, window.from, window.to)) continue
    rows.push({
      id: p.id, type: 'AP', at: p.paidAt,
      counterparty: names.carriers.get(p.carrierId) ?? '—',
      reference: p.reference ?? null, method: p.method ?? null,
      amountCents: -p.amountCents,
      status: p.reversedByPaymentId ? 'REVERSED' : p.remittanceSentAt ? 'REMITTED' : 'RECORDED',
      pdfKey: p.pdfKey ?? null,
    })
  }
  return rows.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
}

// ── CSV ──────────────────────────────────────────────────────────────────────

const csvCell = (value: string | number): string => {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

const csv = (lines: Array<Array<string | number>>): string => lines.map((l) => l.map(csvCell).join(',')).join('\n')

const dollars = (cents: number): string => (cents / 100).toFixed(2)

export function paymentsCsv(rows: readonly PaymentRow[]): string {
  return csv([
    ['Date', 'Type', 'Counterparty', 'Reference', 'Method', 'Amount', 'Status'],
    ...rows.map((r) => [
      r.at.slice(0, 10), r.type === 'AR' ? 'AR receipt' : 'AP payment', r.counterparty,
      r.reference ?? '', r.method ?? '', dollars(r.amountCents), PAYMENT_STATUS_LABEL[r.status],
    ]),
  ])
}

export function weeklyRevenueCsv(trend: WeeklyRevenue): string {
  return csv([
    ['Week of', ...trend.series.map((s) => s.label)],
    ...trend.weeks.map((w) => [w.start, ...trend.series.map((s) => dollars(w.values[s.key] ?? 0))]),
  ])
}
