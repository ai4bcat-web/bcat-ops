/**
 * Step AI §2.2/§5.2 — the widget executors. Every catalog query runs through `runWidget`, which
 * receives ONLY a `VisibleReader`: methods that return rows the viewer is already allowed to see
 * (built by `makeVisibleReader` in ./visibleReader). There is no raw reader, table name or
 * viewer in here to read around it, so aggregates, group labels, top-N and lists are computed
 * from visible rows by construction. Window = pickup day (shipments), sample `date` (revenue),
 * quote date (quotes), UTC calendar.
 *
 * Table-shaped results: `columns[0]` is the label column (`values[0]` null, `text[0]` = label);
 * every row's `values`/`text` have `columns.length` entries; numeric columns read `values[i]`,
 * text columns `text[i]`. Chart-shaped results: `values[i]` aligns with `groups[i]`.
 * Relative imports only (Lambda-bundled).
 */
import { marginBpsOf } from '../dashboardRollup'
import { QUERY_CATALOG } from './catalog'
import type {
  DashboardFilters,
  DashboardSpec,
  QueryParams,
  ResultFormat,
  ResultSeries,
  Widget,
  WidgetResult,
  WidgetType,
} from './types'
import { resolveWindow } from './windows'

// ── Rows the reader serves (already filtered) ────────────────────────────────

export interface SampleRow {
  shipmentId: string
  date: string
  excluded?: boolean | null
  revenueCents?: number | null
  costCents?: number | null
  profitCents?: number | null
  customerId?: string | null
  customerName?: string | null
  carrierName?: string | null
  revDivision?: string | null
  revSubdivision?: string | null
  salesRepId?: string | null
  customerRepId?: string | null
  mode?: string | null
}

export interface ShipmentRow {
  id: string
  number?: string | null
  status?: string | null
  pickupAppt?: string | null
  customerId?: string | null
  customerName?: string | null
  revDivision?: string | null
  revSubdivision?: string | null
  salesRepId?: string | null
  mode?: string | null
}

/** An open invoice joined with its shipment's division / rep (an invoice has no rep field). */
export interface InvoiceRow {
  id: string
  number?: string | null
  customerId?: string | null
  customerName?: string | null
  invoiceDate?: string | null
  dueAt?: string | null
  balanceCents?: number | null
  shipmentId?: string | null
  revDivision?: string | null
  revSubdivision?: string | null
  salesRepId?: string | null
}

export interface QuoteRow {
  id: string
  side?: string | null
  status?: string | null
  quoteDate?: string | null
  customerId?: string | null
  customerName?: string | null
  customerRepId?: string | null
  mode?: string | null
  amountCents?: number | null
}

export interface VisibleReader {
  samples(month: string): Promise<SampleRow[]>
  shipments(month: string): Promise<ShipmentRow[]>
  openInvoices(): Promise<InvoiceRow[]>
  quotes(month: string): Promise<QuoteRow[]>
}

export interface RunCtx {
  /** Any ISO instant; only its UTC date is read. */
  now: string
  /** Epoch ms after which a widget that has not started returns an error instead of running. */
  deadlineMs?: number
  divisions: readonly { code: string; name: string; parentId: string | null }[]
  /** Staff display names by id (lower-cased id and e-mail). */
  repNames?: ReadonlyMap<string, string>
}

// ── Helpers ──────────────────────────────────────────────────────────────────

type Fmt = ResultFormat
const FIN_LABEL: Record<string, string> = { revenue: 'Revenue', cost: 'Cost', profit: 'Profit', margin: 'Margin', count: 'Shipments' }
const FIN_FMT: Record<string, Fmt> = { revenue: 'cents', cost: 'cents', profit: 'cents', margin: 'bps', count: 'count' }
const inTransitStatuses = new Set(['PICKED_UP', 'IN_TRANSIT', 'RECOVERED', 'ARRIVED_AT_DELIVERY_TERMINAL', 'OUT_FOR_DELIVERY', 'UNLOADING'])
const closedStatuses = new Set(['DELIVERED', 'CANCELED', 'TENDER_REJECTED', 'DRAFT'])
const openQuoteStatuses = new Set(['DRAFT', 'REQUESTED', 'QUOTED', 'SENT_COUNTER', 'RECEIVED_REPLY', 'RECEIVED_COUNTER'])
const DAY_MS = 86_400_000
const norm = (s: string | null | undefined) => (typeof s === 'string' ? s.trim().toLowerCase() : '')

