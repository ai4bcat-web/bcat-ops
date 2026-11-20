// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReviewMonthInput } from '@/lib/profitReview'

const base: ReviewMonthInput = {
  key: '2026-10', label: 'Oct 2026', daysInMonth: 31, daysElapsed: 31, revenue: 20000, fuel: 4000, driverPay: 6000, maintenance: 1000,
  insurance: 900, fixed: 500, miles: 0, loads: 0, gallons: 0, trucks: [], customers: [], unitMaintenance: [],
}
vi.mock('@/hooks/useProfitReview', () => ({
  useProfitReview: () => ({
    months: [
      { ...base, key: '2026-08', label: 'Aug 2026', incomplete: true },
      base,
      { ...base, key: '2026-11', label: 'Nov 2026', daysElapsed: 19, fuel: 9000, driverPay: 9000, maintenance: 5000 },
    ],
    loading: false, error: null, unattributedFuel: { count: 0, amount: 0 },
  }),
}))

import { LocalFleetCostShareCard } from './LocalFleetCostShareCard'

describe('LocalFleetCostShareCard', () => {
  it('shows only fuel, driver pay and maintenance, with no insurance anywhere', () => {
    const { container } = render(<LocalFleetCostShareCard />)
    for (const label of ['Fuel', 'Driver pay', 'Maintenance', 'Profit']) expect(screen.getAllByText(new RegExp(label)).length).toBeGreaterThan(0)
    expect(container.textContent).not.toMatch(/insurance/i)
  })

  it('draws one pie per month, with accessible text for each', () => {
    render(<LocalFleetCostShareCard />)
    expect(screen.getAllByRole('img')).toHaveLength(3)
    expect(screen.getByRole('img', { name: /Oct: \$20,000 revenue\. Fuel 20\.0%, Driver pay 30\.0%, Maintenance 5\.0%\. Profit 45\.0%/ })).toBeTruthy()
    expect(screen.getByRole('img', { name: /Aug: \$20,000 revenue, costs not on file/ })).toBeTruthy()
  })

  it('marks the running month as to date and flags a month whose costs pass its revenue', () => {
    render(<LocalFleetCostShareCard />)
    expect(screen.getByText(/current month is to date/i)).toBeTruthy()
    expect(screen.getByText(/Over revenue · costs 115%/)).toBeTruthy()
    expect(screen.getByText(/costs not on file/)).toBeTruthy()
  })

  it('shows exact dollars and percents for a month on hover', () => {
    render(<LocalFleetCostShareCard />)
    fireEvent.mouseEnter(screen.getByTestId('fleet-pie-2026-10'))
    const tip = screen.getByRole('tooltip')
    expect(tip.textContent).toContain('$4,000')
    expect(tip.textContent).toContain('30.0%')
    expect(tip.textContent).toContain('Profit')
    expect(tip.textContent).toContain('$9,000')
    expect(tip.textContent).toContain('45.0%')
  })

  it('opens the tooltip in a portal on the page body, outside the card, so the card cannot clip it', () => {
    const { container } = render(<LocalFleetCostShareCard />)
    fireEvent.mouseEnter(screen.getByTestId('fleet-pie-2026-10'))
    const tip = screen.getByRole('tooltip')
    expect(container.contains(tip)).toBe(false)
    expect(tip.parentElement).toBe(document.body)
    expect(tip.style.position).toBe('fixed')
    fireEvent.mouseLeave(screen.getByTestId('fleet-pie-2026-10'))
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('opens the tooltip on tap for touch screens', () => {
    render(<LocalFleetCostShareCard />)
    fireEvent.click(screen.getByTestId('fleet-pie-2026-10'))
    expect(screen.getByRole('tooltip').textContent).toContain('Profit')
  })

  it('says what the rings and the left-over slice mean', () => {
    render(<LocalFleetCostShareCard />)
    expect(screen.getByText(/Each pie is the month's revenue/)).toBeTruthy()
  })
})
