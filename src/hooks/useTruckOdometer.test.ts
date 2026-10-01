// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useTruckOdometer } from './useTruckOdometer'
import type { TruckOdometerDay } from '@/lib/odometerWeek'

const { graphql } = vi.hoisted(() => ({ graphql: vi.fn() }))
vi.mock('aws-amplify/data', () => ({ generateClient: () => ({ graphql }) }))

vi.mock('./useTrucks', () => ({
  useTrucks: () => ({
    trucks: [
      { id: 't1', unitNumber: '009', type: 'truck', active: true },
      { id: 't2', unitNumber: '010', type: 'truck', active: true },
      { id: 'tr1', unitNumber: 'T-1', type: 'trailer', active: true },   // non-goal: not a truck
    ],
  }),
}))
vi.mock('./useLoads', () => ({
  useLoads: () => ({
    loads: [
      { id: 'l1', truckId: null, deliveryDriverId: 'd1', rate: 200000, deliveryAppt: '2026-09-29' },
      { id: 'l2', truckId: 't2', deliveryDriverId: null, rate: 50000, deliveryAppt: '2026-09-30' },
    ],
  }),
}))
vi.mock('./useDrivers', () => ({
  useDrivers: () => ({ drivers: [{ id: 'd1', assignedTruckId: 't1', type: 'company' }] }),
}))

const WEEK = '2026-09-27' // Sunday

function row(over: Partial<TruckOdometerDay> = {}): TruckOdometerDay {
  return {
    truckId: 't1', unitNumber: '009', date: WEEK, weekStart: WEEK,
    startOdometer: 1000, endOdometer: 1100, miles: 100, fuelGallons: 10, mpg: 10,
    source: 'motive', syncedAt: '2026-09-27T06:00:00Z',
    ...over,
  }
}

beforeEach(() => { graphql.mockReset() })

describe('useTruckOdometer', () => {
  it('builds per-truck weeks with miles, MPG and revenue per mile', async () => {
    graphql.mockResolvedValue({ data: { listTruckOdometerDayByWeekStart: { items: [
      row(),
      row({ date: '2026-09-28', startOdometer: 1100, endOdometer: 1250, miles: 150, fuelGallons: 15, mpg: 10 }),
    ] } } })

    const { result } = renderHook(() => useTruckOdometer(WEEK))
    await waitFor(() => expect(result.current.loading).toBe(false))

    // Only trucks are rows (trailer dropped).
    expect(result.current.trucks.map((t) => t.truckId)).toEqual(['t1', 't2'])

    const t1 = result.current.trucks.find((t) => t.truckId === 't1')!
    expect(t1.totalMiles).toBe(250)
    expect(t1.mpg).toBeCloseTo(250 / 25, 6)
    expect(t1.days[1].miles).toBe(150)
    expect(t1.days[2].miles).toBeNull()          // Tuesday was never reported — a gap
    expect(t1.revenue).toBe(2000)                 // 200000 cents → $2000, delivery driver's truck
    expect(t1.revenuePerMile).toBeCloseTo(8, 6)   // 2000 / 250

    const t2 = result.current.trucks.find((t) => t.truckId === 't2')!
    expect(t2.totalMiles).toBe(0)
    expect(t2.revenue).toBe(500)
    expect(t2.revenuePerMile).toBeNull()          // no miles → no divide by zero
  })

  it('queries the odometer ledger for the selected week', async () => {
    graphql.mockResolvedValue({ data: { listTruckOdometerDayByWeekStart: { items: [] } } })
    const { result } = renderHook(() => useTruckOdometer(WEEK))
    await waitFor(() => expect(result.current.loading).toBe(false))
    // The week index, not a filtered scan of every truck-day ever recorded.
    expect(graphql).toHaveBeenCalledWith(expect.objectContaining({
      query: expect.stringContaining('listTruckOdometerDayByWeekStart'),
      variables: expect.objectContaining({ weekStart: WEEK }),
    }))
  })

  it('keeps a Motive-only unit visible even without an Equipment record', async () => {
    graphql.mockResolvedValue({ data: { listTruckOdometerDayByWeekStart: { items: [
      row({ truckId: 'motive:890', unitNumber: '890', startOdometer: 1000, endOdometer: 1088, miles: 88 }),
    ] } } })
    const { result } = renderHook(() => useTruckOdometer(WEEK))
    await waitFor(() => expect(result.current.loading).toBe(false))
    const orphan = result.current.trucks.find((t) => t.truckId === 'motive:890')!
    expect(orphan.unitNumber).toBe('890')
    expect(orphan.totalMiles).toBe(88)
  })

  it('surfaces a load failure without inventing data', async () => {
    graphql.mockRejectedValue(new Error('network down'))
    const { result } = renderHook(() => useTruckOdometer(WEEK))
    await waitFor(() => expect(result.current.error).toBe('network down'))
    expect(result.current.trucks.every((t) => t.totalMiles === 0)).toBe(true)
  })
})
