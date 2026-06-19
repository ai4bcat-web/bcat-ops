/**
 * Fleet profitability engine.
 *
 * Pure function — takes pre-fetched data arrays + a date range and a fleet group,
 * and computes per-truck profitability (revenue, miles, fuel, other expenses,
 * driver cost, net, revenue/mile, fuel/mile) plus a fleet-wide roll-up.
 *
 * Unit normalization (everything in DOLLARS on the way out):
 *  • Load.rate is stored in CENTS  → divided by 100 here.
 *  • Fuel/expense amounts are already in DOLLARS (FuelTransaction.amount,
 *    ExpenseRecord.amount) → reused via getExpensesByTruck unchanged.
 *  • DriverPayPeriod.grossPay is in DOLLARS.
 *
 * Attribution decisions (see build spec):
 *  • Revenue: a load's FULL rate is attributed to its DELIVERY day (deliveryAppt).
 *  • Miles: summed from per-day TruckMileage DAY rows in range.
 *  • Driver cost: a driver's biweekly gross pay is mapped to their truck via
 *    assignedTruckId and PRORATED BY DAY across the requested range — i.e. the
 *    portion of each pay period that overlaps [start, end] is counted.
 *
 * Membership is driven by `members` (built from Equipment.fleetGroup — the source
 * of truth). Trucks that lack an Equipment record or a fuel-card mapping are still
 * included by the caller (e.g. Motive-only units 890 / 89510); this layer surfaces
 * that via the `hasEquipment` / `hasFuelCard` flags so the UI can flag them.
 */

import { getFleetExpenses } from './expenseAllocation'
import type {
  FuelTxInput,
  ExpenseRecordInput,
  RecurringInput,
  AllocationRecord,
  ExpenseTypeRecord,
} from './expenseAllocation'

export interface DateRange {
  start: string // YYYY-MM-DD inclusive
  end:   string // YYYY-MM-DD inclusive
}

/** A truck that belongs to the fleet group being reported on. */
export interface MemberTruck {
  /** Equipment.id when an Equipment record exists; otherwise a synthetic key (e.g. `motive:890`). */
  truckId:     string
  unitNumber:  string
  /** Driver display name resolved from assignedTruckId, if any. */
  driverName?: string | null
  /** False for Motive-only trucks with no Equipment record (e.g. 890, 89510). */
  hasEquipment: boolean
  /** False when no EFS fuel card is mapped (no Equipment.fuelCardNumbers). */
  hasFuelCard:  boolean
}

export interface LoadInput {
  truckId?:          string | null
  /** Delivery-leg driver — revenue maps to this driver's assigned truck (loads delivered by each driver). */
  deliveryDriverId?: string | null
  rate?:             number | null   // CENTS
  deliveryAppt:      string          // ISO datetime or YYYY-MM-DD
}

export interface DriverPayInput {
  driverId:    string
  periodStart: string  // YYYY-MM-DD inclusive
  periodEnd:   string  // YYYY-MM-DD inclusive
  grossPay:    number  // dollars
}

/** Maps a driver to the truck they were assigned to (Driver.assignedTruckId). */
export interface DriverAssignmentInput {
  driverId:        string
  assignedTruckId?: string | null
  /** Broker / 3PL driver — their covered loads are excluded from truck revenue. */
  isBroker?:       boolean
}

export interface TruckMileageDayInput {
  truckId:     string
  periodStart: string  // YYYY-MM-DD — DAY rows only
  periodType:  string  // expects 'DAY'
  miles:       number
}

export interface TruckProfitability {
  truckId:        string
  unitNumber:     string
  driverName?:    string | null
  revenue:        number          // dollars
  miles:          number
  fuel:           number          // dollars
  insurance:      number          // dollars (prorated to range)
  loan:           number          // dollars — FINANCING category (truck loans), prorated
  otherExpenses:  number          // dollars (lease + maintenance + permits + tolls + other)
  driverCost:     number          // dollars (prorated)
  net:            number          // revenue - fuel - insurance - loan - otherExpenses - driverCost
  revenuePerMile: number | null   // null when miles === 0
  fuelPerMile:    number | null   // null when miles === 0
  hasEquipment:   boolean
  hasFuelCard:    boolean
}

/**
 * Non-fuel expense totals split by category (dollars). The sum of these equals
 * `rollup.otherExpenses`. Used by the monthly P&L view to break the costs out.
 */
export interface ExpenseCategoryBreakdown {
  insurance:   number
  financing:   number  // truck / trailer loans
  lease:       number  // yard / trailer rent & leases
  maintenance: number
  permits:     number
  tolls:       number
  other:       number
}

