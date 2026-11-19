// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ReviewMonthInput } from '@/lib/profitReview'

const base: ReviewMonthInput = {
  key: '2026-10', label: 'Oct 2026', daysInMonth: 31, daysElapsed: 31, revenue: 20000, fuel: 4000, driverPay: 6000, maintenance: 1000,
  insurance: 0, fixed: 500, miles: 0, loads: 0, gallons: 0, trucks: [], customers: [], unitMaintenance: [],
}
vi.mock('@/hooks/useProfitReview', () => ({ useProfitReview: () => ({ months: [base, { ...base, key: '2026-11', label: 'Nov 2026', daysElapsed: 19 }], loading: false, error: null, unattributedFuel: { count: 0, amount: 0 } }) }))
vi.mock('recharts', async () => {
  const actual = await vi.importActual<typeof import('recharts')>('recharts')
  return { ...actual, ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }
})

import { LocalFleetCostShareCard } from './LocalFleetCostShareCard'

describe('LocalFleetCostShareCard', () => {
  it('names the four cost shares, notes the partial month and says where to enter missing insurance', () => {
    render(<LocalFleetCostShareCard />)
    for (const label of ['Fuel', 'Driver pay', 'Insurance', 'Maintenance']) expect(screen.getAllByText(new RegExp(label)).length).toBeGreaterThan(0)
    expect(screen.getByText(/current month is to date/i)).toBeTruthy()
    expect(screen.getByText(/Add the policy lines on the Insurance page/)).toBeTruthy()
  })

  it('says what the columns and the left-over segment mean', () => {
    render(<LocalFleetCostShareCard />)
    expect(screen.getByText(/Column height is the month's revenue/)).toBeTruthy()
    expect(screen.getAllByText(/Left over/).length).toBeGreaterThan(0)
  })
})
