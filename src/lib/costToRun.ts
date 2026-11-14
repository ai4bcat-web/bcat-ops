/**
 * Settings > Cost to run: what BCAT Ops costs to keep running, by category, month and week.
 *
 * The daily figures come from `scripts/costCollector.mjs` (launchd, once a day on the Mac),
 * stored as DashboardRollup rows 'COST:YYYY-MM' (days → service → cents) and 'COST:META'
 * (the service list and freshness). Services with no billing API are fixed monthly costs an
 * admin types in (TmsSettings.costManualEntries); they are spread evenly over the days of
 * each month they cover. Everything here is pure so the card and the CSV agree.
 */

export type CostCategory = 'hosting' | 'backend' | 'email' | 'auth' | 'phone' | 'ai' | 'thirdparty' | 'dev' | 'other'
export type CostSource = 'billed' | 'estimated' | 'manual'

export const COST_CATEGORIES: { key: CostCategory; label: string }[] = [
  { key: 'hosting', label: 'Hosting' },
  { key: 'backend', label: 'Backend (API, database, functions, storage)' },
  { key: 'email', label: 'E-mail' },
  { key: 'auth', label: 'Sign-in' },
  { key: 'phone', label: 'Phone & texts' },
  { key: 'ai', label: 'AI agents' },
  { key: 'thirdparty', label: 'Third-party services' },
  { key: 'dev', label: 'Dev & testing' },
  { key: 'other', label: 'Other' },
]

export const categoryLabel = (key: string): string => COST_CATEGORIES.find((c) => c.key === key)?.label ?? 'Other'

export interface CostService {
  key: string
  label: string
  category: CostCategory
  source: CostSource
  note?: string | null
}

export interface CostManualEntry {
  id: string
  label: string
  category: CostCategory
  monthlyCents: number
  /** First month it applies, 'YYYY-MM'. Null = since the start of the history. */
  startMonth?: string | null
  /** Last month it applies. Null = still running. */
  endMonth?: string | null
  note?: string | null
}

export interface CostMonthRow {
  month: string
  days: Record<string, Record<string, number>>
  /** Spend in the same AWS account that is not BCAT Ops (outreach-engine and friends). */
  excluded: Record<string, number>
}

export interface CostMeta {
  services: CostService[]
  asOf: string | null
  collectedAt: string | null
  sources: Record<string, { ok: boolean; at?: string; error?: string }>
  notes: string[]
}

/** Every day from `start` to `end`, both included. */
export function daysBetween(start: string, end: string): string[] {
  const out: string[] = []
  const d = new Date(`${start}T00:00:00Z`)
  const stop = new Date(`${end}T00:00:00Z`)
  while (d <= stop) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1) }
  return out
}

export const daysInMonth = (month: string): number =>
  new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate()

/** The Monday that starts the week holding `day` (weeks run Monday to Sunday). */
export function weekOf(day: string): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  return d.toISOString().slice(0, 10)
}

export const manualKey = (id: string) => `manual.${id}`

/** The services the page knows of: the collector's list plus one per manual entry. */
export function allServices(meta: CostMeta | null, manual: CostManualEntry[]): CostService[] {
  return [
    ...(meta?.services ?? []),
    ...manual.map((m) => ({ key: manualKey(m.id), label: m.label, category: m.category, source: 'manual' as const, note: m.note ?? null })),
  ]
}

const manualApplies = (m: CostManualEntry, month: string) =>
  (!m.startMonth || month >= m.startMonth) && (!m.endMonth || month <= m.endMonth)

/**
 * Daily cents per service from `first` to `last`, collector rows and manual entries together.
 * A manual entry adds monthlyCents / days-in-month to each day of a month it covers.
 */
export function dailyCosts(rows: CostMonthRow[], manual: CostManualEntry[], first: string, last: string): Map<string, Record<string, number>> {
  const byDay = new Map<string, Record<string, number>>()
  const stored = new Map<string, Record<string, number>>()
  for (const r of rows) for (const [d, svc] of Object.entries(r.days)) stored.set(d, svc)
  for (const d of daysBetween(first, last)) {
    const day: Record<string, number> = { ...(stored.get(d) ?? {}) }
    const month = d.slice(0, 7)
    for (const m of manual) if (manualApplies(m, month)) day[manualKey(m.id)] = m.monthlyCents / daysInMonth(month)
    byDay.set(d, day)
  }
  return byDay
}

export interface PeriodTotals {
  /** 'YYYY-MM' for months, the Monday 'YYYY-MM-DD' for weeks. */
  period: string
  total: number
  byCategory: Record<string, number>
  byService: Record<string, number>
  /** Days in the period with data (a partial current period has fewer). */
  days: number
}