export interface FleetProfitabilityResult {
  range:   DateRange
  trucks:  TruckProfitability[]
  rollup: {
    revenue:        number
    miles:          number
    fuel:           number
    insurance:      number
    loan:           number
    otherExpenses:  number
    driverCost:     number
    net:            number
    revenuePerMile: number | null
    fuelPerMile:    number | null
    /** Non-fuel expenses split by category; sums to `otherExpenses`. */
    categories:     ExpenseCategoryBreakdown
  }
  /**
   * Delivered-load revenue (in range) that did NOT land on a member truck:
   *  • broker — covered by a broker/3PL driver (intentionally excluded from trucks)
   *  • unattributed — a company driver delivered it but has no assigned truck
   */
  revenueLeakage: { broker: number; unattributed: number }
}

/** A load's delivery DATE (YYYY-MM-DD), tolerant of full ISO datetimes. */
function deliveryDate(load: LoadInput): string {
  return load.deliveryAppt.slice(0, 10)
}

/** Inclusive day count between two YYYY-MM-DD dates (UTC, calendar days). */
function inclusiveDays(start: string, end: string): number {
  const s = Date.UTC(+start.slice(0, 4), +start.slice(5, 7) - 1, +start.slice(8, 10))
  const e = Date.UTC(+end.slice(0, 4), +end.slice(5, 7) - 1, +end.slice(8, 10))
  return Math.floor((e - s) / 86_400_000) + 1
}

/**
 * Dollars of a single pay period that fall within [rangeStart, rangeEnd], prorated
 * evenly per calendar day across the pay period. A biweekly (14-day) period that
 * fully overlaps a 1-week range contributes 7/14 of its gross pay.
 */
function proratedPayInRange(pay: DriverPayInput, range: DateRange): number {
  const totalDays = inclusiveDays(pay.periodStart, pay.periodEnd)
  if (totalDays <= 0) return 0
  // Overlap window
  const oStart = pay.periodStart > range.start ? pay.periodStart : range.start
  const oEnd   = pay.periodEnd   < range.end   ? pay.periodEnd   : range.end
  if (oStart > oEnd) return 0
  const overlapDays = inclusiveDays(oStart, oEnd)
  return (pay.grossPay * overlapDays) / totalDays
}

