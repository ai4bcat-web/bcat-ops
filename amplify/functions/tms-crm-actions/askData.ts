/**
 * Ask BCAT — the governed, read-only data layer behind `describe_data` and `query_data`.
 *
 * The model never sees a table name or writes a query string. It names a DATASET from the
 * catalog below, the METRICS it wants, up to two GROUP-BY dimensions, FILTERS on dimensions and
 * a time window; this file loads that dataset's rows, checks the caller may use it, aggregates
 * and returns a small JSON result (money in cents). Adding a question the model can answer is
 * adding a dimension or a metric here, not writing a new tool.
 *
 * Access: every dataset has a level. `ROW_VISIBLE` rows go through the dashboards' one row
 * predicate (`canSeeRow`), so a rep sees only their own customers' loads. `FINANCE`
 * (owner, ADMIN, AR/AP role) and `OWNER` (owner, ADMIN) datasets are all-or-nothing and DENY BY
 * DEFAULT: a viewer below the level gets the same refusal text whatever the data holds.
 * Nothing here writes. Logs counts only (the caller audits tool names, never rows).
 */
import { MAX_CUSTOM_DAYS, resolveWindow, type ResolvedWindow } from '../../../src/lib/dashboards/windows'
import type { DashboardWindow, WindowPreset } from '../../../src/lib/dashboards/types'
import { canSeeRow, type DataViewer, type VisCustomer } from '../../../src/lib/dataVisibility'
import { invoiceState } from '../../../src/lib/invoiceStatus'
import { normalizeName } from '../_shared/directoryKeys'
import type { Row } from '../_shared/crmStore'
import type { AskSource } from './askSources'
import type { DivisionRow, StaffRow } from './dashSources'

export type Level = 'ROW_VISIBLE' | 'FINANCE' | 'OWNER'
export type Unit = 'cents' | 'count' | 'miles' | 'percent' | 'centsPerMile' | 'gallons'

/** One loaded row: its dates, its dimension values and the numbers that add up. */
export interface Rec {
  dates: Record<string, string>
  dim: Record<string, string>
  v: Record<string, number>
}

type Totals = Record<string, number>

export interface MetricDef {
  label: string
  unit: Unit
  /** A sum of one base field, or a ratio of sums (null when it has no meaning, e.g. no revenue). */
  calc: (t: Totals) => number | null
}

export interface AskEnv {
  ask: AskSource
  viewer: DataViewer
  customers: ReadonlyMap<string, VisCustomer>
  divisions: readonly DivisionRow[]
  staff: readonly StaffRow[]
  /** ISO date `YYYY-MM-DD` (UTC). */
  today: string
}

export interface Dataset {
  id: string
  label: string
  description: string
  level: Level
  dateFields: { default: string; options: Record<string, string> }
  dims: Record<string, string>
  metrics: Record<string, MetricDef>
  defaultMetrics: string[]
  notes: string[]
  /** Rows whose chosen date falls inside the window (the engine filters again by exact day). */
  load(env: AskEnv, win: ResolvedWindow): Promise<Rec[]>
}

// ── Small helpers ───────────────────────────────────────────────────────────

const str = (r: Row, k: string): string => (typeof r[k] === 'string' ? (r[k] as string).trim() : '')
const num = (r: Row, k: string): number => (typeof r[k] === 'number' && Number.isFinite(r[k]) ? (r[k] as number) : 0)
const sum = (k: string) => (t: Totals): number => t[k] ?? 0
const ratio = (a: string, b: string, scale = 1) => (t: Totals): number | null => ((t[b] ?? 0) > 0 ? ((t[a] ?? 0) * scale) / (t[b] as number) : null)

/** The Chicago calendar day of an instant (stored datetimes are UTC). */
export function chicagoDay(iso: string): string {
  if (!iso) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return ''
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' })
}

const dayPart = (v: string): string => (/^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : '')

export function weekStart(day: string): string {
  const d = new Date(`${day}T12:00:00Z`)
  const back = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - back)
  return d.toISOString().slice(0, 10)
}

const norm = (s: string): string => normalizeName(s)

