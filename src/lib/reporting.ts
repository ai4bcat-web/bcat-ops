// Relative, not `@/` — the reporting Lambda bundles this file by path, and the alias
// does not exist in the function build.
import type {
  CommissionRecord,
  LaneRateSampleRecord,
  ProfitReport,
  ReportFilters,
  ReportGroupBy,
  ReportRow,
} from '../types/tms'

/**
 * Reporting: the numbers every dashboard, chart and CSV in Step I reads.
 *
 * The fact table is `LaneRateSample` — one row per delivered, priced load, already
 * carrying the rep, team, division and month it belongs to. Reporting therefore never
 * joins: it filters a flat list and adds it up. A sample marked `excluded` (canceled,
 * TONU'd) is counted in `excluded` and nowhere else — the history keeps what happened
 * and refuses to bill it.
 *
 * Money is integer cents, rates are integer basis points (10000 = 100%). Every quotient
 * guards its denominator: a group with no revenue reports a null margin, not a NaN, and
 * loads with no mileage report a null RPM, not an Infinity.
 *
 * Pure: no clock (callers pass the window), no store, no network.
 */

/** Rounds .5 away from zero, so -0.5 → -1 as well as 0.5 → 1: a loss rounds like a gain. */
function roundHalfAwayFromZero(value: number): number {
  if (!Number.isFinite(value)) return 0
  return value < 0 ? -Math.round(-value) : Math.round(value)
}