/** Sum the daily figures into months or weeks, oldest first. */
export function totalsBy(unit: 'month' | 'week', daily: Map<string, Record<string, number>>, services: CostService[]): PeriodTotals[] {
  const catOf = new Map(services.map((s) => [s.key, s.category as string]))
  const out = new Map<string, PeriodTotals>()
  for (const [d, svc] of daily) {
    const period = unit === 'month' ? d.slice(0, 7) : weekOf(d)
    const p = out.get(period) ?? { period, total: 0, byCategory: {}, byService: {}, days: 0 }
    p.days += 1
    for (const [k, cents] of Object.entries(svc)) {
      const cat = catOf.get(k) ?? 'other'
      p.total += cents
      p.byCategory[cat] = (p.byCategory[cat] ?? 0) + cents
      p.byService[k] = (p.byService[k] ?? 0) + cents
    }
    out.set(period, p)
  }
  return [...out.values()].sort((a, b) => a.period.localeCompare(b.period))
}

export interface CostHeadline {
  monthToDate: number
  lastMonth: number
  avgWeek12: number
  projectedMonth: number
}

/**
 * Header figures as of `asOf` (the last day with collected data). The projection runs the
 * month's daily average so far over the whole month; manual entries are already spread per day.
 */
export function headline(daily: Map<string, Record<string, number>>, asOf: string): CostHeadline {
  const month = asOf.slice(0, 7)
  const sumDays = (pred: (d: string) => boolean) => {
    let t = 0
    for (const [d, svc] of daily) if (pred(d)) for (const c of Object.values(svc)) t += c
    return t
  }
  const prev = new Date(`${month}-01T00:00:00Z`)
  prev.setUTCMonth(prev.getUTCMonth() - 1)
  const lastMonthKey = prev.toISOString().slice(0, 7)
  const monthToDate = sumDays((d) => d.slice(0, 7) === month && d <= asOf)
  const elapsed = Number(asOf.slice(8, 10))
  // The last 12 full weeks before the week holding asOf.
  const thisWeek = weekOf(asOf)
  const from = new Date(`${thisWeek}T00:00:00Z`)
  from.setUTCDate(from.getUTCDate() - 84)
  const fromKey = from.toISOString().slice(0, 10)
  return {
    monthToDate,
    lastMonth: sumDays((d) => d.slice(0, 7) === lastMonthKey),
    avgWeek12: sumDays((d) => d >= fromKey && d < thisWeek) / 12,
    projectedMonth: elapsed > 0 ? (monthToDate / elapsed) * daysInMonth(month) : 0,
  }
}

export const dollars = (cents: number): string =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })

const csvCell = (v: string | number) => {
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** One row per period and service, plus each period's total: what the page's table shows. */
export function costCsv(periods: PeriodTotals[], services: CostService[]): string {
  const lines = [['Period', 'Category', 'Service', 'Source', 'Cost (USD)'].join(',')]
  for (const p of periods) {
    for (const s of services) {
      const c = p.byService[s.key]
      if (!c) continue
      lines.push([p.period, categoryLabel(s.category), s.label, s.source, (c / 100).toFixed(2)].map(csvCell).join(','))
    }
    lines.push([p.period, 'Total', '', '', (p.total / 100).toFixed(2)].map(csvCell).join(','))
  }
  return lines.join('\n')
}

/** AWSJSON arrives as a string (sometimes twice over); unwrap to the object. */
export function parseJsonField(value: unknown): unknown {
  let v = value
  for (let i = 0; typeof v === 'string' && i < 3; i++) {
    try { v = JSON.parse(v) } catch { return null }
  }
  return v
}

export function toMonthRow(id: string, payload: unknown): CostMonthRow | null {
  const p = parseJsonField(payload) as { days?: CostMonthRow['days']; excluded?: CostMonthRow['excluded'] } | null
  if (!p || typeof p !== 'object') return null
  return { month: id.replace(/^COST:/, ''), days: p.days ?? {}, excluded: p.excluded ?? {} }
}

export function toMeta(payload: unknown): CostMeta | null {
  const p = parseJsonField(payload) as Partial<CostMeta> | null
  if (!p || typeof p !== 'object') return null
  return { services: p.services ?? [], asOf: p.asOf ?? null, collectedAt: p.collectedAt ?? null, sources: p.sources ?? {}, notes: p.notes ?? [] }
}

/** The COST:YYYY-MM ids for the `count` months ending with `lastMonth`. */
export function costMonthIds(lastMonth: string, count: number): string[] {
  const ids: string[] = []
  const d = new Date(`${lastMonth}-01T00:00:00Z`)
  for (let i = 0; i < count; i++) {
    ids.unshift(`COST:${d.toISOString().slice(0, 7)}`)
    d.setUTCMonth(d.getUTCMonth() - 1)
  }
  return ids
}
