import { describe, it, expect } from 'vitest'
import { computeFleetMonthlyLines } from './fleetMonthlyPL'

describe('computeFleetMonthlyLines', () => {
  const r = { revenue: 84601, fuel: 23466, driverCost: 29370 }
  const c = { financing: 3810, maintenance: 11572, lease: 1885, other: 1200, tolls: 2000, insurance: 6395, permits: 983 }
  const contrib = { loanTrailers: 1200, trailerLease: 1885, yardRent: 1000, tolls: 2000 }
  it('adds the box truck driver pay as its own line in the total', () => {
    const without = computeFleetMonthlyLines(r, c, contrib, 200, 3230)
    const withPay = computeFleetMonthlyLines(r, c, contrib, 200, 3230, 6769)
    expect(without.boxTruckPay).toBe(0)
    expect(withPay.boxTruckPay).toBe(6769)
    expect(withPay.totalExpenses).toBeCloseTo(without.totalExpenses + 6769, 6)
    expect(withPay.net).toBeCloseTo(without.net - 6769, 6)
  })
})