const nameIndex = (staff: readonly StaffRow[]): ((id: string) => string) => {
  const byKey = new Map<string, string>()
  for (const s of staff) {
    byKey.set(s.id.trim().toLowerCase(), s.name)
    if (s.email) byKey.set(s.email.trim().toLowerCase(), s.name)
  }
  return (id) => byKey.get(id.trim().toLowerCase()) ?? ''
}

export function mayUse(level: Level, viewer: DataViewer): boolean {
  if (level === 'ROW_VISIBLE') return true
  if (level === 'FINANCE') return viewer.isOwnerOrAdmin || viewer.role === 'AR_AP'
  return viewer.isOwnerOrAdmin
}

export const denied = (label: string): string =>
  `Your access does not include ${label}. Say so plainly and suggest asking an owner or admin; do not guess a number.`

// ── Datasets ────────────────────────────────────────────────────────────────

const DELIVERED: Dataset = {
  id: 'delivered_loads',
  label: 'Delivered loads (revenue, cost, profit)',
  description:
    'One row per delivered, priced load, by the day it delivered (Chicago). The same facts the Dashboard reads, so totals match it. Canceled and TONU loads are excluded.',
  level: 'ROW_VISIBLE',
  dateFields: { default: 'delivered', options: { delivered: 'the day the load delivered' } },
  dims: {
    customer: 'customer name', carrier: 'carrier name (empty for own-fleet loads)', rep: 'sales rep', division: 'business / division',
    subdivision: 'sub-division', mode: 'FTL, LTL, DRAYAGE...', ownership: 'Own fleet or Carrier (brokered)', equipment: 'equipment type',
    status: 'load status', rateType: 'SPOT or CONTRACT',
  },
  metrics: {
    loads: { label: 'Delivered loads', unit: 'count', calc: sum('n') },
    revenue: { label: 'Revenue', unit: 'cents', calc: sum('revenue') },
    cost: { label: 'Carrier cost', unit: 'cents', calc: sum('cost') },
    profit: { label: 'Profit', unit: 'cents', calc: sum('profit') },
    margin: { label: 'Profit margin', unit: 'percent', calc: ratio('profit', 'revenue', 100) },
    miles: { label: 'Loaded miles', unit: 'miles', calc: sum('miles') },
    revenuePerMile: { label: 'Revenue per mile', unit: 'centsPerMile', calc: ratio('revenueMi', 'miles') },
    costPerMile: { label: 'Cost per mile', unit: 'centsPerMile', calc: ratio('costMi', 'miles') },
    profitPerMile: { label: 'Profit per mile', unit: 'centsPerMile', calc: ratio('profitMi', 'miles') },
    avgRevenue: { label: 'Average revenue per load', unit: 'cents', calc: ratio('revenue', 'n') },
    avgProfit: { label: 'Average profit per load', unit: 'cents', calc: ratio('profit', 'n') },
  },
  defaultMetrics: ['loads', 'revenue', 'profit', 'margin'],
  notes: ['Own-fleet loads carry no carrier cost here; the fleet cost side (driver pay, fuel, insurance) is in the fleet_pnl tool.'],
  async load(env, win) {
    const months = win.months.slice(0, 14)
    const perMonth = await Promise.all(months.map((m) => env.ask.samples(m)))
    const divName = new Map(env.divisions.map((d) => [d.code, d.name]))
    const repName = nameIndex(env.staff)
    const out: Rec[] = []
    for (const r of perMonth.flat()) {
      if (r.excluded === true) continue
      const day = dayPart(str(r, 'date'))
      if (!day || day < win.from || day > win.to) continue
      const seen = canSeeRow(env.viewer, { customerId: str(r, 'customerId') || null, salesRepId: str(r, 'salesRepId') || null, customerRepId: str(r, 'customerRepId') || null }, env.customers)
      if (!seen) continue
      const miles = num(r, 'miles')
      const revenue = num(r, 'revenueCents')
      const cost = num(r, 'costCents')
      const profit = num(r, 'profitCents')
      const code = str(r, 'revDivision')
      out.push({
        dates: { delivered: day },
        dim: {
          customer: str(r, 'customerName'), carrier: str(r, 'carrierName'),
          rep: repName(str(r, 'salesRepId')) || str(r, 'salesRepId'),
          division: divName.get(code) ?? code, subdivision: str(r, 'revSubdivision'), mode: str(r, 'mode'),
          ownership: str(r, 'assignmentKind') === 'OWN_ASSET' ? 'Own fleet' : 'Carrier', equipment: str(r, 'equipmentType'),
          status: str(r, 'loadStatus'), rateType: str(r, 'rateType'),
        },
        v: { n: 1, revenue, cost, profit, miles, revenueMi: miles > 0 ? revenue : 0, costMi: miles > 0 ? cost : 0, profitMi: miles > 0 ? profit : 0 },
      })
    }
    return out
  },
}

