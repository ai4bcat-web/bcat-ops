import { describe, expect, it } from 'vitest'
import type { FleetProfitabilityResult } from '@/lib/fleetProfitability'
import type { Driver, TimeClockEntry } from '@/types'
import type { MaintenanceInvoice } from '@/types/equipment'
import type { VendorPayable } from '@/types/vendorAp'
import {
  buildReceipts, expenseCards, hoursPerDriver, periodRange, previousRange, receiptStatus,
  type BuildReceiptsInput,
} from './expenseOverview'

const result = (o: Partial<FleetProfitabilityResult['rollup']>): FleetProfitabilityResult => ({
  range: { start: '2026-11-01', end: '2026-11-03' },
  trucks: [],
  rollup: {
    revenue: 0, miles: 0, fuel: 0, insurance: 0, loan: 0, otherExpenses: 0, driverCost: 0, net: 0,
    revenuePerMile: null, fuelPerMile: null,
    categories: { insurance: 0, financing: 0, lease: 0, maintenance: 0, permits: 0, tolls: 0, other: 0 },
    ...o,
  },
  revenueLeakage: { broker: 0, unattributed: 0, noTruck: 0 },
})

describe('periodRange / previousRange', () => {
  it('D, W and M all end today', () => {
    expect(periodRange('D', '2026-11-03')).toEqual({ start: '2026-11-03', end: '2026-11-03' })
    expect(periodRange('W', '2026-11-03')).toEqual({ start: '2026-10-28', end: '2026-11-03' })
    expect(periodRange('M', '2026-11-03')).toEqual({ start: '2026-11-01', end: '2026-11-03' })
  })
  it('previous range is the equal-length range just before', () => {
    expect(previousRange({ start: '2026-10-28', end: '2026-11-03' })).toEqual({ start: '2026-10-21', end: '2026-10-27' })
    expect(previousRange({ start: '2026-11-03', end: '2026-11-03' })).toEqual({ start: '2026-11-02', end: '2026-11-02' })
    expect(previousRange({ start: '2026-11-01', end: '2026-11-03' })).toEqual({ start: '2026-10-29', end: '2026-10-31' })
  })
})

describe('expenseCards', () => {
  it('totals every cost line in cents and omits the delta when the prior range was zero', () => {
    const cur = result({ fuel: 100.5, insurance: 10, loan: 20, otherExpenses: 30, driverCost: 200 })
    const prev = result({ fuel: 50.25, driverCost: 0 })
    const [total, fuel, salary] = expenseCards(cur, prev)
    expect(total.cents).toBe(36050)
    expect(fuel.cents).toBe(10050)
    expect(fuel.deltaPct).toBeCloseTo(100, 5)
    expect(salary.cents).toBe(20000)
    expect(salary.deltaPct).toBeNull()
  })
})

const driver = (o: Partial<Driver>): Driver => ({ id: 'd', name: 'D', active: true, ...o } as Driver)
const entry = (o: Partial<TimeClockEntry>): TimeClockEntry =>
  ({ id: Math.random().toString(), driverId: 'a', workDate: '2026-11-02', kind: 'WORK', ...o }) as TimeClockEntry

describe('hoursPerDriver', () => {
  const drivers = [
    driver({ id: 'a', name: 'Ann', fleetGroup: 'LOCAL' }),
    driver({ id: 'b', name: 'Bob', fleetGroup: 'LOCAL' }),
    driver({ id: 'c', name: 'Cy', fleetGroup: 'AMAZON' }),
    driver({ id: 'e', name: 'Eve', fleetGroup: 'AMAZON', timeClock: true }),
    driver({ id: 'x', name: 'Gone', fleetGroup: 'LOCAL', active: false }),
  ]
  it('sums several rows a day, ignores out-of-period and open shifts, and keeps zero-hour drivers', () => {
    // Pay period anchor 2026-09-28 → 2026-10-26 starts the period holding 11-02.
    const rows = hoursPerDriver([
      entry({ driverId: 'a', workDate: '2026-11-02', minutes: 240 }),
      entry({ driverId: 'a', workDate: '2026-11-02', minutes: 270 }),
      entry({ driverId: 'a', workDate: '2026-11-03', clockInAt: '2026-11-03T14:00:00Z', clockOutAt: null }),
      entry({ driverId: 'a', workDate: '2026-10-25', minutes: 600 }),
      entry({ driverId: 'e', workDate: '2026-11-04', minutes: 60 }),
    ], drivers, '2026-10-26')
    expect(rows.map((r) => [r.name, r.minutes, r.hours])).toEqual([['Ann', 510, 8.5], ['Eve', 60, 1], ['Bob', 0, 0]])
  })
})

