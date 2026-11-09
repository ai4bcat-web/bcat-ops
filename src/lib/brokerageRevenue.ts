/**
 * Brokerage revenue / expense / profit by month and by sales rep (pure; no React, no I/O).
 *
 * Reads the DashboardRollup month rows the TMS dashboard already uses, so its figures are the same
 * figures as the Company / Brokerage strips:
 *  - one row per DELIVERED, priced Load (a `LaneRateSample`, written from `LoadFinancials`),
 *    booked on the day its delivery stop is appointed (else the day it was delivered);
 *  - revenue = `LoadFinancials.revenueCents` (customer side), expense = `LoadFinancials.costCents`
 *    (carrier side), profit = revenue − expense, profit % = profit ÷ revenue (no revenue = no %);
 *  - voided shipments, canceled shipments and TONU'd carriers are not counted (`excluded`);
 *  - BROKERAGE = `Shipment.revDivision` BROKERAGE and any division that sits under it.
 *
 * The month view adds the day rows (`fin`) of the DashboardRollup month rows; the rep view adds the private per-rep
 * month objects (`RepMonth`, served by the caller-filtered Brokerage action). Both come from the same counted samples,
 * so the rep rows of a month add up to its month row.
 */
import { NO_REP_KEY, type FinScope, type MonthPayload, type RepKey, type RepSplit, type RollupRow, type ScopeKey } from './dashboardRollup'
import { topLevelOf } from './ownership'

export const BROKERAGE_DIVISION = 'BROKERAGE'

export interface DivisionShape { code: string; parentId?: string | null }

export interface Measures {
  /** Delivered loads counted. */
  loads: number
  revenueCents: number
  expenseCents: number
  profitCents: number
  /** Profit in basis points of revenue; `null` when there is no revenue (shown as a dash). */
  marginBps: number | null
}

export interface MonthMeasures extends Measures { month: string }
export interface RepMeasures extends Measures {
  repKey: RepKey
  /** Display name; the "No sales rep" row has `repKey` `''`. */
  label: string
}

export const NO_REP_LABEL = 'No sales rep'

function split(scope: ScopeKey): { division: string; subdivision: string } {
  const at = scope.indexOf('|')
  return { division: scope.slice(0, at), subdivision: scope.slice(at + 1) }
}

/** Whether a `division|subdivision` rollup scope belongs to Brokerage (the division itself or anything under it). */
export function isBrokerageScope(scope: ScopeKey, divisions: readonly DivisionShape[]): boolean {
  const { division, subdivision } = split(scope)
  const code = subdivision || division
  if (!code) return false
  if (code === BROKERAGE_DIVISION || division === BROKERAGE_DIVISION) return true
  return topLevelOf(divisions.map((d) => ({ id: d.code, code: d.code, parentId: d.parentId ?? null })), code) === BROKERAGE_DIVISION
}

export function marginBpsOf(revenueCents: number, profitCents: number): number | null {
  return revenueCents > 0 ? Math.round((profitCents / revenueCents) * 10000) : null
}

interface Sum { loads: number; revenue: number; expense: number }
const zero = (): Sum => ({ loads: 0, revenue: 0, expense: 0 })
function add(into: Sum, f: FinScope): void {
  into.loads += f.n
  into.revenue += f.rev
  into.expense += f.cost
}
function measures(sum: Sum): Measures {
  const profit = sum.revenue - sum.expense
  return { loads: sum.loads, revenueCents: sum.revenue, expenseCents: sum.expense, profitCents: profit, marginBps: marginBpsOf(sum.revenue, profit) }
}