const CARRIER_BILLS: Dataset = {
  id: 'carrier_bills',
  label: 'Carrier bills (accounts payable)',
  description: 'One row per carrier bill (what we owe carriers and factors). Voided and archived bills are left out.',
  level: 'FINANCE',
  dateFields: { default: 'billDate', options: { billDate: 'the carrier invoice date', dueDate: 'the due date', paidDate: 'the day it was fully paid (Chicago)' } },
  dims: { status: 'IN_REVIEW, TO_BE_PAID, PARTIAL, PAID', carrier: 'carrier name', payee: 'Carrier (direct) or Factor', division: 'division key', quickPay: 'yes or no' },
  metrics: {
    bills: { label: 'Bills', unit: 'count', calc: sum('n') },
    gross: { label: 'Gross (carrier lines)', unit: 'cents', calc: sum('gross') },
    net: { label: 'Net after quick-pay fee', unit: 'cents', calc: sum('net') },
    billed: { label: 'Billed by the carrier', unit: 'cents', calc: sum('billed') },
    paid: { label: 'Paid', unit: 'cents', calc: sum('paid') },
    credited: { label: 'Credited', unit: 'cents', calc: sum('credited') },
    balance: { label: 'Still owed', unit: 'cents', calc: sum('balance') },
    quickPayFees: { label: 'Quick-pay fees', unit: 'cents', calc: sum('fee') },
  },
  defaultMetrics: ['bills', 'net', 'paid', 'balance'],
  notes: ['paidDate is empty for bills not fully paid, so grouping by it shows paid bills only.'],
  async load(env, win) {
    const rows = await env.ask.carrierBills()
    const out: Rec[] = []
    for (const r of rows) {
      const status = str(r, 'status')
      if (status === 'VOID' || str(r, 'voidedAt') || str(r, 'archivedAt')) continue
      const billDate = dayPart(str(r, 'billDate'))
      const dueDate = dayPart(str(r, 'dueAt'))
      const paidDate = chicagoDay(str(r, 'paidAt'))
      if (![billDate, dueDate, paidDate].some((d) => d && d >= win.from && d <= win.to)) continue
      out.push({
        dates: { billDate, dueDate, paidDate },
        dim: { status, carrier: str(r, 'carrierName'), payee: str(r, 'payeeKind') === 'FACTOR' ? 'Factor' : 'Carrier', division: str(r, 'divisionKey'), quickPay: r.quickPay === true ? 'yes' : 'no' },
        v: { n: 1, gross: num(r, 'grossCents'), net: num(r, 'netCents'), billed: num(r, 'billedCents'), paid: num(r, 'paidCents'), credited: num(r, 'creditedCents'), balance: num(r, 'balanceCents'), fee: num(r, 'quickPayFeeCents') },
      })
    }
    return out
  },
}

