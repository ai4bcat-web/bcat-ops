/**
 * Ask BCAT — `fleet_pnl`: the fleet profit and loss, computed by the SAME pure engine the
 * Fleet profitability page and the Expenses page use (`calcFleetProfitability`), fed from
 * the same tables, so the answer matches those pages. Read-only; owner / ADMIN only (driver
 * pay, fuel and insurance are not for anyone below that).
 *
 * "Local drivers" is the LOCAL fleet (Ivan Cartage local drivers; the box truck rides inside
 * it, exactly as the page treats it). Revenue is the full rate of every load a fleet driver
 * delivered, on its delivery day. Driver cost is the pay entered for pay periods, prorated by
 * day; days with no pay entered yet are reported as a coverage gap, and an estimate for them is
 * given SEPARATELY, never mixed into the engine's figures.
 */
import { calcFleetProfitability, type DriverPayInput } from '../../../src/lib/fleetProfitability'
import type { ExpenseRecordInput, ExpenseTypeRecord, RecurringInput, AllocationRecord, FuelTxInput } from '../../../src/lib/expenseAllocation'
import { ORPHAN_UNITS_BY_GROUP, combinedPayDriverId, isCombinedPayDriverId, orphanTruckId, truckInFleet } from '../../../src/lib/fleetGroups'
import { withResolvedTruckIds } from '../../../src/lib/fuelTruckResolve'
import { insuranceRangeByTruckDated, type DriverLite, type InsItem, type TruckLite } from '../../../src/lib/insuranceAllocation'
import { isPosted } from '../../../src/lib/invoiceStatus'
import type { FleetGroup } from '../../../src/types/equipment'
import type { Row } from '../_shared/crmStore'
import { denied, mayUse, windowFromInput, type AskEnv } from './askData'

const GROUPS: readonly FleetGroup[] = ['LOCAL', 'BOX_TRUCK', 'AMAZON']
const MAINT_INVOICE_TYPE_ID = '__maintenance_invoice__'
const LABEL: Record<FleetGroup, string> = { LOCAL: 'Ivan local drivers (the box truck is included)', BOX_TRUCK: 'Box truck', AMAZON: 'Owner-operator / Amazon trucks' }

const str = (r: Row, k: string): string => (typeof r[k] === 'string' ? (r[k] as string).trim() : '')
const num = (r: Row, k: string): number => (typeof r[k] === 'number' && Number.isFinite(r[k]) ? (r[k] as number) : 0)
const cents = (x: number | null): number | null => (x == null ? null : Math.round(x * 100))

function days(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000) + 1
}

