/**
 * The dashboard's own state, as pure functions: the filter row's defaults and date
 * presets, the saved views in `localStorage`, and the CSV the export icon writes.
 *
 * Dates are handled in UTC, the same way `dashboardCharts` slices an ISO instant, so a
 * window means the same day boundaries on screen and in the arithmetic.
 */
import type { ChartSeries, DashboardFilters, DashboardGroupBy } from './types'

export const GROUP_BY_OPTIONS: { value: DashboardGroupBy; label: string }[] = [
  { value: 'DIVISION', label: 'Division' },
  { value: 'SUBDIVISION', label: 'Subdivision' },
  { value: 'REP', label: 'Rep' },
  { value: 'CUSTOMER', label: 'Customer' },
  { value: 'CARRIER', label: 'Carrier' },
  { value: 'STATUS', label: 'Status' },
  { value: 'MONTH', label: 'Month' },
]

export const CLASSIC_VIEW = 'Classic'

export type DatePresetKey = 'this-month' | 'last-month' | 'last-30' | 'custom'

export const DATE_PRESETS: { key: DatePresetKey; label: string }[] = [
  { key: 'this-month', label: 'This month' },
  { key: 'last-month', label: 'Last month' },
  { key: 'last-30', label: 'Last 30 days' },
  { key: 'custom', label: 'Custom' },
]

function isoDay(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** `from`/`to` for a preset. `custom` keeps whatever the window already is. */
export function presetRange(key: Exclude<DatePresetKey, 'custom'>, nowIso: string): { from: string; to: string } {
  const now = new Date(nowIso)
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth() + 1
  if (key === 'this-month') {
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
    return { from: isoDay(year, month, 1), to: isoDay(year, month, last) }
  }
  if (key === 'last-month') {
    const prevYear = month === 1 ? year - 1 : year
    const prevMonth = month === 1 ? 12 : month - 1
    const last = new Date(Date.UTC(prevYear, prevMonth, 0)).getUTCDate()
    return { from: isoDay(prevYear, prevMonth, 1), to: isoDay(prevYear, prevMonth, last) }
  }
  const to = now.toISOString().slice(0, 10)
  const start = new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000)
  return { from: start.toISOString().slice(0, 10), to }
}

/** What the page opens on: every division, this month, nothing else narrowed. */
export function defaultFilters(nowIso: string): DashboardFilters {
  const { from, to } = presetRange('this-month', nowIso)
  return {
    divisions: [],
    subdivisions: [],
    from,
    to,
    mode: null,
    status: null,
    customerId: null,
    carrierId: null,
    repId: null,
  }
}

/** Which preset a window is, so the chip can read "Pick Up this month 10/1 – 10/31". */
export function presetOf(filters: Pick<DashboardFilters, 'from' | 'to'>, nowIso: string): DatePresetKey {
  for (const preset of ['this-month', 'last-month', 'last-30'] as const) {
    const range = presetRange(preset, nowIso)
    if (range.from === filters.from && range.to === filters.to) return preset
  }
  return 'custom'
}

/** `'2026-10-01'`, `'2026-10-31'` → `'10/1 – 10/31'`. */
export function rangeLabel(from: string, to: string): string {
  const short = (day: string) => {
    const [, month, date] = day.split('-')
    return month && date ? `${Number(month)}/${Number(date)}` : day
  }
  return `${short(from)} – ${short(to)}`
}

export function dateChipLabel(filters: Pick<DashboardFilters, 'from' | 'to'>, nowIso: string): string {
  const preset = presetOf(filters, nowIso)
  const name = preset === 'this-month' ? 'this month'
    : preset === 'last-month' ? 'last month'
      : preset === 'last-30' ? 'last 30 days'
        : 'custom'
  return `${name} ${rangeLabel(filters.from, filters.to)}`
}

// ── Saved views ──────────────────────────────────────────────────────────────

export interface SavedDashboardView {
  name: string
  chartKeys: string[]
  filters: DashboardFilters
  groupBy: DashboardGroupBy | null
}

export function dashboardViewsKey(email: string | null | undefined): string {
  return `tms-dashboard-views:${email ?? 'anonymous'}`
}

/** Saved views for one signed-in user. A corrupt entry is dropped, never thrown. */
export function readDashboardViews(email: string | null | undefined): SavedDashboardView[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(dashboardViewsKey(email))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((view): view is SavedDashboardView =>
      Boolean(view) && typeof (view as SavedDashboardView).name === 'string'
      && Array.isArray((view as SavedDashboardView).chartKeys)
      && Boolean((view as SavedDashboardView).filters))
  } catch {
    return []
  }
}

export function writeDashboardViews(email: string | null | undefined, views: SavedDashboardView[]): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(dashboardViewsKey(email), JSON.stringify(views))
  } catch {
    // A full or disabled storage loses the view, never the dashboard.
  }
}

// ── Export ───────────────────────────────────────────────────────────────────

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/**
 * The visible cards as one CSV: a title line per card, then its table exactly as the
 * `#` view shows it. KPI tiles export as label/value pairs.
 */
export function chartsToCsv(cards: Array<{ title: string; series: ChartSeries }>): string {
  const lines: string[] = []
  for (const card of cards) {
    lines.push(csvCell(card.title))
    const { series } = card
    if (series.kpis?.length) {
      lines.push('Metric,Value')
      for (const kpi of series.kpis) lines.push(`${csvCell(kpi.label)},${csvCell(kpi.value)}`)
    }
    if (series.rows.length > 0) {
      const columns = series.columns
      const header = columns
        ? ['Name', ...columns.map((column) => column.label)]
        : ['Name', ...series.groups.map((group) => (group === 'total' ? 'Value' : group))]
      lines.push(header.map(csvCell).join(','))
      for (const row of series.rows) {
        const cells = columns
          ? columns.map((column) => (column.format === 'text' || column.format === 'date'
            ? row.text?.[column.key] ?? ''
            : String(row.values[column.key] ?? 0)))
          : series.groups.map((group) => String(row.values[group] ?? 0))
        lines.push([csvCell(row.label), ...cells.map(csvCell)].join(','))
      }
    }
    if (series.note) lines.push(csvCell(series.note))
    lines.push('')
  }
  return lines.join('\n')
}