const VENDOR_BILLS: Dataset = {
  id: 'vendor_bills',
  label: 'Vendor bills (repairs, services, other payables)',
  description: 'One row per vendor payable that came in by e-mail or maintenance. Amount is empty until an e-mailed invoice is reviewed.',
  level: 'FINANCE',
  dateFields: { default: 'invoiceDate', options: { invoiceDate: 'invoice date (received date when none)', dueDate: 'due date', paidDate: 'the day it was paid' } },
  dims: { status: 'NEED_TO_PAY or DONE', vendor: 'vendor name', source: 'MAINTENANCE or EMAIL', payAsap: 'quickpay mail: yes or no', paymentMethod: 'how it was paid' },
  metrics: {
    bills: { label: 'Bills', unit: 'count', calc: sum('n') },
    amount: { label: 'Amount', unit: 'cents', calc: sum('amount') },
    unpriced: { label: 'Bills with no amount yet', unit: 'count', calc: sum('unpriced') },
  },
  defaultMetrics: ['bills', 'amount'],
  notes: [],
  async load(env, win) {
    const rows = await env.ask.vendorPayables()
    const out: Rec[] = []
    for (const r of rows) {
      const invoiceDate = dayPart(str(r, 'invoiceDate')) || chicagoDay(str(r, 'receivedAt'))
      const dueDate = dayPart(str(r, 'dueDate'))
      const paidDate = dayPart(str(r, 'paymentDate')) || chicagoDay(str(r, 'paidAt'))
      if (![invoiceDate, dueDate, paidDate].some((d) => d && d >= win.from && d <= win.to)) continue
      const amount = typeof r.amount === 'number' ? (r.amount as number) : null
      out.push({
        dates: { invoiceDate, dueDate, paidDate },
        dim: { status: str(r, 'status'), vendor: str(r, 'vendor'), source: str(r, 'source'), payAsap: r.payAsap === true ? 'yes' : 'no', paymentMethod: str(r, 'paymentMethod') },
        v: { n: 1, amount: amount ?? 0, unpriced: amount == null ? 1 : 0 },
      })
    }
    return out
  },
}

const MAINTENANCE: Dataset = {
  id: 'maintenance_invoices',
  label: 'Truck maintenance invoices',
  description: 'One row per repair / maintenance invoice logged against a truck or trailer.',
  level: 'OWNER',
  dateFields: { default: 'invoiceDate', options: { invoiceDate: 'the invoice date' } },
  dims: { vendor: 'shop / vendor', unit: 'truck or trailer unit number', fleet: 'LOCAL, AMAZON or BOX_TRUCK', status: 'POSTED (counts in the P&L), PENDING (awaiting review) or ARCHIVED' },
  metrics: { invoices: { label: 'Invoices', unit: 'count', calc: sum('n') }, amount: { label: 'Amount', unit: 'cents', calc: sum('amount') } },
  defaultMetrics: ['invoices', 'amount'],
  notes: ['Only POSTED invoices count in the fleet P&L; pending ones are not yet reviewed.'],
  async load(env, win) {
    const [rows, equipment] = await Promise.all([env.ask.maintenanceInvoices(), env.ask.equipment()])
    const eq = new Map(equipment.map((e) => [str(e, 'id'), e]))
    const out: Rec[] = []
    for (const r of rows) {
      const day = dayPart(str(r, 'date'))
      if (!day || day < win.from || day > win.to) continue
      const e = eq.get(str(r, 'equipmentId'))
      out.push({
        dates: { invoiceDate: day },
        dim: {
          vendor: str(r, 'vendor'), unit: e ? str(e, 'unitNumber') : '', fleet: e ? str(e, 'fleetGroup') : '',
          status: invoiceState({ status: str(r, 'status') as never, source: str(r, 'source'), createdAt: str(r, 'createdAt') } as never),
        },
        v: { n: 1, amount: num(r, 'amount') },
      })
    }
    return out
  },
}

