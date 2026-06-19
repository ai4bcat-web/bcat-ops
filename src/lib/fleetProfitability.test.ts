import { describe, it, expect } from 'vitest'
import { calcFleetProfitability } from './fleetProfitability'
import type {
  MemberTruck, LoadInput, DriverPayInput, DriverAssignmentInput, TruckMileageDayInput,
} from './fleetProfitability'
import type { FuelTxInput, ExpenseRecordInput, RecurringInput, AllocationRecord, ExpenseTypeRecord } from './expenseAllocation'

const TRUCK_530 = 'eq-530'
const TRUCK_685 = 'eq-685'
const ORPHAN_890 = 'motive:890'   // Motive-only, no Equipment / no fuel card

const RANGE = { start: '2026-06-01', end: '2026-06-07' }  // a 7-day week; June has 30 days
const WEEK_FACTOR = 7 / 30                                  // proration of a monthly cost to this week

const members: MemberTruck[] = [
  { truckId: TRUCK_530, unitNumber: '530', driverName: 'Ivan',  hasEquipment: true,  hasFuelCard: true },
  { truckId: TRUCK_685, unitNumber: '685', driverName: 'Pavel', hasEquipment: true,  hasFuelCard: true },
  { truckId: ORPHAN_890, unitNumber: '890', driverName: null,   hasEquipment: false, hasFuelCard: false },
]

const expenseTypes: ExpenseTypeRecord[] = [
  { id: 'type-ins',  category: 'INSURANCE' },
  { id: 'type-loan', category: 'FINANCING' },
]
const allocations: AllocationRecord[] = [
  { id: 'alloc-loan', expenseTypeId: 'type-loan', allocationMethod: 'DIRECT', truckIds: [] },
]
const noRecurring: RecurringInput[] = []

