/**
 * Pure projections behind `/reports`. Everything here decides or formats; `ReportsPage`
 * renders what these functions return — the `arViews.ts` split.
 *
 * Nothing in this file reads the network or the clock: the page passes one `now`, so the
 * period picker, the default window and every panel answer about the same day.
 *
 * No number is invented here. The money formatters take integer cents straight from the
 * libs, the filter options are the values that are actually present in the window's
 * samples, and a ratio nobody can compute prints an em dash rather than a zero — "no
 * margin because there was no revenue" and "zero margin" are different facts.
 */
import { formatCents } from '@/lib/invoiceBuild'
import type { LaneRateSampleRecord, ProfitReport, ReportGroupBy } from '@/types/tms'

/**
 * `$1,234.56`, thousands separated — the app's one money formatter, re-exported under
 * the name this page uses. (`tmsDirectory`'s `formatCents` groups nothing and must not
 * be used for a figure anyone reads.)
 */
export { formatCents as formatMoneyCents }

export type ReportTabKey = 'profit' | 'pipeline' | 'ar' | 'ap' | 'quotes' | 'commissions'

export const REPORT_TABS: { key: ReportTabKey; label: string }[] = [
  { key: 'profit', label: 'Profit' },
  { key: 'pipeline', label: 'Pipeline' },
  { key: 'ar', label: 'AR' },
  { key: 'ap', label: 'AP' },
  { key: 'quotes', label: 'Quotes' },
  { key: 'commissions', label: 'Commissions' },
]

export const GROUP_BY_OPTIONS: { value: ReportGroupBy; label: string }[] = [
  { value: 'REP', label: 'Rep' },
  { value: 'CUSTOMER', label: 'Customer' },
  { value: 'CARRIER', label: 'Carrier' },
  { value: 'DIVISION', label: 'Division' },
  { value: 'TEAM', label: 'Team' },
  { value: 'MODE', label: 'Mode' },
  { value: 'EQUIPMENT', label: 'Equipment' },
  { value: 'MONTH', label: 'Month' },
]

/** `'YYYY-MM'` of a date or timestamp, or null when the string carries no month. */
function monthOf(value: string): string | null {
  const m = /^(\d{4})-(\d{2})/.exec(value.trim())
  return m ? `${m[1]}-${m[2]}` : null
}

/** `'YYYY-MM'` shifted by whole months, with the year rolled. */
function shiftMonth(month: string, by: number): string {
  const year = Number(month.slice(0, 4))
  const index = year * 12 + (Number(month.slice(5, 7)) - 1) + by
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`
}

/**
 * The window the page opens on: this month and the two before it.
 *
 * The month is taken off the front of the string rather than through `Date`, so the
 * caller decides the time zone by what it passes (the page passes the Chicago day). A
 * string with no month in it yields an empty window, and an empty window reports no
 * data rather than a wrong quarter.
 */
export function defaultRange(nowIso: string): { from: string; to: string } {
  const to = monthOf(nowIso)
  if (!to) return { from: '', to: '' }
  return { from: shiftMonth(to, -2), to }
}

/** The months the period picker offers, newest first, ending at `now`'s month. */
export function monthChoices(nowIso: string, count = 18): string[] {
  const latest = monthOf(nowIso)
  if (!latest) return []
  return Array.from({ length: Math.max(1, count) }, (_, i) => shiftMonth(latest, -i))
}

/** `4670` → `46.7%`. A margin nobody can compute is an em dash, never `0.0%`. */
export function formatMarginBps(bps: number | null | undefined): string {
  if (bps == null || !Number.isFinite(bps)) return '—'
  return `${(bps / 100).toFixed(1)}%`
}

/** Revenue or cost per mile. No miles on the loads means no rate, not a free mile. */
export function formatPerMile(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return '—'
  return formatCents(cents)
}

export interface FilterOption {
  value: string
  label: string
}

export interface ReportFilterOptions {
  divisions: FilterOption[]
  teams: FilterOption[]
  modes: FilterOption[]
  equipment: FilterOption[]
  carriers: FilterOption[]
  customers: FilterOption[]
}

/** Adds one value, keeping the first non-empty label we see for it. */
function collect(into: Map<string, string>, value: string | null | undefined, label?: string | null) {
  const key = (value ?? '').trim()
  if (!key) return
  const name = (label ?? '').trim()
  const current = into.get(key)
  if (current == null || (current === key && name)) into.set(key, name || key)
}

function options(from: Map<string, string>): FilterOption[] {
  return [...from.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

/**
 * The filter values that are actually in the window, each with the best name the samples
 * carry. Only what is present is offered: a dropdown listing every division we have ever
 * had invites the office to filter a window down to nothing and read that as a loss.
 *
 * Own-fleet loads have no carrier, so they are in no carrier option — they are their own
 * row in the carrier cut instead.
 */
export function filterOptionsFrom(samples: LaneRateSampleRecord[]): ReportFilterOptions {
  const divisions = new Map<string, string>()
  const teams = new Map<string, string>()
  const modes = new Map<string, string>()
  const equipment = new Map<string, string>()
  const carriers = new Map<string, string>()
  const customers = new Map<string, string>()

  for (const s of samples) {
    collect(divisions, s.divisionKey)
    collect(teams, s.teamKey)
    collect(modes, s.mode)
    collect(equipment, s.equipmentType)
    collect(carriers, s.carrierId, s.carrierName)
    collect(customers, s.customerId, s.customerName)
  }

  return {
    divisions: options(divisions),
    teams: options(teams),
    modes: options(modes),
    equipment: options(equipment),
    carriers: options(carriers),
    customers: options(customers),
  }
}

/**
 * What has to be said out loud when our own trucks are in the table: their revenue is
 * here, their cost is not — it is paid out as driver settlements, fuel and fixed costs on
 * `/finances`. Printing their margin beside a brokered lane's would flatter the fleet by
 * exactly the amount it costs to run.
 *
 * Null when no own-asset load is in scope, so the note never appears without a reason.
 */
export function ownFleetNote(report: ProfitReport): string | null {
  const loads = report.totals.ownFleet
  if (!loads || loads <= 0) return null
  return `${loads} load${loads === 1 ? '' : 's'} here ran on our own trucks. Their revenue is counted, but their cost is paid out in driver settlements and fleet expenses, so their margin is not comparable with a brokered load.`
}
