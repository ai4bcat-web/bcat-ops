// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { FleetMilesPage } from './FleetMilesPage'
import type { TruckMilesWeek } from '@/hooks/useTruckOdometer'

vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }))

// Mutable holder so the mocked hook reads data set by each test (vi.mock factories
// run before module-level consts, so they cannot close over them directly).
const state = vi.hoisted(() => ({ trucks: [] as TruckMilesWeek[] }))
vi.mock('@/hooks/useTruckOdometer', () => ({
  useTruckOdometer: () => ({ trucks: state.trucks, loading: false, error: null, refresh: () => {} }),
}))

function truck(over: Partial<TruckMilesWeek> & Pick<TruckMilesWeek, 'truckId' | 'unitNumber'>): TruckMilesWeek {
  return { days: [], totalMiles: 0, totalFuelGallons: null, mpg: null, revenue: 0, revenuePerMile: null, ...over }
}

const day = (date: string, label: string, miles: number | null, mpg: number | null) => ({
  date, label, startOdometer: null, endOdometer: null, miles, fuelGallons: null, mpg,
})

describe('FleetMilesPage', () => {
  it('renders a gap for a day with no reading and revenue per mile per truck', () => {
    state.trucks = [
      truck({
        truckId: 't1', unitNumber: '009', totalMiles: 250, mpg: 10, revenue: 2000, revenuePerMile: 8,
        days: [
          day('2026-09-27', 'Sun', 100, 10),
          day('2026-09-28', 'Mon', null, null),   // Motive reported nothing — a gap
          day('2026-09-29', 'Tue', 150, 10),
          day('2026-09-30', 'Wed', null, null),
          day('2026-10-01', 'Thu', null, null),
          day('2026-10-02', 'Fri', null, null),
          day('2026-10-03', 'Sat', null, null),
        ],
      }),
      truck({ truckId: 't2', unitNumber: '010', revenue: 500, revenuePerMile: null }),
    ]

    render(<FleetMilesPage />)

    const cells009 = within(screen.getByText('009').closest('tr')!).getAllByRole('cell')
    // [0]=truck, [1]=Sun … [7]=Sat.
    expect(cells009[1]).toHaveTextContent('100')
    expect(cells009[2]).toHaveTextContent('—')            // gap, not an invented 0
    expect(cells009[cells009.length - 1]).toHaveTextContent('$8.00')

    // Zero miles must not render NaN/Infinity.
    const cells010 = within(screen.getByText('010').closest('tr')!).getAllByRole('cell')
    expect(cells010[cells010.length - 1]).toHaveTextContent('—')
  })
})