const shift = (iso: string, n: number): string => {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export async function fleetPnl(env: AskEnv, input: Record<string, unknown>): Promise<string> {
  if (!mayUse('OWNER', env.viewer)) return denied('the fleet profit and loss')

  const fleetArg = typeof input.fleet === 'string' ? input.fleet.trim().toUpperCase() : 'LOCAL'
  const group = (GROUPS as readonly string[]).includes(fleetArg) ? (fleetArg as FleetGroup) : null
  if (!group) return `Unknown fleet ${fleetArg}. Use one of: ${GROUPS.join(', ')}.`

  let win
  try {
    win = windowFromInput(input, env.today)
  } catch (err) {
    return err instanceof Error ? err.message : 'Invalid window'
  }
  // Revenue lands on delivery days, so the future has none; fixed monthly costs are prorated to the
  // same days. A window running past today is cut at today so the two sides cover the same days.
  const range = { start: win.from, end: win.to > env.today ? env.today : win.to }
  if (range.start > range.end) return `That window starts after today (${env.today}); there is nothing to report yet.`

  const a = env.ask
  const [equipment, drivers, loads, fuel, records, recurring, types, allocs, mileage, periods, maint, insPeriods, insItems, paySettings] = await Promise.all([
    a.equipment(), a.drivers(), a.loadsDeliveredBetween(range.start, range.end), a.fuelTransactions(), a.expenseRecords(), a.recurringExpenses(),
    a.expenseTypes(), a.expenseAllocations(), a.truckMileageDays(), a.payPeriods(), a.maintenanceInvoices(), a.insurancePeriods(), a.insuranceItems(), a.paySettings(),
  ])

  const eq = equipment.map((e) => ({
    id: str(e, 'id'), type: str(e, 'type'), unitNumber: str(e, 'unitNumber'), fleetGroup: str(e, 'fleetGroup') || null,
    active: e.active !== false, inactiveSince: str(e, 'inactiveSince') || null,
    fuelCardNumbers: (Array.isArray(e.fuelCardNumbers) ? e.fuelCardNumbers : e.fuelCardNumbers instanceof Set ? [...(e.fuelCardNumbers as Set<string>)] : []) as string[],
  }))
  const drv = drivers.map((d) => ({
    id: str(d, 'id'), name: str(d, 'name'), active: d.active !== false, type: str(d, 'type'), fleetGroup: str(d, 'fleetGroup'), assignedTruckId: str(d, 'assignedTruckId') || null,
  }))

  const equipTruckUnits = new Set(eq.filter((e) => e.type === 'truck').map((e) => e.unitNumber))
  const members = [
    ...eq.filter((e) => e.type === 'truck' && truckInFleet(e.fleetGroup, group)).map((e) => ({
      truckId: e.id, unitNumber: e.unitNumber, driverName: drv.find((d) => d.assignedTruckId === e.id)?.name ?? null, hasEquipment: true, hasFuelCard: e.fuelCardNumbers.length > 0,
    })),
    ...(ORPHAN_UNITS_BY_GROUP[group] ?? []).filter((u) => !equipTruckUnits.has(u)).map((u) => ({
      truckId: orphanTruckId(u), unitNumber: u, driverName: drv.find((d) => d.assignedTruckId === orphanTruckId(u))?.name ?? null, hasEquipment: false, hasFuelCard: false,
    })),
  ].sort((x, y) => x.unitNumber.localeCompare(y.unitNumber))

  const fuelTxs: FuelTxInput[] = withResolvedTruckIds(
    fuel.map((f) => ({ truckId: str(f, 'truckId') || null, cardNumber: str(f, 'cardNumber') || null, transactionDate: str(f, 'transactionDate'), amount: num(f, 'amount'), itemCategory: str(f, 'itemCategory') })),
    eq,
  )
  const expenseRecords: ExpenseRecordInput[] = [
    ...records.map((r) => ({ expenseTypeId: str(r, 'expenseTypeId'), allocationId: str(r, 'allocationId') || null, amount: num(r, 'amount'), periodMonth: str(r, 'periodMonth') || null, transactionDate: str(r, 'transactionDate') || null, directTruckId: str(r, 'directTruckId') || null })),
    ...maint
      .filter((m) => str(m, 'date') && isPosted({ status: str(m, 'status') as never, source: str(m, 'source') as never, createdAt: str(m, 'createdAt') } as never))
      .map((m) => ({ expenseTypeId: MAINT_INVOICE_TYPE_ID, allocationId: null, amount: num(m, 'amount') / 100, periodMonth: null, transactionDate: str(m, 'date'), directTruckId: str(m, 'equipmentId') || null })),
  ]
  const expenseTypes: ExpenseTypeRecord[] = [
    ...types.map((t) => ({ id: str(t, 'id'), category: str(t, 'category') as ExpenseTypeRecord['category'] })),
    { id: MAINT_INVOICE_TYPE_ID, category: 'MAINTENANCE' },
  ]
  const recurringIn: RecurringInput[] = recurring.map((r) => ({
    expenseTypeId: str(r, 'expenseTypeId'), allocationId: str(r, 'allocationId') || null, monthlyAmount: num(r, 'monthlyAmount'), startMonth: str(r, 'startMonth'), endMonth: str(r, 'endMonth') || null, active: r.active !== false,
  }))
  const allocations: AllocationRecord[] = allocs.map((x) => ({
    id: str(x, 'id'), expenseTypeId: str(x, 'expenseTypeId'), allocationMethod: str(x, 'allocationMethod') === 'DIRECT' ? 'DIRECT' : 'SPLIT_EVEN',
    truckIds: (Array.isArray(x.truckIds) ? x.truckIds : x.truckIds instanceof Set ? [...(x.truckIds as Set<string>)] : []) as string[],
  }))

  const combinedId = combinedPayDriverId(group)
  const payIn: DriverPayInput[] = periods
    .filter((p) => !isCombinedPayDriverId(str(p, 'driverId')) || str(p, 'driverId') === combinedId)
    .map((p) => ({ driverId: str(p, 'driverId'), periodStart: str(p, 'periodStart'), periodEnd: str(p, 'periodEnd'), grossPay: num(p, 'grossPay'), combined: str(p, 'driverId') === combinedId }))

  // Insurance: the current period's premiums prorated to the range, exactly as the P&L page does.
  const current = insPeriods.find((p) => p.isCurrent === true) ?? insPeriods[0] ?? null
  const items: InsItem[] = current
    ? insItems.filter((i) => str(i, 'periodId') === str(current, 'id')).map((i) => ({ kind: str(i, 'kind') as InsItem['kind'], equipmentId: str(i, 'equipmentId') || null, annualCents: num(i, 'annualCents') }))
    : []
  const boxIds = new Set(paySettings.filter((s) => str(s, 'payGroup') === 'BOX_TRUCK' && s.active !== false).map((s) => str(s, 'driverId')))
  const lite = (type: string): TruckLite[] => eq.filter((e) => e.type === type).map((e) => ({ id: e.id, active: e.active, inactiveSince: e.inactiveSince }))
  const driverLite: DriverLite[] = drv.map((d) => ({ id: d.id, assignedTruckId: d.assignedTruckId, active: d.active && d.type !== 'broker', boxTruck: boxIds.has(d.id) }))
  const insurance = insuranceRangeByTruckDated(items, lite('truck'), driverLite, range, lite('trailer'))

  const result = calcFleetProfitability(
    range, members,
    loads.map((l) => ({ truckId: str(l, 'truckId') || null, deliveryDriverId: str(l, 'deliveryDriverId') || null, rate: typeof l.rate === 'number' ? (l.rate as number) : null, deliveryAppt: str(l, 'deliveryAppt') })),
    fuelTxs, expenseRecords, recurringIn, allocations, expenseTypes,
    mileage.map((m) => ({ truckId: str(m, 'truckId'), periodStart: str(m, 'periodStart'), periodType: str(m, 'periodType'), miles: num(m, 'miles') })),
    payIn,
    drv.map((d) => ({ driverId: d.id, assignedTruckId: d.assignedTruckId, isBroker: d.type === 'broker', inFleet: d.fleetGroup === group || (group === 'LOCAL' && d.fleetGroup === 'BOX_TRUCK') })),
    insurance,
  )

  const r = result.rollup
  const expensesTotal = r.fuel + r.insurance + r.loan + r.otherExpenses + r.driverCost
  const margin = (net: number, rev: number): number | null => (rev > 0 ? Math.round((net / rev) * 1000) / 10 : null)

  // Driver-pay coverage: which days of the range sit inside a recorded pay period.
  const span = days(range.start, range.end)
  const covered = new Set<string>()
  for (const p of payIn) {
    if (!p.periodStart || !p.periodEnd) continue
    const from = p.periodStart > range.start ? p.periodStart : range.start
    const to = p.periodEnd < range.end ? p.periodEnd : range.end
    for (let d = from; d <= to; d = shift(d, 1)) covered.add(d)
  }
  const uncovered = span - covered.size
  const lastPeriodEnd = payIn.map((p) => p.periodEnd).filter(Boolean).sort().pop() ?? null
  const recent = [...payIn].filter((p) => p.periodStart && p.periodEnd).sort((x, y) => y.periodStart.localeCompare(x.periodStart)).slice(0, 2)
  const recentDays = recent.reduce((s, p) => s + days(p.periodStart, p.periodEnd), 0)
  const dailyDriverCost = recentDays > 0 ? recent.reduce((s, p) => s + p.grossPay, 0) / recentDays : null
  const estimate = uncovered > 0 && dailyDriverCost != null ? dailyDriverCost * uncovered : null
  const missing: string[] = []
  if (uncovered > 0) missing.push(`Driver pay is entered only through ${lastPeriodEnd ?? 'never'}; ${uncovered} of ${span} days in this window have no driver pay recorded, so driverCost is understated.`)
  if (members.some((m) => !m.hasFuelCard)) missing.push(`Trucks with no fuel card on file (their fuel is not counted): ${members.filter((m) => !m.hasFuelCard).map((m) => m.unitNumber).join(', ')}.`)
  if (r.revenue === 0) missing.push('No delivered revenue was found for this fleet in the window.')

  const trucks = input.byTruck === false ? undefined : result.trucks.slice(0, 15).map((t) => ({
    unit: t.unitNumber, driver: t.driverName, revenue: cents(t.revenue), driverCost: cents(t.driverCost), fuel: cents(t.fuel), insurance: cents(t.insurance),
    loans: cents(t.loan), other: cents(t.otherExpenses), net: cents(t.net), miles: Math.round(t.miles),
  }))

  return JSON.stringify({
    fleet: group, fleetLabel: LABEL[group], window: { from: range.start, to: range.end, requestedTo: win.to }, units: 'US cents unless a field says otherwise',
    revenue: cents(r.revenue),
    expenses: {
      total: cents(expensesTotal), driverPay: cents(r.driverCost), fuel: cents(r.fuel), insurance: cents(r.insurance), truckLoans: cents(r.loan),
      maintenance: cents(r.categories.maintenance), permits: cents(r.categories.permits), tolls: cents(r.categories.tolls), leases: cents(r.categories.lease), other: cents(r.categories.other),
    },
    net: cents(r.net), marginPercent: margin(r.net, r.revenue), expensesPercentOfRevenue: margin(expensesTotal, r.revenue),
    miles: Math.round(r.miles), revenuePerMile: cents(r.revenuePerMile), trucks,
    driverPayCoverage: {
      days: span, daysWithPayRecorded: covered.size, lastPayPeriodEnd: lastPeriodEnd,
      estimateForMissingDays: estimate == null ? null : {
        driverPay: cents(estimate), basis: `average daily pay of the last ${recent.length} recorded pay period(s), ${cents(dailyDriverCost)} cents a day, for ${uncovered} day(s)`,
        expensesTotalWithEstimate: cents(expensesTotal + estimate), netWithEstimate: cents(r.net - estimate), marginPercentWithEstimate: margin(r.net - estimate, r.revenue),
      },
    },
    revenueNotOnATruck: { brokerCovered: cents(result.revenueLeakage.broker), noTruckOnFile: cents(result.revenueLeakage.noTruck), unattributed: cents(result.revenueLeakage.unattributed) },
    gaps: missing,
    method: 'Same engine as the Fleet profitability page. Revenue = rate of loads delivered by this fleet\'s drivers on their delivery day. Fixed monthly costs (insurance, loans, leases) are prorated by day to the window; fuel and maintenance are the actual transactions. Margin = net / revenue.',
  })
}
