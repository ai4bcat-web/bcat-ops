// @vitest-environment jsdom
// The monthly comparison counts a load in the month it was DELIVERED, the way Finances does, and splits it by the
// delivery driver's fleet into the three groups Finances shows: Local, Owner operators, Brokered / no driver.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { Driver, Load } from '@/types'

vi.mock('@/lib/apiClient', () => ({}))

const { useAppStore } = await import('@/store/useAppStore')
const { useMonthlyMetrics } = await import('./useMonthlyMetrics')

beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-28T18:00:00Z')) })
afterAll(() => { vi.useRealTimers() })

const drivers = [
  { id: 'ivan', fleetGroup: 'COMPANY', driverType: 'COMPANY' },
  { id: 'box', fleetGroup: 'BOX_TRUCK', driverType: 'COMPANY' },
  { id: 'oo', fleetGroup: 'AMAZON', driverType: 'OWNER_OPERATOR' },
  { id: 'brk', type: 'broker' },
] as unknown as Driver[]

const load = (id: string, over: Record<string, unknown>) =>
  ({ id, pickupAppt: '2026-10-28T15:00:00Z', deliveryAppt: '2026-11-02T15:00:00Z', rate: 100_000, pickupDriverId: null, deliveryDriverId: null, ...over }) as unknown as Load

function run(loads: Load[]) {
  useAppStore.setState({ loads, drivers, equipment: [], ensureLoadRange: vi.fn(async () => undefined), loadedMonths: new Set<string>() } as never)
  return renderHook(() => useMonthlyMetrics(6)).result.current
}

describe('useMonthlyMetrics by delivery date', () => {
  it('counts a load in the month it was delivered, not the month it was picked up', () => {
    const m = run([load('a', { deliveryDriverId: 'ivan' })]) // picked up Oct 28, delivered Nov 2
    expect(m.months.find((b) => b.key === '2026-10')!.loads).toBe(0)
    expect(m.months.find((b) => b.key === '2026-11')!.loads).toBe(1)
    expect(m.months.find((b) => b.key === '2026-11')!.revenue).toBe(100_000)
  })

  it('a load with no delivery date, or delivering after today, is in no month yet', () => {
    const m = run([load('a', { deliveryDriverId: 'ivan', deliveryAppt: '' }), load('b', { deliveryDriverId: 'ivan', deliveryAppt: '2026-11-30T15:00:00Z' }), load('c', { deliveryDriverId: 'ivan', deliveryAppt: '2026-11-28T09:00:00Z' })])
    expect(m.months.reduce((n, b) => n + b.loads, 0)).toBe(1)
    expect(m.months.find((b) => b.key === '2026-11')!.loads).toBe(1)
  })

  it('splits by the delivery driver into Local, Owner operators and Brokered / no driver, adding up to the total', () => {
    const m = run([
      load('1', { deliveryDriverId: 'ivan', rate: 100 }),
      load('2', { deliveryDriverId: 'box', rate: 200 }),
      load('3', { deliveryDriverId: 'oo', rate: 400 }),
      load('4', { deliveryDriverId: 'brk', rate: 800 }),
      load('5', { deliveryDriverId: null, pickupDriverId: 'ivan', rate: 1600 }), // pickup driver is not the delivery driver
      load('6', { deliveryDriverId: 'gone', rate: 3200 }),
    ])
    const nov = m.months.find((b) => b.key === '2026-11')!
    expect(nov.revenueLocal).toBe(300)
    expect(nov.revenueOwnerOp).toBe(400)
    expect(nov.revenueOther).toBe(800 + 1600 + 3200)
    expect(nov.revenueLocal + nov.revenueOwnerOp + nov.revenueOther).toBe(nov.revenue)
    expect([nov.loadsLocal, nov.loadsOwnerOp, nov.loadsOther]).toEqual([2, 1, 3])
    expect(nov.loadsLocal + nov.loadsOwnerOp + nov.loadsOther).toBe(nov.loads)
  })

  it('a voided load counts nowhere', () => {
    const m = run([load('a', { deliveryDriverId: 'ivan', voidedAt: 'v' })])
    expect(m.months.reduce((n, b) => n + b.loads, 0)).toBe(0)
  })
})