/** Absent money is zero; a corrupt number is zero too, so no total can become NaN. */
function num(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function text(value: string | null | undefined): string {
  return (value ?? '').trim()
}

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/** `'YYYY-MM'` or `'YYYY-MM-DD'` → months since year 0, or null when unparseable. */
function monthIndex(value: string | null | undefined): number | null {
  const raw = text(value)
  if (!/^\d{4}-\d{2}/.test(raw)) return null
  const month = Number(raw.slice(5, 7))
  if (month < 1 || month > 12) return null
  return Number(raw.slice(0, 4)) * 12 + (month - 1)
}

/** The last day of a `'YYYY-MM'`, leap years included. */
function monthEnd(month: string): string {
  const year = Number(month.slice(0, 4))
  const index = Number(month.slice(5, 7)) - 1
  const leapFebruary = index === 1 && year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  return `${month}-${leapFebruary ? 29 : (MONTH_DAYS[index] ?? 31)}`
}

/** No report spans more than five years: a runaway range is a bug, not a request. */
const MAX_MONTHS = 60

/**
 * The `'YYYY-MM'` keys from `from` to `to`, inclusive. Either end may be a month or a
 * date. A reversed or unparseable range is empty — the caller gets no columns rather
 * than wrong ones.
 */
export function monthsBetween(from: string, to: string): string[] {
  const start = monthIndex(from)
  const end = monthIndex(to)
  if (start == null || end == null || end < start) return []
  const months: string[] = []
  for (let i = start; i <= end && months.length < MAX_MONTHS; i += 1) {
    months.push(`${String(Math.floor(i / 12)).padStart(4, '0')}-${String((i % 12) + 1).padStart(2, '0')}`)
  }
  return months
}

export interface ProfitReportOptions {
  from: string
  to: string
  groupBy: ReportGroupBy
  filters?: ReportFilters
  /** Staff id → display name, for the REP grouping. */
  staffNames?: Record<string, string>
}

/** What a sample has to match; an unset filter matches everything. */
function matchesFilters(sample: LaneRateSampleRecord, filters: ReportFilters | undefined): boolean {
  if (!filters) return true
  const division = text(filters.divisionKey)
  if (division && text(sample.divisionKey) !== division) return false
  const team = text(filters.teamKey)
  if (team && text(sample.teamKey) !== team) return false
  const customerId = text(filters.customerId)
  if (customerId && text(sample.customerId) !== customerId) return false
  const carrierId = text(filters.carrierId)
  if (carrierId && text(sample.carrierId) !== carrierId) return false
  const mode = text(filters.mode)
  if (mode && text(sample.mode) !== mode) return false
  const equipment = text(filters.equipmentType)
  if (equipment && text(sample.equipmentType) !== equipment) return false
  const repId = text(filters.repId)
  // A rep owns the load from either side of it: the customer's or the carrier's.
  if (repId && text(sample.customerRepId) !== repId && text(sample.carrierRepId) !== repId) return false
  return true
}

/** Our own trucks are one column, never one per asset: their cost is a settlement. */
const OWN_FLEET_KEY = 'OWN_FLEET'

/** The bucket a sample lands in, and the best name we have for it. */
function bucketOf(
  sample: LaneRateSampleRecord,
  groupBy: ReportGroupBy,
  staffNames: Record<string, string> | undefined,
): { key: string; name: string | null } {
  switch (groupBy) {
    case 'REP': {
      const key = text(sample.customerRepId)
      return { key, name: key ? (staffNames?.[key] ?? null) : null }
    }
    case 'CUSTOMER':
      return { key: text(sample.customerId), name: text(sample.customerName) || null }
    case 'CARRIER':
      return sample.assignmentKind === 'OWN_ASSET'
        ? { key: OWN_FLEET_KEY, name: 'Own fleet' }
        : { key: text(sample.carrierId), name: text(sample.carrierName) || null }
    case 'DIVISION':
      return { key: text(sample.divisionKey), name: null }
    case 'TEAM':
      return { key: text(sample.teamKey), name: null }
    case 'MODE':
      return { key: text(sample.mode), name: null }
    case 'EQUIPMENT':
      return { key: text(sample.equipmentType), name: null }
    case 'MONTH': {
      const key = text(sample.sampleMonth) || text(sample.date).slice(0, 7)
      return { key, name: key }
    }
  }
}

/** One group's running sums, before the ratios are worked out. */
interface Bucket {
  key: string
  name: string | null
  loads: number
  revenueCents: number
  costCents: number
  profitCents: number
  miles: number
  ownFleet: number
}

function rowOf(bucket: Bucket): ReportRow {
  const { revenueCents, costCents, profitCents, miles } = bucket
  return {
    key: bucket.key,
    label: bucket.name ?? (bucket.key || 'Unassigned'),
    loads: bucket.loads,
    revenueCents,
    costCents,
    profitCents,
    marginBps: revenueCents === 0 ? null : roundHalfAwayFromZero((profitCents * 10_000) / revenueCents),
    miles,
    rpmCents: miles === 0 ? null : roundHalfAwayFromZero(revenueCents / miles),
    cpmCents: miles === 0 ? null : roundHalfAwayFromZero(costCents / miles),
    ownFleet: bucket.ownFleet,
  }
}

/**
 * Revenue, cost, profit and margin over a window, cut one way.
 *
 * In scope: not excluded, inside `[from, to]` (a month end means its last day), and
 * matching every filter that is set. `totals` is folded out of the rows, so it is the
 * sum of what is shown by construction — a filtered-out load can never hide in it.
 */
export function profitReport(samples: LaneRateSampleRecord[], opts: ProfitReportOptions): ProfitReport {
  const fromRaw = text(opts.from)
  const toRaw = text(opts.to)
  const from = fromRaw.length === 7 ? `${fromRaw}-01` : fromRaw.slice(0, 10)
  const to = toRaw.length === 7 ? monthEnd(toRaw) : toRaw.slice(0, 10)
  const buckets = new Map<string, Bucket>()
  let excluded = 0

  for (const sample of samples) {
    const date = text(sample.date).slice(0, 10)
    if (!date || date < from || date > to) continue
    if (!matchesFilters(sample, opts.filters)) continue
    if (sample.excluded === true) {
      excluded += 1
      continue
    }
    const { key, name } = bucketOf(sample, opts.groupBy, opts.staffNames)
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { key, name, loads: 0, revenueCents: 0, costCents: 0, profitCents: 0, miles: 0, ownFleet: 0 }
      buckets.set(key, bucket)
    } else if (!bucket.name && name) {
      // The first sample of a bucket may be the one missing the name; take a later one.
      bucket.name = name
    }
    const revenue = num(sample.revenueCents)
    const cost = num(sample.costCents)
    bucket.loads += 1
    bucket.revenueCents += revenue
    bucket.costCents += cost
    // A stored profit is what finance signed off on; only an absent one is re-derived.
    bucket.profitCents += sample.profitCents == null ? revenue - cost : num(sample.profitCents)
    bucket.miles += num(sample.miles)
    if (sample.assignmentKind === 'OWN_ASSET') bucket.ownFleet += 1
  }

  const total: Bucket = {
    key: 'TOTAL',
    name: 'Total',
    loads: 0,
    revenueCents: 0,
    costCents: 0,
    profitCents: 0,
    miles: 0,
    ownFleet: 0,
  }
  const rows: ReportRow[] = []
  for (const bucket of buckets.values()) {
    total.loads += bucket.loads
    total.revenueCents += bucket.revenueCents
    total.costCents += bucket.costCents
    total.profitCents += bucket.profitCents
    total.miles += bucket.miles
    total.ownFleet += bucket.ownFleet
    rows.push(rowOf(bucket))
  }

  if (opts.groupBy === 'MONTH') rows.sort((a, b) => a.key.localeCompare(b.key))
  else rows.sort((a, b) => b.profitCents - a.profitCents || a.label.localeCompare(b.label))

  return { rows, totals: rowOf(total), excluded }
}