const strParam = (p: QueryParams, k: string): string => String(p[k] ?? '')
const numParam = (p: QueryParams, k: string): number => Number(p[k] ?? 0)
const listParam = (p: QueryParams, k: string): string[] => (Array.isArray(p[k]) ? (p[k] as string[]) : [])

function dayOf(iso: string | null | undefined): string {
  return typeof iso === 'string' ? iso.slice(0, 10) : ''
}

function mondayOf(day: string): string {
  const ms = Date.parse(`${day}T00:00:00Z`)
  if (Number.isNaN(ms)) return day
  const dow = (new Date(ms).getUTCDay() + 6) % 7
  return new Date(ms - dow * DAY_MS).toISOString().slice(0, 10)
}

function daysBetween(fromDay: string, toDay: string): number {
  return Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / DAY_MS)
}

/** Division codes a filter selects, descendants included. */
function divisionSet(codes: readonly string[], tree: RunCtx['divisions']): Set<string> {
  const out = new Set(codes)
  let grew = true
  while (grew) {
    grew = false
    for (const d of tree) if (d.parentId && out.has(d.parentId) && !out.has(d.code)) { out.add(d.code); grew = true }
  }
  return out
}

interface Facets {
  customerId?: string | null
  revDivision?: string | null
  revSubdivision?: string | null
  salesRepId?: string | null
  customerRepId?: string | null
  mode?: string | null
}

function matcher(f: DashboardFilters, ctx: RunCtx, supports: { divisions: boolean; customers: boolean; reps: boolean; modes: boolean }) {
  const divs = supports.divisions && f.divisions.length ? divisionSet(f.divisions, ctx.divisions) : null
  const customers = supports.customers && f.customerIds.length ? new Set(f.customerIds) : null
  const reps = supports.reps && f.repIds.length ? new Set(f.repIds.map(norm)) : null
  const modes = supports.modes && f.modes.length ? new Set(f.modes) : null
  return (r: Facets): boolean => {
    if (divs && !((r.revDivision && divs.has(r.revDivision)) || (r.revSubdivision && divs.has(r.revSubdivision)))) return false
    if (customers && !(r.customerId && customers.has(r.customerId))) return false
    if (reps && !(reps.has(norm(r.salesRepId)) || reps.has(norm(r.customerRepId)))) return false
    if (modes && !(r.mode && modes.has(r.mode))) return false
    return true
  }
}

interface Item { label: string; value: number | null }

function repLabel(id: string | null | undefined, ctx: RunCtx): string {
  const key = norm(id)
  if (!key) return 'Unassigned'
  return ctx.repNames?.get(key) ?? String(id)
}

function divisionLabel(code: string | null | undefined, ctx: RunCtx): string {
  if (!code) return 'No division'
  return ctx.divisions.find((d) => d.code === code)?.name ?? code
}

/** Draws `items` as the widget's type. */
function shape(type: WidgetType, labelHeader: string, valueHeader: string, items: Item[], format: Fmt, note?: string): { kind: 'bar' | 'line' | 'pie' | 'table'; series: ResultSeries } {
  if (type === 'TABLE' || type === 'LIST') {
    return {
      kind: 'table',
      series: {
        rows: items.map((i) => ({ label: i.label, values: [null, i.value], text: [i.label, ''] })),
        groups: [],
        columns: [{ key: 'label', label: labelHeader }, { key: 'value', label: valueHeader, format }],
        valueFormat: format,
        ...(note ? { note } : {}),
      },
    }
  }
  const kind = type === 'LINE' ? 'line' : type === 'PIE' ? 'pie' : 'bar'
  return {
    kind,
    series: {
      rows: items.map((i) => ({ label: i.label, values: [i.value] })),
      groups: [valueHeader],
      valueFormat: format,
      ...(note ? { note } : {}),
    },
  }
}

function kpis(items: { label: string; value: number | null; format: Fmt }[], note?: string): { kind: 'kpis'; series: ResultSeries } {
  return { kind: 'kpis', series: { kpis: items, rows: [], groups: [], valueFormat: 'count', ...(note ? { note } : {}) } }
}

