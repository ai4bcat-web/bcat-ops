/**
 * Pure maths behind the Expenses overview (`/expenses`): the D / W / M period, the three
 * cost cards, hours worked per time-clock driver, and the receipts union.
 *
 * Nothing here reads a clock or fetches: "today" is a parameter and every figure comes from
 * data the caller already holds, so the page does no arithmetic of its own.
 */
import type { DriverPayCredit, DriverPayDeduction, FuelTransaction } from '@/lib/apiClient'
import type { DateRange, FleetProfitabilityResult } from '@/lib/fleetProfitability'
import { timeClockFor } from '@/lib/driverProgram'
import { payPeriodDays, rowMinutes } from '@/lib/timeClock'
import type { TimeClockRow } from '@/lib/timeClock'
import type { Driver, TimeClockEntry } from '@/types'
import type { FleetGroup, MaintenanceInvoice } from '@/types/equipment'
import type { VendorPayable } from '@/types/vendorAp'

/* ── Period ────────────────────────────────────────────────────────────────── */

export type ExpensePeriod = 'D' | 'W' | 'M'

/** Noon UTC, so adding days never slips under any timezone arithmetic. */
function shiftDay(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function dayCount(range: DateRange): number {
  return Math.round((Date.parse(`${range.end}T12:00:00Z`) - Date.parse(`${range.start}T12:00:00Z`)) / 86_400_000) + 1
}

/** D = today, W = the last 7 days, M = month to date — each ending today (inclusive). */
export function periodRange(period: ExpensePeriod, todayIso: string): DateRange {
  if (period === 'D') return { start: todayIso, end: todayIso }
  if (period === 'W') return { start: shiftDay(todayIso, -6), end: todayIso }
  return { start: `${todayIso.slice(0, 8)}01`, end: todayIso }
}

/** The equal-length range that ends the day before `range` starts. */
export function previousRange(range: DateRange): DateRange {
  const days = dayCount(range)
  const end = shiftDay(range.start, -1)
  return { start: shiftDay(end, -(days - 1)), end }
}

/* ── Cards ─────────────────────────────────────────────────────────────────── */

export interface ExpenseCard {
  key: 'total' | 'fuel' | 'salary'
  label: string
  cents: number
  /** Percentage points vs the previous equal range; null when that range spent nothing. */
  deltaPct: number | null
}

const toCents = (dollars: number) => Math.round(dollars * 100)

function rollupTotals(result: FleetProfitabilityResult) {
  const r = result.rollup
  return {
    total: toCents(r.fuel + r.insurance + r.loan + r.otherExpenses + r.driverCost),
    fuel: toCents(r.fuel),
    salary: toCents(r.driverCost),
  }
}

function pctChange(current: number, previous: number): number | null {
  if (previous === 0) return null
  return ((current - previous) / Math.abs(previous)) * 100
}

export function expenseCards(result: FleetProfitabilityResult, prev: FleetProfitabilityResult): ExpenseCard[] {
  const cur = rollupTotals(result)
  const old = rollupTotals(prev)
  return [
    { key: 'total', label: 'Total expenses', cents: cur.total, deltaPct: pctChange(cur.total, old.total) },
    { key: 'fuel', label: 'Fuel', cents: cur.fuel, deltaPct: pctChange(cur.fuel, old.fuel) },
    { key: 'salary', label: 'Salary (driver pay)', cents: cur.salary, deltaPct: pctChange(cur.salary, old.salary) },
  ]
}

/* ── Hours ─────────────────────────────────────────────────────────────────── */

export interface DriverHours {
  driverId: string
  name: string
  minutes: number
  hours: number
}

/**
 * Hours worked in the 14-day pay period starting `periodStart`, for every active driver on the
 * time clock. Several rows in a day are summed (never one span), an open shift is worth nothing
 * (`rowMinutes`), and a driver with no punches is present at zero — a zero is a fact, not a gap.
 */
export function hoursPerDriver(entries: TimeClockEntry[], drivers: Driver[], periodStart: string): DriverHours[] {
  const days = new Set(payPeriodDays(periodStart))
  const minutesBy = new Map<string, number>()
  for (const entry of entries) {
    if (!days.has(entry.workDate)) continue
    minutesBy.set(entry.driverId, (minutesBy.get(entry.driverId) ?? 0) + rowMinutes(entry as TimeClockRow))
  }
  return drivers
    .filter((d) => d.active && timeClockFor({ timeClock: d.timeClock, fleetGroup: d.fleetGroup }))
    .map((d) => {
      const minutes = minutesBy.get(d.id) ?? 0
      return { driverId: d.id, name: d.name, minutes, hours: Math.round((minutes / 60) * 10) / 10 }
    })
    .sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name))
}

/* ── Receipts ──────────────────────────────────────────────────────────────── */

export type ReceiptKind = 'MAINTENANCE' | 'FUEL' | 'DRIVER_PAY'
export type ReceiptStatus = 'PAID' | 'PENDING'