const FUEL: Dataset = {
  id: 'fuel',
  label: 'Fuel card transactions (EFS)',
  description: 'One row per fuel-card transaction (diesel, DEF, scale, cash advance).',
  level: 'OWNER',
  dateFields: { default: 'transactionDate', options: { transactionDate: 'the day of the purchase' } },
  dims: { unit: 'truck unit number', driver: 'driver name on the card', category: 'FUEL, SCALE, CASH_ADVANCE, OTHER', fuelType: 'ULSD, DEFD...', fleet: 'LOCAL, AMAZON or BOX_TRUCK' },
  metrics: {
    transactions: { label: 'Transactions', unit: 'count', calc: sum('n') },
    amount: { label: 'Amount', unit: 'cents', calc: sum('amount') },
    gallons: { label: 'Fuel gallons (category FUEL)', unit: 'gallons', calc: sum('gallons') },
    pricePerGallon: { label: 'Average price per gallon', unit: 'cents', calc: ratio('fuelAmount', 'gallons') },
  },
  defaultMetrics: ['transactions', 'amount', 'gallons'],
  notes: ['A transaction with no truck on file is resolved through the fuel card number, like the P&L does.'],
  async load(env, win) {
    const [rows, equipment] = await Promise.all([env.ask.fuelTransactions(), env.ask.equipment()])
    const cardToTruck = new Map<string, Row>()
    for (const e of equipment) for (const card of (Array.isArray(e.fuelCardNumbers) ? e.fuelCardNumbers : e.fuelCardNumbers instanceof Set ? [...e.fuelCardNumbers] : []) as string[]) if (card) cardToTruck.set(String(card), e)
    const eqById = new Map(equipment.map((e) => [str(e, 'id'), e]))
    const out: Rec[] = []
    for (const r of rows) {
      const day = dayPart(str(r, 'transactionDate'))
      if (!day || day < win.from || day > win.to) continue
      const truck = eqById.get(str(r, 'truckId')) ?? cardToTruck.get(str(r, 'cardNumber'))
      const cents = Math.round(num(r, 'amount') * 100)
      const isFuel = str(r, 'itemCategory') === 'FUEL'
      out.push({
        dates: { transactionDate: day },
        dim: { unit: truck ? str(truck, 'unitNumber') : str(r, 'unitNumber'), driver: str(r, 'driverName'), category: str(r, 'itemCategory'), fuelType: str(r, 'fuelType'), fleet: truck ? str(truck, 'fleetGroup') : '' },
        v: { n: 1, amount: cents, gallons: isFuel ? num(r, 'quantity') : 0, fuelAmount: isFuel ? cents : 0 },
      })
    }
    return out
  },
}

const COMBINED_PREFIX = 'fleet-combined:'

const DRIVER_PAY: Dataset = {
  id: 'driver_pay',
  label: 'Driver pay (pay periods, credits, debits, deductions)',
  description:
    'One row per recorded pay period, pay credit (detention, bonus...), debit or fixed deduction. A pay period is dated by its first day and covers 7-14 days, so use fleet_pnl for a cost prorated to a window.',
  level: 'OWNER',
  dateFields: { default: 'periodStart', options: { periodStart: 'the first day of the pay period / the day the entry was earned' } },
  dims: { driver: 'driver (the Ivan local drivers are one combined row)', fleet: 'LOCAL, BOX_TRUCK, OWNER_OPERATOR...', kind: 'PAY_PERIOD, CREDIT, DEBIT or DEDUCTION', reason: 'credit reason or deduction label' },
  metrics: { entries: { label: 'Entries', unit: 'count', calc: sum('n') }, amount: { label: 'Amount', unit: 'cents', calc: sum('amount') } },
  defaultMetrics: ['entries', 'amount'],
  notes: ['Pending or rejected pay credits are left out (they are not on any check).', 'Pay entered is the only pay the system knows: a period with no row has no driver cost recorded.'],
  async load(env, win) {
    const [periods, credits, deductions, drivers] = await Promise.all([
      env.ask.payPeriods(), env.ask.payCredits(), env.ask.payDeductions(), env.ask.drivers(),
    ])
    const byId = new Map(drivers.map((d) => [str(d, 'id'), d]))
    const who = (id: string): { driver: string; fleet: string } => {
      if (id.startsWith(COMBINED_PREFIX)) return { driver: `All drivers (combined ${id.slice(COMBINED_PREFIX.length)})`, fleet: id.slice(COMBINED_PREFIX.length) }
      const d = byId.get(id)
      return { driver: d ? str(d, 'name') : id, fleet: d ? str(d, 'fleetGroup') : '' }
    }
    const out: Rec[] = []
    const push = (day: string, driverId: string, kind: string, reason: string, cents: number): void => {
      if (!day || day < win.from || day > win.to) return
      out.push({ dates: { periodStart: day }, dim: { ...who(driverId), kind, reason }, v: { n: 1, amount: cents } })
    }
    for (const r of periods) push(dayPart(str(r, 'periodStart')), str(r, 'driverId'), 'PAY_PERIOD', str(r, 'source'), Math.round(num(r, 'grossPay') * 100))
    for (const r of credits) {
      const status = str(r, 'approvalStatus')
      if (status === 'PENDING' || status === 'REJECTED') continue
      push(dayPart(str(r, 'date')) || dayPart(str(r, 'periodStart')), str(r, 'driverId'), str(r, 'kind') === 'DEBIT' ? 'DEBIT' : 'CREDIT', str(r, 'label') || str(r, 'reasonCode'), Math.round(num(r, 'amount') * 100))
    }
    for (const r of deductions) push(dayPart(str(r, 'date')) || dayPart(str(r, 'periodStart')), str(r, 'driverId'), 'DEDUCTION', str(r, 'label'), Math.round(num(r, 'amount') * 100))
    return out
  },
}