const invoice = (o: Partial<MaintenanceInvoice>): MaintenanceInvoice =>
  ({ id: 'i1', equipmentId: 't1', date: '2026-11-02', vendor: 'Joes Tire', amount: 12345, createdAt: '2026-11-02T00:00:00Z', updatedAt: '', ...o }) as MaintenanceInvoice

const base = (o: Partial<BuildReceiptsInput>): BuildReceiptsInput => ({
  invoices: [], fuel: [], deductions: [], credits: [], payables: [],
  trucks: [{ id: 't1', unitNumber: '101', driverName: 'Ann' }],
  drivers: [driver({ id: 'a', name: 'Ann', fleetGroup: 'LOCAL' })],
  group: 'LOCAL', range: { start: '2026-11-01', end: '2026-11-03' }, ...o,
})

describe('buildReceipts', () => {
  it('marks maintenance PAID only on a payment date or a DONE payable (payable wins)', () => {
    const rows = buildReceipts(base({
      invoices: [
        invoice({ id: 'p', paymentDate: '2026-11-02' }),
        invoice({ id: 'n' }),
        invoice({ id: 'o', paymentDate: '2026-11-02' }),
        invoice({ id: 'q' }),
      ],
      payables: [
        { id: 'pay-o', sourceInvoiceId: 'o', status: 'NEED_TO_PAY' } as VendorPayable,
        { id: 'pay-q', sourceInvoiceId: 'q', status: 'DONE' } as VendorPayable,
      ],
    }))
    const by = Object.fromEntries(rows.map((r) => [r.invoiceId, r.status]))
    expect(by).toEqual({ p: 'PAID', n: 'PENDING', o: 'PENDING', q: 'PAID' })
    expect(rows.find((r) => r.invoiceId === 'q')?.payableId).toBe('pay-q')
  })

  it('never invents a paid state for fuel and driver-pay rows', () => {
    const rows = buildReceipts(base({
      fuel: [{ id: 'f1', transactionDate: '2026-11-03', truckId: 't1', amount: 80.1, locationName: 'Pilot', city: 'Joliet', state: 'IL' } as never],
      deductions: [{ id: 'd1', driverId: 'a', periodStart: '2026-11-02', label: 'Uniform', amount: 25 } as never],
      credits: [
        { id: 'c1', driverId: 'a', periodStart: '2026-11-02', kind: 'DEBIT', reasonCode: 'DAMAGE', amount: 10 } as never,
        { id: 'c2', driverId: 'a', periodStart: '2026-11-02', kind: 'CREDIT', reasonCode: 'BONUS', amount: 99 } as never,
      ],
    }))
    expect(rows.map((r) => [r.kind, r.amountCents, r.status])).toEqual([
      ['FUEL', 8010, null], ['DRIVER_PAY', 1000, null], ['DRIVER_PAY', 2500, null],
    ])
    expect(rows.map((r) => receiptStatus(r).label)).toEqual(['Card charge', 'Settlement', 'Settlement'])
  })

  it('drops archived invoices, other fleets, and anything outside the range', () => {
    const rows = buildReceipts(base({
      invoices: [
        invoice({ id: 'arch', status: 'ARCHIVED' }),
        invoice({ id: 'old', date: '2026-10-01' }),
        invoice({ id: 'other', equipmentId: 't9' }),
        invoice({ id: 'ok' }),
      ],
      fuel: [{ id: 'f9', transactionDate: '2026-11-02', truckId: 't9', amount: 5 } as never],
      deductions: [{ id: 'dz', driverId: 'zzz', periodStart: '2026-11-02', label: 'x', amount: 1 } as never],
    }))
    expect(rows.map((r) => r.id)).toEqual(['inv:ok'])
  })
})