/** A text table (LIST widgets and the recent-* TABLEs). */
function listTable(columns: { key: string; label: string; format?: Fmt }[], rows: string[][], note?: string): { kind: 'table'; series: ResultSeries } {
  return {
    kind: 'table',
    series: {
      rows: rows.map((cells) => ({ label: cells[0] ?? '', values: columns.map(() => null), text: cells })),
      groups: [],
      columns,
      valueFormat: 'count',
      ...(note ? { note } : {}),
    },
  }
}

function topN(map: Map<string, Item>, limit: number): Item[] {
  return [...map.values()].sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity) || a.label.localeCompare(b.label)).slice(0, limit)
}

interface Acc { revenue: number; cost: number; profit: number; count: number }
const emptyAcc = (): Acc => ({ revenue: 0, cost: 0, profit: 0, count: 0 })
function addSample(a: Acc, s: SampleRow): void {
  a.revenue += s.revenueCents ?? 0
  a.cost += s.costCents ?? 0
  a.profit += s.profitCents ?? 0
  a.count += 1
}
function metricOf(a: Acc, metric: string): number | null {
  if (metric === 'count') return a.count
  if (a.count === 0) return null
  if (metric === 'margin') return marginBpsOf(a.revenue, a.profit)
  return a[metric as 'revenue' | 'cost' | 'profit']
}

function fmtDay(ctx: RunCtx): string {
  return ctx.now.slice(0, 10)
}

// ── The catalog, one executor per id ─────────────────────────────────────────

interface Win { from: string; to: string; months: string[] }
interface Env { reader: VisibleReader; win: Win; ctx: RunCtx; widget: Widget; filters: DashboardFilters; p: QueryParams; today: string; note?: string }

async function pricedSamples(e: Env): Promise<SampleRow[]> {
  const sup = QUERY_CATALOG[e.widget.query.id].supports
  const ok = matcher(e.filters, e.ctx, sup)
  const per = await Promise.all(e.win.months.map((m) => e.reader.samples(m)))
  return per.flat().filter((s) => s.excluded !== true && s.date >= e.win.from && s.date <= e.win.to && ok(s))
}

async function windowShipments(e: Env): Promise<ShipmentRow[]> {
  const ok = matcher(e.filters, e.ctx, QUERY_CATALOG[e.widget.query.id].supports)
  const per = await Promise.all(e.win.months.map((m) => e.reader.shipments(m)))
  return per.flat().filter((s) => {
    const d = dayOf(s.pickupAppt)
    return d >= e.win.from && d <= e.win.to && ok(s)
  })
}

async function openInvoices(e: Env): Promise<InvoiceRow[]> {
  const ok = matcher(e.filters, e.ctx, QUERY_CATALOG[e.widget.query.id].supports)
  return (await e.reader.openInvoices()).filter((i) => (i.balanceCents ?? 0) > 0 && ok(i))
}

async function windowQuotes(e: Env): Promise<QuoteRow[]> {
  const ok = matcher(e.filters, e.ctx, QUERY_CATALOG[e.widget.query.id].supports)
  const per = await Promise.all(e.win.months.map((m) => e.reader.quotes(m)))
  return per.flat().filter((q) => q.side !== 'BUY' && (q.quoteDate ?? '') >= e.win.from && (q.quoteDate ?? '') <= e.win.to && ok(q))
}

type Out = { kind: 'kpis' | 'bar' | 'line' | 'pie' | 'table'; series: ResultSeries }

interface GroupRow {
  customerId?: string | null
  customerName?: string | null
  carrierName?: string | null
  salesRepId?: string | null
  customerRepId?: string | null
  revDivision?: string | null
  mode?: string | null
}

function groupKey(by: string, r: GroupRow, ctx: RunCtx): { key: string; label: string } {
  switch (by) {
    case 'CUSTOMER': return { key: r.customerId ?? '', label: r.customerName || r.customerId || 'No customer' }
    case 'REP': {
      const id = r.salesRepId || r.customerRepId || ''
      return { key: norm(id), label: repLabel(id, ctx) }
    }
    case 'CARRIER': return { key: r.carrierName ?? '', label: r.carrierName || 'No carrier' }
    case 'DIVISION': return { key: r.revDivision ?? '', label: divisionLabel(r.revDivision, ctx) }
    default: return { key: r.mode ?? '', label: r.mode || 'No mode' }
  }
}

const GROUP_HEADER: Record<string, string> = { CUSTOMER: 'Customer', REP: 'Rep', CARRIER: 'Carrier', DIVISION: 'Division', MODE: 'Mode' }

