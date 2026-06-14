import { describe, it, expect } from 'vitest'
import { calcFleetProfitability } from './fleetProfitability'
import type {
  MemberTruck, LoadInput, DriverPayInput, DriverAssignmentInput, TruckMileageDayInput,
} from './fleetProfitability'
import type { FuelTxInput, ExpenseRecordInput, AllocationRecord, ExpenseTypeRecord } from './expenseAllocation'

const TRUCK_530 = 'eq-530'
const TRUCK_685 = 'eq-685'
const ORPHAN_890 = 'motive:890'   // Motive-only, no Equipment / no fuel card

const RANGE = { start: '2026-06-01', end: '2026-06-07' }  // a 7-day week

const members: MemberTruck[] = [
  { truckId: TRUCK_530, unitNumber: '530', driverName: 'Ivan',  hasEquipment: true,  hasFuelCard: true },
  { truckId: TRUCK_685, unitNumber: '685', driverName: 'Pavel', hasEquipment: true,  hasFuelCard: true },
  { truckId: ORPHAN_890, unitNumber: '890', driverName: null,   hasEquipment: false, hasFuelCard: false },
]

const expenseTypes: ExpenseTypeRecord[] = [
  { id: 'type-ins', category: 'INSURANCE' },
]
const allocations: AllocationRecord[] = [
  { id: 'alloc-ins', expenseTypeId: 'type-ins', allocationMethod: 'DIRECT', truckIds: [] },
]

describe('calcFleetProfitability', () => {
  it('attributes load rate (cents→dollars) to the delivery day and computes net', () => {
    const loads: LoadInput[] = [
      // Delivered in-range, attributed to 530. rate 250000 cents = $2,500
      { truckId: TRUCK_530, rate: 250_000, deliveryAppt: '2026-06-03T15:00:00Z' },
      // Picked up in-range but delivered AFTER the window → excluded
      { truckId: TRUCK_530, rate: 999_999, deliveryAppt: '2026-06-10' },
      // Other member
      { truckId: TRUCK_685, rate: 100_000, deliveryAppt: '2026-06-05' },
    ]
    const fuelTxs: FuelTxInput[] = [
      { truckId: TRUCK_530, transactionDate: '2026-06-02', amount: 400, itemCategory: 'FUEL' },
      { truckId: TRUCK_530, transactionDate: '2026-06-04', amount: 100, itemCategory: 'FUEL' },
      // out of range
      { truckId: TRUCK_530, transactionDate: '2026-05-30', amount: 999, itemCategory: 'FUEL' },
    ]
    const expenses: ExpenseRecordInput[] = [
      { expenseTypeId: 'type-ins', allocationId: null, amount: 200, periodMonth: '2026-06', transactionDate: null, directTruckId: TRUCK_530 },
    ]
    const mileage: TruckMileageDayInput[] = [
      { truckId: TRUCK_530, periodStart: '2026-06-02', periodType: 'DAY', miles: 300 },
      { truckId: TRUCK_530, periodStart: '2026-06-03', periodType: 'DAY', miles: 200 },
      { truckId: TRUCK_530, periodStart: '2026-05-31', periodType: 'DAY', miles: 999 },  // out of range
      { truckId: ORPHAN_890, periodStart: '2026-06-04', periodType: 'DAY', miles: 150 },
    ]
    // Biweekly pay $1,400 over 14 days → 7 in-range days → $700 to Ivan→530
    const pay: DriverPayInput[] = [
      { driverId: 'drv-ivan', periodStart: '2026-06-01', periodEnd: '2026-06-14', grossPay: 1400 },
    ]
    const assignments: DriverAssignmentInput[] = [
      { driverId: 'drv-ivan', assignedTruckId: TRUCK_530 },
    ]

    const r = calcFleetProfitability(RANGE, members, loads, fuelTxs, expenses, allocations, expenseTypes, mileage, pay, assignments)

    const t530 = r.trucks.find((t) => t.truckId === TRUCK_530)!
    expect(t530.revenue).toBe(2500)        // only the in-range delivery
    expect(t530.fuel).toBe(500)            // 400 + 100
    expect(t530.otherExpenses).toBe(200)   // insurance
    expect(t530.driverCost).toBe(700)      // half of biweekly
    expect(t530.miles).toBe(500)
    expect(t530.net).toBe(2500 - 500 - 200 - 700)  // 1100
    expect(t530.revenuePerMile).toBeCloseTo(5)     // 2500 / 500
    expect(t530.fuelPerMile).toBeCloseTo(1)        // 500 / 500
  })

  it('still shows Motive-only trucks with no Equipment / fuel card (blank fuel)', () => {
    const mileage: TruckMileageDayInput[] = [
      { truckId: ORPHAN_890, periodStart: '2026-06-04', periodType: 'DAY', miles: 150 },
    ]
    const r = calcFleetProfitability(RANGE, members, [], [], [], allocations, expenseTypes, mileage, [], [])
    const t890 = r.trucks.find((t) => t.truckId === ORPHAN_890)!
    expect(t890.hasEquipment).toBe(false)
    expect(t890.hasFuelCard).toBe(false)
    expect(t890.miles).toBe(150)
    expect(t890.fuel).toBe(0)
    expect(t890.revenue).toBe(0)
    expect(t890.revenuePerMile).toBe(0)   // 0 revenue / 150 miles
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
    const r = calcFleetProfitability(RANGE, members, loads, [], [], allocations, expenseTypes, mileage, [], [])
    expect(r.rollup.revenue).toBe(3000)
    expect(r.rollup.miles).toBe(400)
    expect(r.rollup.net).toBe(3000)
    expect(r.rollup.revenuePerMile).toBeCloseTo(7.5)
  })

  it('returns null per-mile metrics when there are zero miles', () => {
    const loads: LoadInput[] = [{ truckId: TRUCK_530, rate: 100_000, deliveryAppt: '2026-06-03' }]
    const r = calcFleetProfitability(RANGE, members, loads, [], [], allocations, expenseTypes, [], [], [])
    const t530 = r.trucks.find((t) => t.truckId === TRUCK_530)!
    expect(t530.miles).toBe(0)
    expect(t530.revenuePerMile).toBeNull()
    expect(t530.fuelPerMile).toBeNull()
  })
})