/** `YYYY-MM` months from `from` to `to` inclusive (a reversed pair is swapped). */
export function monthsBetween(from: string, to: string): string[] {
  const [lo, hi] = from <= to ? [from, to] : [to, from]
  const out: string[] = []
  let [y, m] = lo.split('-').map(Number) as [number, number]
  const [hy, hm] = hi.split('-').map(Number) as [number, number]
  while (y < hy || (y === hy && m <= hm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`)
    m += 1
    if (m > 12) { m = 1; y += 1 }
  }
  return out
}

/** The last `count` months ending at `current`, oldest first. */
export function trailingMonths(current: string, count: number): string[] {
  let [y, m] = current.split('-').map(Number) as [number, number]
  m -= count - 1
  while (m < 1) { m += 12; y -= 1 }
  return monthsBetween(`${y}-${String(m).padStart(2, '0')}`, current)
}

export type Totals = Measures

/** Sum of the rows with the margin recomputed, never averaged. */
export function totalsOf(rows: readonly Measures[]): Totals {
  const sum = zero()
  for (const r of rows) { sum.loads += r.loads; sum.revenue += r.revenueCents; sum.expense += r.expenseCents }
  return measures(sum)
}

/**
 * One row per month in `months` (a month with nothing booked is a zero row with no %), from the month rows
 * given. Day rows outside the month (cannot happen for a well-formed row) are ignored.
 */
export function monthRows(
  rows: readonly RollupRow<MonthPayload>[],
  months: readonly string[],
  divisions: readonly DivisionShape[],
): MonthMeasures[] {
  const byMonth = new Map(rows.map((r) => [r.payload.month, r.payload]))
  return months.map((month) => {
    const sum = zero()
    const payload = byMonth.get(month)
    for (const [day, perScope] of Object.entries(payload?.fin ?? {})) {
      if (day.slice(0, 7) !== month) continue
      for (const [scope, f] of Object.entries(perScope)) if (isBrokerageScope(scope, divisions)) add(sum, f)
    }
    return { month, ...measures(sum) }
  })
}

/** One month of the per-rep split as the Brokerage action returns it (a rep caller's map holds only their own rep). */
export interface RepMonth { month: string; rep: RepSplit }

/** Month rows summed from the rep split: the month view for a caller who may only see their own figures. */
export function monthRowsFromRep(rows: readonly RepMonth[], months: readonly string[], divisions: readonly DivisionShape[]): MonthMeasures[] {
  const byMonth = new Map(rows.map((r) => [r.month, r.rep]))
  return months.map((month) => {
    const sum = zero()
    for (const [scope, perRep] of Object.entries(byMonth.get(month) ?? {})) {
      if (!isBrokerageScope(scope, divisions)) continue
      for (const f of Object.values(perRep)) add(sum, f)
    }
    return { month, ...measures(sum) }
  })
}

export interface RepNames {
  /** Profile id (Cognito username) -> display name. */
  byId: ReadonlyMap<string, string>
}

export function repLabelOf(key: RepKey, names: RepNames): string {
  if (key === NO_REP_KEY) return NO_REP_LABEL
  const value = key.slice(2)
  if (key.startsWith('i:')) return names.byId.get(value) ?? value
  return value
}

/**
 * One row per sales rep over `months`, biggest profit first, with "No sales rep" always present as its own
 * row (last) so the rows add up to `monthRows` for the same months. A rep known both by id and by name stays
 * two rows only when the name has no profile; `i:` rows with the same display name are merged.
 */
export function repRows(
  rows: readonly RepMonth[],
  months: readonly string[],
  divisions: readonly DivisionShape[],
  names: RepNames,
): RepMeasures[] {
  const wanted = new Set(months)
  const sums = new Map<string, { key: RepKey; label: string; sum: Sum }>()
  const touch = (key: RepKey): Sum => {
    const label = repLabelOf(key, names)
    // Same person under a profile id and a typed name collapse into one row; "No sales rep" is its own row.
    const merge = key === NO_REP_KEY ? '' : `n:${label.trim().toLowerCase()}`
    let entry = sums.get(merge)
    if (!entry) { entry = { key, label, sum: zero() }; sums.set(merge, entry) }
    return entry.sum
  }
  touch(NO_REP_KEY)
  for (const row of rows) {
    if (!wanted.has(row.month)) continue
    for (const [scope, perRep] of Object.entries(row.rep)) {
      if (!isBrokerageScope(scope, divisions)) continue
      for (const [key, f] of Object.entries(perRep)) add(touch(key), f)
    }
  }
  const out = [...sums.values()].map(({ key, label, sum }) => ({ repKey: key, label, ...measures(sum) }))
  const none = out.filter((r) => r.repKey === NO_REP_KEY)
  const reps = out
    .filter((r) => r.repKey !== NO_REP_KEY && r.loads > 0)
    .sort((a, b) => b.profitCents - a.profitCents || b.revenueCents - a.revenueCents || a.label.localeCompare(b.label))
  return [...reps, ...none]
}

export interface TieOut {
  ok: boolean
  /** Rep total minus month total, per measure (all zero when it ties). */
  revenueDiffCents: number
  expenseDiffCents: number
  loadsDiff: number
}

/** The rep rows must add up to the month rows for the same months. */
export function tieOut(byMonth: readonly Measures[], byRep: readonly Measures[]): TieOut {
  const m = totalsOf(byMonth)
  const r = totalsOf(byRep)
  const revenueDiffCents = r.revenueCents - m.revenueCents
  const expenseDiffCents = r.expenseCents - m.expenseCents
  const loadsDiff = r.loads - m.loads
  return { ok: revenueDiffCents === 0 && expenseDiffCents === 0 && loadsDiff === 0, revenueDiffCents, expenseDiffCents, loadsDiff }
}