const EXECUTORS: Record<string, (e: Env) => Promise<Out>> = {
  async 'fin.summary'(e) {
    const acc = emptyAcc()
    for (const s of await pricedSamples(e)) addSample(acc, s)
    return kpis(listParam(e.p, 'metrics').map((m) => ({ label: FIN_LABEL[m] ?? m, value: metricOf(acc, m), format: FIN_FMT[m] ?? 'count' })))
  },

  async 'fin.byGroup'(e) {
    const metric = strParam(e.p, 'metric')
    const by = strParam(e.p, 'groupBy')
    const groups = new Map<string, { label: string; acc: Acc }>()
    for (const s of await pricedSamples(e)) {
      const g = groupKey(by, s, e.ctx)
      const slot = groups.get(g.key) ?? { label: g.label, acc: emptyAcc() }
      addSample(slot.acc, s)
      groups.set(g.key, slot)
    }
    const items = new Map([...groups].map(([k, v]) => [k, { label: v.label, value: metricOf(v.acc, metric) }]))
    return shape(e.widget.type, GROUP_HEADER[by] ?? 'Group', FIN_LABEL[metric] ?? metric, topN(items, numParam(e.p, 'limit')), FIN_FMT[metric] ?? 'count')
  },

  async 'fin.byTime'(e) {
    const metric = strParam(e.p, 'metric')
    const week = strParam(e.p, 'grain') === 'WEEK'
    const buckets = new Map<string, Acc>()
    for (const s of await pricedSamples(e)) {
      const k = week ? mondayOf(s.date) : s.date.slice(0, 7)
      const a = buckets.get(k) ?? emptyAcc()
      addSample(a, s)
      buckets.set(k, a)
    }
    const items = [...buckets].sort(([a], [b]) => a.localeCompare(b)).map(([label, a]) => ({ label, value: metricOf(a, metric) }))
    return shape(e.widget.type, week ? 'Week of' : 'Month', FIN_LABEL[metric] ?? metric, items, FIN_FMT[metric] ?? 'count')
  },

  async 'ship.summary'(e) {
    const rows = await windowShipments(e)
    const count = (f: (s: ShipmentRow) => boolean) => rows.filter(f).length
    const all: Record<string, [string, number]> = {
      count: ['Shipments', rows.length],
      delivered: ['Delivered', count((s) => s.status === 'DELIVERED')],
      inTransit: ['In transit', count((s) => inTransitStatuses.has(s.status ?? ''))],
      open: ['Open', count((s) => !closedStatuses.has(s.status ?? ''))],
    }
    return kpis(listParam(e.p, 'metrics').map((m) => ({ label: all[m]?.[0] ?? m, value: all[m]?.[1] ?? null, format: 'count' as Fmt })))
  },

  async 'ship.byStatus'(e) {
    const m = new Map<string, Item>()
    for (const s of await windowShipments(e)) {
      const k = s.status ?? 'UNKNOWN'
      const slot = m.get(k) ?? { label: k.replace(/_/g, ' '), value: 0 }
      slot.value = (slot.value ?? 0) + 1
      m.set(k, slot)
    }
    return shape(e.widget.type, 'Status', 'Shipments', topN(m, 25), 'count')
  },

  async 'ship.byTime'(e) {
    const week = strParam(e.p, 'grain') === 'WEEK'
    const b = new Map<string, number>()
    for (const s of await windowShipments(e)) {
      const d = dayOf(s.pickupAppt)
      const k = week ? mondayOf(d) : d.slice(0, 7)
      b.set(k, (b.get(k) ?? 0) + 1)
    }
    const items = [...b].sort(([a], [c]) => a.localeCompare(c)).map(([label, value]) => ({ label, value }))
    return shape(e.widget.type, week ? 'Week of' : 'Month', 'Shipments', items, 'count')
  },

  async 'ship.byGroup'(e) {
    const by = strParam(e.p, 'groupBy')
    const m = new Map<string, Item>()
    for (const s of await windowShipments(e)) {
      const g = groupKey(by, s, e.ctx)
      const slot = m.get(g.key) ?? { label: g.label, value: 0 }
      slot.value = (slot.value ?? 0) + 1
      m.set(g.key, slot)
    }
    return shape(e.widget.type, GROUP_HEADER[by] ?? 'Group', 'Shipments', topN(m, numParam(e.p, 'limit')), 'count')
  },

  async 'ship.recent'(e) {
    const rows = (await windowShipments(e)).sort((a, b) => (b.pickupAppt ?? '').localeCompare(a.pickupAppt ?? '')).slice(0, numParam(e.p, 'limit'))
    return listTable(
      [{ key: 'shipment', label: 'Shipment' }, { key: 'customer', label: 'Customer' }, { key: 'status', label: 'Status' }, { key: 'pickup', label: 'Pickup' }],
      rows.map((s) => [s.number || s.id, s.customerName || '', (s.status ?? '').replace(/_/g, ' '), dayOf(s.pickupAppt)]),
    )
  },

  async 'ar.summary'(e) {
    const rows = await openInvoices(e)
    const overdue = rows.filter((i) => (i.dueAt ?? '9999') < e.today)
    const sum = (xs: InvoiceRow[]) => xs.reduce((a, i) => a + (i.balanceCents ?? 0), 0)
    const ages = rows.filter((i) => i.invoiceDate).map((i) => daysBetween(i.invoiceDate as string, e.today))
    const all: Record<string, [string, number | null, Fmt]> = {
      open: ['Open AR', rows.length ? sum(rows) : null, 'cents'],
      overdue: ['Overdue', rows.length ? sum(overdue) : null, 'cents'],
      count: ['Open invoices', rows.length, 'count'],
      avgDaysOpen: ['Avg days open', ages.length ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length) : null, 'count'],
    }
    return kpis(listParam(e.p, 'metrics').map((m) => ({ label: all[m]?.[0] ?? m, value: all[m]?.[1] ?? null, format: all[m]?.[2] ?? 'count' })))
  },

  async 'ar.aging'(e) {
    const buckets = [
      { label: '0-30', max: 30, value: 0 },
      { label: '31-60', max: 60, value: 0 },
      { label: '61-90', max: 90, value: 0 },
      { label: '90+', max: Infinity, value: 0 },
    ]
    const rows = await openInvoices(e)
    for (const i of rows) {
      const past = i.dueAt ? daysBetween(i.dueAt, e.today) : 0
      const b = buckets.find((x) => past <= x.max) ?? buckets[3]!
      b.value += i.balanceCents ?? 0
    }
    return shape(e.widget.type, 'Days past due', 'Open AR', buckets.map((b) => ({ label: b.label, value: rows.length ? b.value : null })), 'cents')
  },

  async 'ar.byCustomer'(e) {
    const m = new Map<string, Item>()
    for (const i of await openInvoices(e)) {
      const g = groupKey('CUSTOMER', i, e.ctx)
      const slot = m.get(g.key) ?? { label: g.label, value: 0 }
      slot.value = (slot.value ?? 0) + (i.balanceCents ?? 0)
      m.set(g.key, slot)
    }
    return shape(e.widget.type, 'Customer', 'Open AR', topN(m, numParam(e.p, 'limit')), 'cents')
  },

  async 'ar.list'(e) {
    const sort = strParam(e.p, 'sort')
    const rows = (await openInvoices(e))
      .sort((a, b) => (sort === 'balance' ? (b.balanceCents ?? 0) - (a.balanceCents ?? 0) : (a.dueAt ?? '').localeCompare(b.dueAt ?? '')))
      .slice(0, numParam(e.p, 'limit'))
    return listTable(
      [{ key: 'invoice', label: 'Invoice' }, { key: 'customer', label: 'Customer' }, { key: 'due', label: 'Due' }, { key: 'balance', label: 'Balance' }],
      rows.map((i) => [i.number || i.id, i.customerName || '', i.dueAt ?? '', money(i.balanceCents ?? 0)]),
    )
  },

  async 'quote.summary'(e) {
    const rows = await windowQuotes(e)
    const won = rows.filter((q) => q.status === 'WON').length
    const lost = rows.filter((q) => q.status === 'LOST').length
    const all: Record<string, [string, number | null, Fmt]> = {
      count: ['Quotes', rows.length, 'count'],
      won: ['Won', won, 'count'],
      lost: ['Lost', lost, 'count'],
      // 0-100 with one decimal; null while nothing is decided yet.
      winRate: ['Win rate', won + lost > 0 ? Math.round((won / (won + lost)) * 1000) / 10 : null, 'percent'],
      openValue: ['Open value', rows.length ? rows.filter((q) => openQuoteStatuses.has(q.status ?? '')).reduce((a, q) => a + (q.amountCents ?? 0), 0) : null, 'cents'],
    }
    return kpis(listParam(e.p, 'metrics').map((m) => ({ label: all[m]?.[0] ?? m, value: all[m]?.[1] ?? null, format: all[m]?.[2] ?? 'count' })))
  },

  async 'quote.byStatus'(e) {
    const m = new Map<string, Item>()
    for (const q of await windowQuotes(e)) {
      const k = q.status ?? 'UNKNOWN'
      const slot = m.get(k) ?? { label: k.replace(/_/g, ' '), value: 0 }
      slot.value = (slot.value ?? 0) + 1
      m.set(k, slot)
    }
    return shape(e.widget.type, 'Status', 'Quotes', topN(m, 25), 'count')
  },

  async 'quote.byCustomer'(e) {
    const value = strParam(e.p, 'metric') === 'value'
    const m = new Map<string, Item>()
    for (const q of await windowQuotes(e)) {
      const g = groupKey('CUSTOMER', q, e.ctx)
      const slot = m.get(g.key) ?? { label: g.label, value: 0 }
      slot.value = (slot.value ?? 0) + (value ? (q.amountCents ?? 0) : 1)
      m.set(g.key, slot)
    }
    return shape(e.widget.type, 'Customer', value ? 'Quote value' : 'Quotes', topN(m, numParam(e.p, 'limit')), value ? 'cents' : 'count')
  },

  async 'quote.recent'(e) {
    const rows = (await windowQuotes(e)).sort((a, b) => (b.quoteDate ?? '').localeCompare(a.quoteDate ?? '')).slice(0, numParam(e.p, 'limit'))
    return listTable(
      [{ key: 'date', label: 'Date' }, { key: 'customer', label: 'Customer' }, { key: 'status', label: 'Status' }, { key: 'amount', label: 'Amount' }],
      rows.map((q) => [q.quoteDate ?? '', q.customerName || '', (q.status ?? '').replace(/_/g, ' '), money(q.amountCents ?? 0)]),
    )
  },
}