export interface Receipt {
  id: string
  kind: ReceiptKind
  /** YYYY-MM-DD */
  date: string
  /** Vendor / merchant / charge label. */
  merchant: string
  amountCents: number
  truckUnit: string | null
  driverName: string | null
  category: string
  location: string | null
  /** Only maintenance carries a paid state; fuel and driver-pay rows are null. */
  status: ReceiptStatus | null
  invoiceId?: string
  payableId?: string
}

export interface ReceiptStatusView {
  label: string
  tone: 'green' | 'orange' | 'gray'
}

/** The pill for a receipt: PAID / PENDING only where the data carries it, else a neutral chip. */
export function receiptStatus(receipt: Receipt): ReceiptStatusView {
  if (receipt.status === 'PAID') return { label: 'Paid', tone: 'green' }
  if (receipt.status === 'PENDING') return { label: 'Pending', tone: 'orange' }
  return { label: receipt.kind === 'FUEL' ? 'Card charge' : 'Settlement', tone: 'gray' }
}

/** Does this driver belong to the fleet the page is showing (mirrors `useFleetProfitability`)? */
export function driverInGroup(driver: Pick<Driver, 'fleetGroup'>, group: FleetGroup): boolean {
  return driver.fleetGroup === group || (group === 'LOCAL' && driver.fleetGroup === 'BOX_TRUCK')
}

export interface ReceiptTruck {
  id: string
  unitNumber: string
  driverName?: string | null
}

export interface BuildReceiptsInput {
  invoices: MaintenanceInvoice[]
  fuel: FuelTransaction[]
  deductions: DriverPayDeduction[]
  credits: DriverPayCredit[]
  payables: VendorPayable[]
  /** The selected group's trucks; maintenance and fuel on any other truck are dropped. */
  trucks: ReceiptTruck[]
  drivers: Driver[]
  group: FleetGroup
  range: DateRange
}

const inRange = (date: string, range: DateRange) => date >= range.start && date <= range.end

/** Newest first. */
export function buildReceipts(input: BuildReceiptsInput): Receipt[] {
  const { invoices, fuel, deductions, credits, payables, trucks, drivers, group, range } = input
  const truckById = new Map(trucks.map((t) => [t.id, t]))
  const payableByInvoice = new Map<string, VendorPayable>()
  for (const p of payables) if (p.sourceInvoiceId) payableByInvoice.set(p.sourceInvoiceId, p)
  const out: Receipt[] = []

  for (const inv of invoices) {
    const truck = truckById.get(inv.equipmentId)
    const date = inv.date ?? inv.createdAt.slice(0, 10)
    if (!truck || inv.status === 'ARCHIVED' || !inRange(date, range)) continue
    const payable = payableByInvoice.get(inv.id)
    const status: ReceiptStatus = payable
      ? (payable.status === 'DONE' ? 'PAID' : 'PENDING')
      : (inv.paymentDate ? 'PAID' : 'PENDING')
    out.push({
      id: `inv:${inv.id}`,
      kind: 'MAINTENANCE',
      date,
      merchant: inv.vendor || inv.description || 'Maintenance invoice',
      amountCents: inv.amount,
      truckUnit: truck.unitNumber,
      driverName: truck.driverName ?? null,
      category: 'Maintenance',
      location: inv.vendor || null,
      status,
      invoiceId: inv.id,
      payableId: payable?.id,
    })
  }

  for (const tx of fuel) {
    const truck = tx.truckId ? truckById.get(tx.truckId) : undefined
    if (!truck || !inRange(tx.transactionDate, range)) continue
    const place = [tx.city, tx.state].filter(Boolean).join(', ')
    out.push({
      id: `fuel:${tx.id}`,
      kind: 'FUEL',
      date: tx.transactionDate,
      merchant: tx.locationName || 'Fuel purchase',
      amountCents: toCents(tx.amount),
      truckUnit: truck.unitNumber,
      driverName: tx.driverName || truck.driverName || null,
      category: 'Fuel',
      location: place || tx.locationName || null,
      status: null,
    })
  }

  const driverById = new Map(drivers.filter((d) => driverInGroup(d, group)).map((d) => [d.id, d]))
  for (const d of deductions) {
    const driver = driverById.get(d.driverId)
    const date = (d.date ?? d.periodStart).slice(0, 10)
    if (!driver || !inRange(date, range)) continue
    out.push({
      id: `ded:${d.id}`, kind: 'DRIVER_PAY', date, merchant: d.label || 'Pay deduction',
      amountCents: toCents(d.amount), truckUnit: null, driverName: driver.name,
      category: 'Driver-pay charge', location: null, status: null,
    })
  }
  for (const c of credits) {
    const driver = driverById.get(c.driverId)
    const date = (c.date ?? c.periodStart).slice(0, 10)
    if (c.kind !== 'DEBIT' || !driver || !inRange(date, range)) continue
    out.push({
      id: `cr:${c.id}`, kind: 'DRIVER_PAY', date, merchant: c.label || c.reasonCode,
      amountCents: toCents(c.amount), truckUnit: null, driverName: driver.name,
      category: 'Driver-pay charge', location: null, status: null,
    })
  }

  return out.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id))
}