/**
 * How many of something sit on each rung — the board counts. Busiest rung first, ties
 * broken alphabetically so two equal columns never shuffle between renders.
 */
export function pipelineCounts(rows: { status?: string | null }[]): { status: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const status = text(row.status)
    counts.set(status, (counts.get(status) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count || a.status.localeCompare(b.status))
}

export interface QuoteFunnelInput {
  status?: string | null
  sentAt?: string | null
  respondedAt?: string | null
  amountCents?: number | null
}

export interface QuoteFunnel {
  sent: number
  won: number
  lost: number
  open: number
  winRateBps: number | null
  medianHoursToReply: number | null
  wonCents: number
}

/** Hours between two stamps, or null when either is unusable or they run backwards. */
function hoursBetween(from: string | null | undefined, to: string | null | undefined): number | null {
  const start = Date.parse(text(from))
  const end = Date.parse(text(to))
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
  return (end - start) / 3_600_000
}

/** The middle value, averaging the two middles of an even count. */
function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Quotes sent, won, lost, still out — and how long we make a customer wait for an
 * answer. A quote nobody sent is in no bucket at all; a PASS is a loss, because the
 * freight went elsewhere either way. The win rate ignores the open ones: it is won
 * over decided, not won over sent.
 */
export function quoteFunnel(quotes: QuoteFunnelInput[]): QuoteFunnel {
  let sent = 0
  let won = 0
  let lost = 0
  let open = 0
  let wonCents = 0
  const replies: number[] = []

  for (const quote of quotes) {
    const wasSent = text(quote.sentAt) !== ''
    if (wasSent) sent += 1
    const status = text(quote.status).toUpperCase()
    if (status === 'WON') {
      won += 1
      wonCents += num(quote.amountCents)
    } else if (status === 'LOST' || status === 'PASS') {
      lost += 1
    } else if (wasSent) {
      open += 1
    }
    const hours = hoursBetween(quote.sentAt, quote.respondedAt)
    if (hours != null) replies.push(hours)
  }

  const decided = won + lost
  const middle = median(replies)
  return {
    sent,
    won,
    lost,
    open,
    winRateBps: decided === 0 ? null : roundHalfAwayFromZero((won * 10_000) / decided),
    medianHoursToReply: middle == null ? null : Math.round(middle * 10) / 10,
    wonCents,
  }
}

export interface CommissionReportRow {
  repId: string
  repName: string
  count: number
  amountCents: number
  netCents: number
  unapprovedCents: number
  paidCents: number
}

export type CommissionReportTotals = Omit<CommissionReportRow, 'repId' | 'repName'>

export interface CommissionReport {
  rows: CommissionReportRow[]
  totals: CommissionReportTotals
}

/** Rungs where the money is still being argued about. */
const UNAPPROVED_STATUS: Record<string, true> = {
  UN_APPROVED: true,
  REP_COUNTERED: true,
  MANAGER_COUNTERED: true,
}

/**
 * What each rep is owed. A CANCELLED row is not a commission at all: it is in neither
 * the money nor the count, because telling a rep "12 commissions, 10 paid" when two
 * were voided reads as two missing payments.
 */
export function commissionReport(
  rows: CommissionRecord[],
  staffNames?: Record<string, string>,
): CommissionReport {
  const byRep = new Map<string, CommissionReportRow>()
  const totals: CommissionReportTotals = {
    count: 0,
    amountCents: 0,
    netCents: 0,
    unapprovedCents: 0,
    paidCents: 0,
  }

  for (const row of rows) {
    const status = text(row.status).toUpperCase()
    if (status === 'CANCELLED') continue
    const repId = text(row.repId)
    let entry = byRep.get(repId)
    if (!entry) {
      entry = {
        repId,
        repName: staffNames?.[repId] || text(row.repName) || repId || 'Unassigned',
        count: 0,
        amountCents: 0,
        netCents: 0,
        unapprovedCents: 0,
        paidCents: 0,
      }
      byRep.set(repId, entry)
    }
    const amount = num(row.amountCents)
    const net = num(row.netCents)
    entry.count += 1
    entry.amountCents += amount
    entry.netCents += net
    totals.count += 1
    totals.amountCents += amount
    totals.netCents += net
    if (UNAPPROVED_STATUS[status]) {
      entry.unapprovedCents += net
      totals.unapprovedCents += net
    } else if (status === 'PAID') {
      entry.paidCents += net
      totals.paidCents += net
    }
  }

  const list = [...byRep.values()].sort(
    (a, b) => b.netCents - a.netCents || a.repName.localeCompare(b.repName),
  )
  return { rows: list, totals }
}

/**
 * Quote every field, doubling embedded quotes per RFC 4180 — the `agingCsv` convention.
 * Always quoting means a customer name with a comma, a quote or a newline in it can't
 * shift the money columns one to the left.
 */
const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`

/** Integer cents → a plain `1234.50` a spreadsheet will parse as a number. */
const dollars = (cents: number) => {
  const abs = Math.abs(Math.round(cents))
  return `${cents < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

export const REPORT_CSV_COLUMNS = [
  'Loads',
  'Revenue',
  'Cost',
  'Profit',
  'Margin %',
  'Miles',
  'RPM',
  'CPM',
  'Own fleet',
] as const

/** One table line; an undefined ratio is an empty cell, never a zero. */
function csvLine(row: ReportRow): string {
  return [
    row.label,
    row.loads,
    dollars(row.revenueCents),
    dollars(row.costCents),
    dollars(row.profitCents),
    row.marginBps == null ? '' : (row.marginBps / 100).toFixed(1),
    row.miles,
    row.rpmCents == null ? '' : dollars(row.rpmCents),
    row.cpmCents == null ? '' : dollars(row.cpmCents),
    row.ownFleet,
  ]
    .map(q)
    .join(',')
}

/** The profit table as a CSV, in the order given, totals on the last line. */
export function reportCsv(rows: ReportRow[], totals: ReportRow, groupByLabel: string): string {
  const header = [groupByLabel, ...REPORT_CSV_COLUMNS].map(q).join(',')
  return [header, ...rows.map(csvLine), csvLine(totals)].join('\n')
}