function money(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`
}

// ── Entry points ─────────────────────────────────────────────────────────────

/**
 * Runs one widget through the reader. Never throws: a failure is a per-widget `{ ok:false }`.
 * `win` is the already-resolved window (shared by the dashboard).
 */
export async function runWidget(widget: Widget, filters: DashboardFilters, reader: VisibleReader, ctx: RunCtx, win?: Win): Promise<WidgetResult> {
  try {
    if (ctx.deadlineMs != null && Date.now() > ctx.deadlineMs) {
      return { widgetId: widget.id, ok: false, error: 'This widget ran out of time. Try again or shorten the window.' }
    }
    const meta = QUERY_CATALOG[widget.query.id]
    const exec = EXECUTORS[widget.query.id]
    if (!meta || !exec) return { widgetId: widget.id, ok: false, error: 'Unknown query' }
    const w = win ?? resolveWindow(filters.window, ctx.now)
    if (meta.maxMonths != null && w.months.length > meta.maxMonths) {
      return { widgetId: widget.id, ok: false, error: `${meta.label} can cover at most ${meta.maxMonths} months. Shorten the window.` }
    }
    const note: string[] = []
    if (!meta.supports.divisions && filters.divisions.length) note.push('Quotes are not split by division')
    const out = await exec({ reader, win: w, ctx, widget, filters, p: widget.query.params, today: fmtDay(ctx) })
    if (note.length) out.series = { ...out.series, note: note.join('. ') }
    return { widgetId: widget.id, ok: true, kind: out.kind, series: out.series }
  } catch (err) {
    return { widgetId: widget.id, ok: false, error: err instanceof Error && err.message ? err.message.slice(0, 200) : 'This widget failed to load' }
  }
}

/** Runs every widget (concurrency 4, results in spec order). The window is resolved once. */
export async function runSpec(spec: DashboardSpec, reader: VisibleReader, ctx: RunCtx): Promise<{ results: WidgetResult[]; resolved: Win }> {
  const win = resolveWindow(spec.filters.window, ctx.now)
  const results: WidgetResult[] = new Array<WidgetResult>(spec.widgets.length)
  let next = 0
  const workers = Array.from({ length: Math.min(4, spec.widgets.length) }, async () => {
    while (next < spec.widgets.length) {
      const i = next++
      results[i] = await runWidget(spec.widgets[i]!, spec.filters, reader, ctx, win)
    }
  })
  await Promise.all(workers)
  return { results, resolved: win }
}