export const DATASETS: Record<string, Dataset> = Object.fromEntries(
  [DELIVERED, CARRIER_BILLS, VENDOR_BILLS, MAINTENANCE, FUEL, DRIVER_PAY].map((d) => [d.id, d]),
)
export const DATASET_IDS = Object.keys(DATASETS)

/** The derived time dimensions every dataset has, from the chosen date field. */
const TIME_DIMS: Record<string, string> = { day: 'YYYY-MM-DD', week: 'the Monday of the week', month: 'YYYY-MM' }

// ── Window ──────────────────────────────────────────────────────────────────

const PRESETS: readonly WindowPreset[] = ['THIS_MONTH', 'LAST_MONTH', 'THIS_QUARTER', 'LAST_QUARTER', 'LAST_30_DAYS', 'LAST_90_DAYS', 'YEAR_TO_DATE']

export function windowFromInput(input: Record<string, unknown>, today: string): ResolvedWindow {
  const text = (k: string): string => (typeof input[k] === 'string' ? (input[k] as string).trim() : '')
  const preset = text('window').toUpperCase()
  const spec: DashboardWindow = (PRESETS as readonly string[]).includes(preset)
    ? { preset: preset as WindowPreset }
    : text('from') && text('to')
      ? { preset: 'CUSTOM', from: text('from'), to: text('to') }
      : { preset: 'THIS_MONTH' }
  const win = resolveWindow(spec, `${today}T12:00:00Z`)
  const span = (Date.parse(`${win.to}T00:00:00Z`) - Date.parse(`${win.from}T00:00:00Z`)) / 86_400_000 + 1
  if (span > MAX_CUSTOM_DAYS) throw new Error(`The window is longer than ${MAX_CUSTOM_DAYS} days. Ask for a shorter window.`)
  return win
}

// ── The engine ──────────────────────────────────────────────────────────────

export const QUERY_LIMITS = { maxGroupBy: 2, maxFilters: 6, maxRows: 50, defaultRows: 25, maxFilterValues: 8 } as const

export interface DataQuery {
  metrics: string[]
  groupBy: string[]
  filters: { dim: string; values: string[] }[]
  dateField: string
  sort: string
  order: 'asc' | 'desc'
  limit: number
}

export interface QueryOut {
  groups: Record<string, string | number | null>[]
  totals: Record<string, number | null>
  groupCount: number
  truncated: boolean
  rowsUsed: number
  notes: string[]
}

const dimValue = (rec: Rec, dim: string, dateField: string): string => {
  if (dim === 'day') return rec.dates[dateField] ?? ''
  if (dim === 'week') return rec.dates[dateField] ? weekStart(rec.dates[dateField]) : ''
  if (dim === 'month') return (rec.dates[dateField] ?? '').slice(0, 7)
  return rec.dim[dim] ?? ''
}

/** A filter value matches a dimension value on equal normalized text, or contained text of 3+ characters. */
function matches(value: string, wanted: string): boolean {
  const v = norm(value)
  const w = norm(wanted)
  if (!w) return false
  return v === w || (w.length >= 3 && v.includes(w))
}