describe('calcFleetProfitability', () => {
  it('attributes revenue to delivery day, breaks out insurance, prorates monthly cost', () => {
    const loads: LoadInput[] = [
      // Delivered in-range, attributed to 530. rate 250000 cents = $2,500
      { truckId: TRUCK_530, rate: 250_000, deliveryAppt: '2026-06-03T15:00:00Z' },
      // Picked up in-range but delivered AFTER the window → excluded
      { truckId: TRUCK_530, rate: 999_999, deliveryAppt: '2026-06-10' },
      { truckId: TRUCK_685, rate: 100_000, deliveryAppt: '2026-06-05' },
    ]
    const fuelTxs: FuelTxInput[] = [
      { truckId: TRUCK_530, transactionDate: '2026-06-02', amount: 400, itemCategory: 'FUEL' },
      { truckId: TRUCK_530, transactionDate: '2026-06-04', amount: 100, itemCategory: 'FUEL' },
      { truckId: TRUCK_530, transactionDate: '2026-05-30', amount: 999, itemCategory: 'FUEL' }, // out of range
    ]
    // $300/mo insurance (DIRECT to 530) → prorated to the 7-day week.
    const expenses: ExpenseRecordInput[] = [
      { expenseTypeId: 'type-ins', allocationId: null, amount: 300, periodMonth: '2026-06', transactionDate: null, directTruckId: TRUCK_530 },
    ]
    const mileage: TruckMileageDayInput[] = [
      { truckId: TRUCK_530, periodStart: '2026-06-02', periodType: 'DAY', miles: 300 },
      { truckId: TRUCK_530, periodStart: '2026-06-03', periodType: 'DAY', miles: 200 },
      { truckId: TRUCK_530, periodStart: '2026-05-31', periodType: 'DAY', miles: 999 },  // out of range
    ]
    const pay: DriverPayInput[] = [
      { driverId: 'drv-ivan', periodStart: '2026-06-01', periodEnd: '2026-06-14', grossPay: 1400 }, // → $700 in week
    ]
    const assignments: DriverAssignmentInput[] = [{ driverId: 'drv-ivan', assignedTruckId: TRUCK_530 }]

    const r = calcFleetProfitability(RANGE, members, loads, fuelTxs, expenses, noRecurring, allocations, expenseTypes, mileage, pay, assignments)

    const t530 = r.trucks.find((t) => t.truckId === TRUCK_530)!
    expect(t530.revenue).toBe(2500)
    expect(t530.fuel).toBe(500)
    expect(t530.insurance).toBeCloseTo(300 * WEEK_FACTOR)   // prorated, not the full $300
    expect(t530.loan).toBe(0)
    expect(t530.otherExpenses).toBe(0)
    expect(t530.driverCost).toBe(700)
    expect(t530.miles).toBe(500)
    expect(t530.net).toBeCloseTo(2500 - 500 - 300 * WEEK_FACTOR - 700)
    expect(t530.revenuePerMile).toBeCloseTo(5)
    expect(t530.fuelPerMile).toBeCloseTo(1)
  })

  it('includes a truck loan (FINANCING) from a recurring expense, prorated', () => {
    // $2,000/mo loan on truck 530, entered as a RecurringExpense (never stored as an
    // ExpenseRecord) → must be projected + prorated. Allocation targets only 530.
    const recurring: RecurringInput[] = [
      { expenseTypeId: 'type-loan', allocationId: 'alloc-loan', monthlyAmount: 2000, startMonth: '2026-01', endMonth: null, active: true },
    ]
    const loanAlloc: AllocationRecord[] = [
      { id: 'alloc-loan', expenseTypeId: 'type-loan', allocationMethod: 'SPLIT_EVEN', truckIds: [TRUCK_530] },
    ]
    const r = calcFleetProfitability(RANGE, members, [], [], [], recurring, loanAlloc, expenseTypes, [], [], [])
    const t530 = r.trucks.find((t) => t.truckId === TRUCK_530)!
    expect(t530.loan).toBeCloseTo(2000 * WEEK_FACTOR)
    expect(t530.net).toBeCloseTo(-2000 * WEEK_FACTOR)   // pure cost, no revenue
    expect(r.rollup.loan).toBeCloseTo(2000 * WEEK_FACTOR)
  })

  it('still shows Motive-only trucks with no Equipment / fuel card (blank fuel)', () => {
    const mileage: TruckMileageDayInput[] = [
      { truckId: ORPHAN_890, periodStart: '2026-06-04', periodType: 'DAY', miles: 150 },
    ]
    const r = calcFleetProfitability(RANGE, members, [], [], [], noRecurring, allocations, expenseTypes, mileage, [], [])
    const t890 = r.trucks.find((t) => t.truckId === ORPHAN_890)!
    expect(t890.hasEquipment).toBe(false)
    expect(t890.hasFuelCard).toBe(false)
    expect(t890.miles).toBe(150)
    expect(t890.fuel).toBe(0)
    expect(t890.revenue).toBe(0)
    expect(t890.revenuePerMile).toBe(0)
  })

  it('rolls up across all member trucks', () => {
    const loads: LoadInput[] = [
      { truckId: TRUCK_530, rate: 200_000, deliveryAppt: '2026-06-03' },
      { truckId: TRUCK_685, rate: 100_000, deliveryAppt: '2026-06-05' },
    ]
    const mileage: TruckMileageDayInput[] = [
      { truckId: TRUCK_530, periodStart: '2026-06-03', periodType: 'DAY', miles: 100 },
      { truckId: TRUCK_685, periodStart: '2026-06-05', periodType: 'DAY', miles: 300 },
    ]
    const r = calcFleetProfitability(RANGE, members, loads, [], [], noRecurring, allocations, expenseTypes, mileage, [], [])
    expect(r.rollup.revenue).toBe(3000)
    expect(r.rollup.miles).toBe(400)
    expect(r.rollup.net).toBe(3000)
    expect(r.rollup.revenuePerMile).toBeCloseTo(7.5)
  })

  it('breaks non-fuel expenses into categories consistent with the rollup', () => {
    const types: ExpenseTypeRecord[] = [
      { id: 'type-ins', category: 'INSURANCE' },
      { id: 'type-fin', category: 'FINANCING' },
    ]
    // One-time (transactionDate) records in range — counted as-is, not prorated.
    const expenses: ExpenseRecordInput[] = [
      { expenseTypeId: 'type-ins', allocationId: null, amount: 300, periodMonth: null, transactionDate: '2026-06-03', directTruckId: TRUCK_530 },
      { expenseTypeId: 'type-fin', allocationId: null, amount: 900, periodMonth: null, transactionDate: '2026-06-04', directTruckId: TRUCK_685 },
    ]
    const r = calcFleetProfitability(RANGE, members, [], [], expenses, noRecurring, allocations, types, [], [], [])
    // Category breakdown lines up with the dedicated insurance/loan rollup fields…
    expect(r.rollup.categories.insurance).toBeCloseTo(r.rollup.insurance)
    expect(r.rollup.categories.financing).toBeCloseTo(r.rollup.loan)
    expect(r.rollup.categories.maintenance).toBe(0)
    // …and every category together equals all non-fuel cost (insurance + loan + other).
    const catSum = Object.values(r.rollup.categories).reduce((a, b) => a + b, 0)
    expect(catSum).toBeCloseTo(r.rollup.insurance + r.rollup.loan + r.rollup.otherExpenses)
  })

  it('attributes revenue via the delivery driver’s assigned truck when load.truckId is absent', () => {
    // Loads carry deliveryDriverId, not truckId — revenue must still land on the truck.
    const loads: LoadInput[] = [
      { truckId: null, deliveryDriverId: 'drv-ivan', rate: 250_000, deliveryAppt: '2026-06-03' },
      { truckId: null, deliveryDriverId: 'drv-none', rate: 999_999, deliveryAppt: '2026-06-03' }, // unassigned driver → dropped
    ]
    const assignments: DriverAssignmentInput[] = [{ driverId: 'drv-ivan', assignedTruckId: TRUCK_530 }]
    const r = calcFleetProfitability(RANGE, members, loads, [], [], noRecurring, allocations, expenseTypes, [], [], assignments)
    expect(r.trucks.find((t) => t.truckId === TRUCK_530)!.revenue).toBe(2500)
    expect(r.rollup.revenue).toBe(2500)
  })

  it('excludes broker-covered revenue from trucks and surfaces leakage buckets', () => {
    const loads: LoadInput[] = [
      { truckId: null, deliveryDriverId: 'drv-ivan',   rate: 200_000, deliveryAppt: '2026-06-03' }, // → 530
      { truckId: null, deliveryDriverId: 'drv-broker', rate: 500_000, deliveryAppt: '2026-06-03' }, // broker → excluded
      { truckId: null, deliveryDriverId: 'drv-orphan', rate: 100_000, deliveryAppt: '2026-06-03' }, // company, no truck → unattributed
    ]
    const assignments: DriverAssignmentInput[] = [
      { driverId: 'drv-ivan',   assignedTruckId: TRUCK_530 },
      { driverId: 'drv-broker', assignedTruckId: null, isBroker: true },
      { driverId: 'drv-orphan', assignedTruckId: null },
    ]
    const r = calcFleetProfitability(RANGE, members, loads, [], [], noRecurring, allocations, expenseTypes, [], [], assignments)
    expect(r.rollup.revenue).toBe(2000)            // only the 530 load
    expect(r.revenueLeakage.broker).toBe(5000)     // broker excluded from trucks
    expect(r.revenueLeakage.unattributed).toBe(1000)
  })

  it('returns null per-mile metrics when there are zero miles', () => {
    const loads: LoadInput[] = [{ truckId: TRUCK_530, rate: 100_000, deliveryAppt: '2026-06-03' }]
    const r = calcFleetProfitability(RANGE, members, loads, [], [], noRecurring, allocations, expenseTypes, [], [], [])
    const t530 = r.trucks.find((t) => t.truckId === TRUCK_530)!
    expect(t530.miles).toBe(0)
    expect(t530.revenuePerMile).toBeNull()
    expect(t530.fuelPerMile).toBeNull()
  })
})
