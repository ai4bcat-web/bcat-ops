// @vitest-environment jsdom
/**
 * Smoke test that the fuel page renders WITH its miles and MPG columns.
 *
 * The arithmetic is covered by fuelEfficiency.test.ts. What that can't catch is the
 * wiring: a mileage row keyed by truck id that never matches the equipment records,
 * or a column added to <thead> but not <tbody>. Both leave every MPG cell as an em
 * dash — which looks exactly like "no data synced yet" rather than a bug.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { Equipment } from '@/types/equipment'

const truck = (id: string, unitNumber: string): Equipment => ({
  id, type: 'truck', unitNumber, vin: `VIN${id}`, plate: 'P1', make: 'Freightliner',
  model: 'Cascadia', year: 2021, ownership: 'owned', insured: true, active: true,
  onTollwayAccount: false, fleetGroup: 'LOCAL', createdAt: '', updatedAt: '',
})

const equipment = [truck('t1', '214'), truck('t2', '215')]
const drivers = [{ id: 'd1', name: 'Zak Pace', active: true, type: 'driver', assignedTruckId: 't1', createdAt: '', updatedAt: '' }]

// A date inside whatever "this month" is when the suite runs, so the default range
// includes it without the test hard-coding a calendar month.
const today = new Date()
const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-15`

vi.mock('@/hooks/useFuelTransactions', () => ({
  useFuelTransactions: () => ({
    // t1: 1,000 gal / 6,200 mi → 6.2 MPG. t2 fuels but has no ELD miles.
    transactions: [
      { id: 'f1', transactionDate: day, amount: 3800, quantity: 1000, cardNumber: '111', unitNumber: '214', truckId: 't1', itemCategory: 'FUEL' },
      { id: 'f2', transactionDate: day, amount: 400, quantity: 100, cardNumber: '222', unitNumber: '215', truckId: 't2', itemCategory: 'FUEL' },
    ],
    loading: false, addTransactions: vi.fn(), refresh: vi.fn(),
  }),
}))

vi.mock('@/hooks/useTruckMileage', () => ({
  useTruckMileage: () => ({
    rows: [
      { truckId: 't1', unitNumber: '214', periodStart: day, periodType: 'DAY', miles: 4000, source: 'motive', syncedAt: '', createdAt: '', updatedAt: '' },
      { truckId: 't1', unitNumber: '214', periodStart: day, periodType: 'DAY', miles: 2200, source: 'motive', syncedAt: '', createdAt: '', updatedAt: '' },
    ],
    loading: false, error: null, refresh: vi.fn(),
  }),
}))

vi.mock('@/store/useAppStore', () => ({
  useAppStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ equipment, drivers, updateEquipment: vi.fn(), maintenanceInvoices: [] }),
}))

vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }))
vi.mock('@/features/dashboard/DieselPriceWidget', () => ({ DieselPriceWidget: () => null }))

const { FuelPage } = await import('./FuelPage')

const renderPage = () => render(<MemoryRouter><FuelPage /></MemoryRouter>)

describe('FuelPage renders miles and MPG', () => {
  it('mounts without throwing', () => {
    renderPage()
    expect(screen.getAllByText(/Fuel by Truck/i).length).toBeGreaterThan(0)
  })

  it('shows Miles and MPG columns in the per-truck table', () => {
    renderPage()
    const table = screen.getByText('Fuel by Truck').closest('div')?.parentElement as HTMLElement
    expect(within(table).getByText('Miles')).toBeTruthy()
    expect(within(table).getByText('MPG')).toBeTruthy()
  })

  it('sums the day rows and computes MPG for the truck that has both', () => {
    renderPage()
    // 4,000 + 2,200 miles over 1,000 gallons.
    expect(screen.getAllByText('6,200').length).toBeGreaterThan(0)
    expect(screen.getAllByText('6.2').length).toBeGreaterThan(0)
  })

  it('shows fleet miles and average MPG as stat cards', () => {
    renderPage()
    expect(screen.getAllByText('Miles').length).toBeGreaterThan(0)
    expect(screen.getByText('Avg MPG')).toBeTruthy()
  })
})

describe('FuelPage weekly breakdown', () => {
  it('renders a Sunday–Saturday week card', () => {
    renderPage()
    expect(screen.getByText(/Fuel & miles by week/i)).toBeTruthy()
    expect(screen.getByText(/Sun–Sat/)).toBeTruthy()
  })

  it('offers a per-truck filter so a single unit can be read week to week', () => {
    renderPage()
    expect(screen.getByRole('option', { name: 'All trucks' })).toBeTruthy()
    expect(screen.getByRole('option', { name: '#214' })).toBeTruthy()
  })

  it('labels weeks as M/D – M/D', () => {
    renderPage()
    expect(screen.getAllByText(/^\d{1,2}\/\d{1,2} – \d{1,2}\/\d{1,2}$/).length).toBe(12)
  })
})