export function runDataQuery(ds: Dataset, rows: readonly Rec[], q: DataQuery, win: ResolvedWindow): QueryOut {
  const notes: string[] = []
  let use = rows.filter((r) => {
    const d = r.dates[q.dateField]
    return !!d && d >= win.from && d <= win.to
  })
  for (const f of q.filters) {
    const before = use
    use = before.filter((r) => f.values.some((w) => matches(dimValue(r, f.dim, q.dateField), w)))
    if (use.length === 0 && before.length > 0) {
      const counts = new Map<string, number>()
      for (const r of before) counts.set(dimValue(r, f.dim, q.dateField), (counts.get(dimValue(r, f.dim, q.dateField)) ?? 0) + 1)
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k]) => k).filter(Boolean)
      notes.push(`No ${f.dim} matched "${f.values.join('" or "')}". Values present in this window include: ${top.join(' | ') || '(none)'}. Ask the user which they mean.`)
    }
  }
  const add = (acc: Totals, r: Rec): void => {
    for (const [k, x] of Object.entries(r.v)) acc[k] = (acc[k] ?? 0) + x
  }
  const calc = (t: Totals): Record<string, number | null> => {
    const out: Record<string, number | null> = {}
    for (const m of q.metrics) {
      const x = ds.metrics[m]!.calc(t)
      out[m] = x == null ? null : Math.round(x * 100) / 100
    }
    return out
  }
  const all: Totals = {}
  for (const r of use) add(all, r)
  const totals = calc(all)

  const groups = new Map<string, { key: Record<string, string>; t: Totals }>()
  if (q.groupBy.length > 0) {
    for (const r of use) {
      const key: Record<string, string> = {}
      for (const g of q.groupBy) key[g] = dimValue(r, g, q.dateField) || '(none)'
      const id = q.groupBy.map((g) => key[g]).join('\u0001')
      let g = groups.get(id)
      if (!g) groups.set(id, (g = { key, t: {} }))
      add(g.t, r)
    }
  }
  const timeSorted = q.groupBy.length === 1 && q.groupBy[0] && TIME_DIMS[q.groupBy[0]] !== undefined && q.sort === ''
  let list = [...groups.values()].map((g) => ({ ...g.key, ...calc(g.t) }) as Record<string, string | number | null>)
  if (timeSorted) list.sort((a, b) => String(a[q.groupBy[0]!]).localeCompare(String(b[q.groupBy[0]!])))
  else {
    const by = q.sort && ds.metrics[q.sort] ? q.sort : q.metrics[0]!
    const dir = q.order === 'asc' ? 1 : -1
    list.sort((a, b) => dir * (((a[by] as number | null) ?? -Infinity) - ((b[by] as number | null) ?? -Infinity)))
  }
  const groupCount = list.length
  const truncated = groupCount > q.limit
  list = list.slice(0, q.limit)
  if (truncated) notes.push(`Showing the top ${q.limit} of ${groupCount} groups; ask for a smaller window or a filter to see others.`)
  return { groups: list, totals, groupCount, truncated, rowsUsed: use.length, notes }
}

// ── Tools ───────────────────────────────────────────────────────────────────

const strList = (v: unknown, max: number): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim().slice(0, 80)).slice(0, max) : []

const UNITS: Record<Unit, string> = {
  cents: 'US cents', count: 'count', miles: 'miles', percent: 'percent (0-100)', centsPerMile: 'US cents per mile', gallons: 'US gallons',
}

