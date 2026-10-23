import { describe, it, expect } from 'vitest'
import { holdingArea, platesAndEldFor, runningOn, stopFromPatch } from './truckInactive'
import { insuranceRangeByTruckDated, truckActiveOn } from './insuranceAllocation'
import type { RecurringExpenseData, TruckExpenseAllocationData, ExpenseTypeData } from './apiClient'
import type { Equipment } from '@/types/equipment'

const types = [
  { id: 'tp', name: 'Plates / Registration', category: 'PERMITS' },
  { id: 'te', name: 'ELD', category: 'OTHER' },
  { id: 'tl', name: 'Truck Loan', category: 'FINANCING' },
] as ExpenseTypeData[]
const allocs = [
  { id: 'a1', expenseTypeId: 'tp', allocationMethod: 'SPLIT_EVEN', truckIds: ['t1'] },
  { id: 'a2', expenseTypeId: 'te', allocationMethod: 'SPLIT_EVEN', truckIds: ['t1'] },
  { id: 'a3', expenseTypeId: 'tl', allocationMethod: 'SPLIT_EVEN', truckIds: ['t1'] },
] as TruckExpenseAllocationData[]
const rec = (id: string, typeId: string, allocId: string, over: Partial<RecurringExpenseData> = {}) =>
  ({ id, expenseTypeId: typeId, allocationId: allocId, monthlyAmount: 50, startMonth: '2026-01', active: true, createdAt: '', updatedAt: '', ...over }) as RecurringExpenseData
const recurring = [rec('r1', 'tp', 'a1'), rec('r2', 'te', 'a2'), rec('r3', 'tl', 'a3')]

describe('parking a truck', () => {
  it('finds only the plates and ELD still running on the truck', () => {
    expect(platesAndEldFor('t1', '2026-10-23', recurring, allocs, types).map((c) => c.slot)).toEqual(['plates', 'eld'])
    const ended = [rec('r1', 'tp', 'a1', { endDate: '2026-10-01' }), recurring[1]]
    expect(platesAndEldFor('t1', '2026-10-23', ended, allocs, types).map((c) => c.slot)).toEqual(['eld'])
  })

  it('holds plates and ELD of inactive trucks only', () => {
    const trucks = [
      { id: 't1', type: 'truck', unitNumber: '101', active: false, inactiveSince: '2026-10-20' },
      { id: 't2', type: 'truck', unitNumber: '102', active: true },
    ] as Equipment[]
    expect(holdingArea(trucks, '2026-10-23', recurring, allocs, types)).toHaveLength(2)
    expect(holdingArea([{ ...trucks[0], active: true }], '2026-10-23', recurring, allocs, types)).toHaveLength(0)
  })

  it('stops a cost the day before the date, or drops it if it never started', () => {
    expect(stopFromPatch({ startMonth: '2026-01', startDate: null }, '2026-11-01')).toEqual({ endDate: '2026-10-31', endMonth: '2026-10' })
    expect(stopFromPatch({ startMonth: '2026-11', startDate: '2026-11-05' }, '2026-11-01')).toEqual({ active: false })
    expect(runningOn({ active: true, endDate: '2026-10-31' }, '2026-11-01')).toBe(false)
  })

  it('counts insurance up to the inactive date and none after, including a future date', () => {
    expect(truckActiveOn({ id: 't', active: false, inactiveSince: '2026-11-01' }, '2026-10-31')).toBe(true)
    expect(truckActiveOn({ id: 't', active: false, inactiveSince: '2026-11-01' }, '2026-11-01')).toBe(false)
    const items = [{ kind: 'TRUCK' as const, equipmentId: 't1', annualCents: 365_00 }]
    const trucks = [{ id: 't1', active: false, inactiveSince: '2026-10-20' }]
    // $365/yr = $1/day; Oct 1–19 is 19 days.
    expect(insuranceRangeByTruckDated(items, trucks, [], { start: '2026-10-01', end: '2026-10-31' }).t1).toBeCloseTo(19)
    expect(insuranceRangeByTruckDated(items, trucks, [], { start: '2026-11-01', end: '2026-11-30' }).t1 ?? 0).toBe(0)
    expect(insuranceRangeByTruckDated(items, trucks, [], { start: '2026-09-01', end: '2026-09-30' }).t1).toBeCloseTo(30)
  })
})