export function calcFleetProfitability(
  range: DateRange,
  members: MemberTruck[],
  loads: LoadInput[],
  fuelTxs: FuelTxInput[],
  expenseRecords: ExpenseRecordInput[],
  recurringExpenses: RecurringInput[],
  allocations: AllocationRecord[],
  expenseTypes: ExpenseTypeRecord[],
  mileageDayRows: TruckMileageDayInput[],
  driverPay: DriverPayInput[],
  driverAssignments: DriverAssignmentInput[],
): FleetProfitabilityResult {
  const memberIds = new Set(members.map((m) => m.truckId))

  // ── Expenses per truck — SAME shared aggregation the Expenses tab uses: fuel +
  // manual/auto records + projected recurring (insurance, loans…), monthly costs
  // prorated to the range so a weekly view shows a week's slice. ────────────────
  const expensesByTruck = getFleetExpenses(
    range.start, range.end,
    { fuelTxs, records: expenseRecords, recurring: recurringExpenses, allocations, expenseTypes },
    { prorateMonthly: true },
  )

  // ── Driver → assigned truck map (used for BOTH revenue attribution and pay) ───
  const truckForDriver = new Map<string, string>()
  const brokerDrivers = new Set<string>()
  for (const a of driverAssignments) {
    if (a.assignedTruckId) truckForDriver.set(a.driverId, a.assignedTruckId)
    if (a.isBroker) brokerDrivers.add(a.driverId)
  }

  // ── Revenue per truck: full rate → delivery day (dollars), attributed to the
  //    truck of the load's DELIVERY driver (Driver.assignedTruckId), falling back to
  //    an explicit load.truckId. Loads covered by a BROKER are excluded from trucks
  //    (tracked as broker leakage); company-driver loads with no assigned truck are
  //    tracked as unattributed leakage so dispatch gaps are visible. ────────────────
  const revenueByTruck: Record<string, number> = {}
  let brokerRevenue = 0
  let unattributedRevenue = 0
  for (const load of loads) {
    const d = deliveryDate(load)
    if (d < range.start || d > range.end) continue
    const rev = (load.rate ?? 0) / 100
    const driverId = load.deliveryDriverId ?? undefined

    // Broker-covered loads never count toward a truck's revenue.
    if (driverId && brokerDrivers.has(driverId)) { brokerRevenue += rev; continue }

    const truckId = load.truckId ?? (driverId ? truckForDriver.get(driverId) : undefined)
    if (truckId && memberIds.has(truckId)) {
      revenueByTruck[truckId] = (revenueByTruck[truckId] ?? 0) + rev
    } else if (driverId && !truckForDriver.has(driverId)) {
      // A company driver delivered it but has no assigned truck at all → unattributed.
      // (Loads on trucks in OTHER fleet groups are left to that group, not counted here.)
      unattributedRevenue += rev
    }
  }

  // ── Miles per truck: sum DAY rows in range ───────────────────────────────────
  const milesByTruck: Record<string, number> = {}
  for (const row of mileageDayRows) {
    if (row.periodType !== 'DAY') continue
    if (!memberIds.has(row.truckId)) continue
    if (row.periodStart < range.start || row.periodStart > range.end) continue
    milesByTruck[row.truckId] = (milesByTruck[row.truckId] ?? 0) + row.miles
  }

  // ── Driver cost per truck: prorate biweekly pay, map via assignedTruckId ──────
  const driverCostByTruck: Record<string, number> = {}
  for (const pay of driverPay) {
    const truckId = truckForDriver.get(pay.driverId)
    if (!truckId || !memberIds.has(truckId)) continue
    const amount = proratedPayInRange(pay, range)
    if (amount > 0) driverCostByTruck[truckId] = (driverCostByTruck[truckId] ?? 0) + amount
  }

  // ── Assemble per-truck rows ──────────────────────────────────────────────────
  const trucks: TruckProfitability[] = members.map((m) => {
    const exp = expensesByTruck[m.truckId]
    const fuel = exp?.fuel ?? 0
    const insurance = exp?.insurance ?? 0
    const loan = exp?.financing ?? 0
    // Everything else non-fuel/insurance/loan (lease + maintenance + permits + tolls + other).
    const otherExpenses = exp ? exp.total - exp.fuel - exp.insurance - exp.financing : 0
    const revenue = revenueByTruck[m.truckId] ?? 0
    const miles = milesByTruck[m.truckId] ?? 0
    const driverCost = driverCostByTruck[m.truckId] ?? 0
    const net = revenue - fuel - insurance - loan - otherExpenses - driverCost
    return {
      truckId:        m.truckId,
      unitNumber:     m.unitNumber,
      driverName:     m.driverName ?? null,
      revenue,
      miles,
      fuel,
      insurance,
      loan,
      otherExpenses,
      driverCost,
      net,
      revenuePerMile: miles > 0 ? revenue / miles : null,
      fuelPerMile:    miles > 0 ? fuel / miles : null,
      hasEquipment:   m.hasEquipment,
      hasFuelCard:    m.hasFuelCard,
    }
  })

  // ── Roll-up ──────────────────────────────────────────────────────────────────
  const sum = (f: (t: TruckProfitability) => number) => trucks.reduce((acc, t) => acc + f(t), 0)
  const revenue = sum((t) => t.revenue)
  const miles = sum((t) => t.miles)
  const fuel = sum((t) => t.fuel)
  const insurance = sum((t) => t.insurance)
  const loan = sum((t) => t.loan)
  const otherExpenses = sum((t) => t.otherExpenses)
  const driverCost = sum((t) => t.driverCost)

  // Non-fuel expenses split by category across member trucks (sums to otherExpenses).
  const categories: ExpenseCategoryBreakdown = { insurance: 0, financing: 0, lease: 0, maintenance: 0, permits: 0, tolls: 0, other: 0 }
  for (const m of members) {
    const e = expensesByTruck[m.truckId]
    if (!e) continue
    categories.insurance   += e.insurance
    categories.financing   += e.financing
    categories.lease       += e.lease
    categories.maintenance += e.maintenance
    categories.permits     += e.permits
    categories.tolls       += e.tolls
    categories.other       += e.other
  }

  return {
    range,
    trucks,
    rollup: {
      revenue,
      miles,
      fuel,
      insurance,
      loan,
      otherExpenses,
      driverCost,
      net: revenue - fuel - insurance - loan - otherExpenses - driverCost,
      revenuePerMile: miles > 0 ? revenue / miles : null,
      fuelPerMile:    miles > 0 ? fuel / miles : null,
      categories,
    },
    revenueLeakage: { broker: brokerRevenue, unattributed: unattributedRevenue },
  }
}