export function describeData(env: AskEnv, input: Record<string, unknown>): string {
  const only = typeof input.dataset === 'string' ? input.dataset.trim() : ''
  const usable = Object.values(DATASETS).filter((d) => mayUse(d.level, env.viewer) && (!only || d.id === only))
  if (only && usable.length === 0) return `No dataset "${only}" that you can use. Use describe_data with no dataset to list them.`
  const body = usable.map((d) => ({
    dataset: d.id, label: d.label, description: d.description,
    dateFields: d.dateFields, dimensions: { ...d.dims, ...TIME_DIMS },
    metrics: Object.fromEntries(Object.entries(d.metrics).map(([k, m]) => [k, `${m.label} (${UNITS[m.unit]})`])),
    defaultMetrics: d.defaultMetrics, notes: d.notes,
  }))
  const fleet = mayUse('OWNER', env.viewer)
  return JSON.stringify({
    datasets: body,
    windows: [...PRESETS, 'or from/to as YYYY-MM-DD (at most 400 days)'],
    otherTools: fleet
      ? ['fleet_pnl: the fleet profit and loss (revenue, driver pay, fuel, insurance, loans, maintenance, other) for LOCAL (Ivan local drivers), BOX_TRUCK or AMAZON, with a margin. Use it for "expenses vs revenue / margin for local drivers".']
      : [],
    howTo: 'Call query_data with dataset, metrics, groupBy (up to 2 dimensions, incl. day/week/month), filters [{dim, values}], optional window, dateField, sort, order, limit.',
  })
}

export async function queryData(env: AskEnv, input: Record<string, unknown>): Promise<string> {
  const id = typeof input.dataset === 'string' ? input.dataset.trim() : ''
  const ds = DATASETS[id]
  if (!ds) return `Unknown dataset ${id || '(none)'}. Use describe_data. Datasets: ${DATASET_IDS.join(', ')}`
  // Same words for "no such data" and "not yours": a viewer below the level learns nothing about it.
  if (!mayUse(ds.level, env.viewer)) return denied(ds.label)

  const bad: string[] = []
  const metrics = strList(input.metrics, 8).filter((m) => (ds.metrics[m] ? true : (bad.push(`metric ${m}`), false)))
  const groupBy = strList(input.groupBy, QUERY_LIMITS.maxGroupBy).filter((g) => (ds.dims[g] !== undefined || TIME_DIMS[g] !== undefined ? true : (bad.push(`dimension ${g}`), false)))
  const filters: DataQuery['filters'] = []
  if (Array.isArray(input.filters)) {
    for (const f of input.filters.slice(0, QUERY_LIMITS.maxFilters)) {
      const dim = typeof (f as { dim?: unknown })?.dim === 'string' ? ((f as { dim: string }).dim) : ''
      const values = strList((f as { values?: unknown })?.values, QUERY_LIMITS.maxFilterValues)
      if (!(ds.dims[dim] !== undefined || TIME_DIMS[dim] !== undefined)) bad.push(`filter dimension ${dim || '(none)'}`)
      else if (values.length) filters.push({ dim, values })
    }
  }
  const dateField = typeof input.dateField === 'string' && ds.dateFields.options[input.dateField] ? input.dateField : ds.dateFields.default
  if (typeof input.dateField === 'string' && input.dateField && !ds.dateFields.options[input.dateField]) bad.push(`dateField ${input.dateField}`)
  if (bad.length) return `Not valid for ${ds.id}: ${bad.join(', ')}. Use describe_data with dataset "${ds.id}" to see what exists.`

  let win: ResolvedWindow
  try {
    win = windowFromInput(input, env.today)
  } catch (err) {
    return err instanceof Error ? err.message : 'Invalid window'
  }
  const sort = typeof input.sort === 'string' && ds.metrics[input.sort] ? input.sort : ''
  const limit = Math.min(QUERY_LIMITS.maxRows, Math.max(1, typeof input.limit === 'number' ? Math.floor(input.limit) : QUERY_LIMITS.defaultRows))
  const q: DataQuery = {
    metrics: metrics.length ? metrics : ds.defaultMetrics, groupBy, filters, dateField, sort,
    order: input.order === 'asc' ? 'asc' : 'desc', limit,
  }
  const rows = await ds.load(env, win)
  const out = runDataQuery(ds, rows, q, win)
  return JSON.stringify({
    dataset: ds.id, window: { from: win.from, to: win.to }, dateField, groupBy, filters,
    units: Object.fromEntries(q.metrics.map((m) => [m, UNITS[ds.metrics[m]!.unit]])),
    totals: out.totals, groups: out.groups, groupCount: out.groupCount, rowsUsed: out.rowsUsed,
    notes: [...out.notes, ...(out.rowsUsed === 0 ? ['No rows matched. Do not claim there are none in the business; say none were visible for this window and filters.'] : [])],
  })
}
