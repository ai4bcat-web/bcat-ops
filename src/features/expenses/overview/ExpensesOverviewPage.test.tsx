// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DateRange, FleetProfitabilityResult } from '@/lib/fleetProfitability'

const mocks = vi.hoisted(() => ({
  ranges: [] as DateRange[],
  payables: [] as unknown[],
}))

const rollup = (days: number): FleetProfitabilityResult => ({
  range: { start: '', end: '' },
  trucks: [],
  rollup: {
    revenue: 0, miles: 0, fuel: days * 10, insurance: 0, loan: 0, otherExpenses: 0, driverCost: days * 100, net: 0,
    revenuePerMile: null, fuelPerMile: null,
    categories: { insurance: 0, financing: 0, lease: 0, maintenance: 0, permits: 0, tolls: 0, other: 0 },
  },
  revenueLeakage: { broker: 0, unattributed: 0, noTruck: 0 },
})
const days = (r: DateRange) => Math.round((Date.parse(r.end) - Date.parse(r.start)) / 86_400_000) + 1

vi.mock('@/hooks/useFleetProfitability', () => ({
  useFleetProfitability: (range: DateRange) => {
    mocks.ranges.push(range)
    return {
      data: rollup(days(range)),
      computeForRange: (r: DateRange) => rollup(days(r) / 2),
      members: [{ truckId: 't1', unitNumber: '101', driverName: 'Ann', hasEquipment: true, hasFuelCard: true }],
      fuelTxs: [],
      loading: false,
      error: null,
    }
  },
}))
vi.mock('@/hooks/useDrivers', () => ({ useDrivers: () => ({ drivers: [] }) }))
vi.mock('@/hooks/useVendorPayables', () => ({
  useVendorPayables: () => ({ items: mocks.payables, loading: false, error: null, getAttachmentUrl: () => Promise.resolve('https://x/y.png') }),
}))
vi.mock('@/lib/apiClient', () => ({
  listDriverPayDeductions: () => Promise.resolve([]),
  listDriverPayCredits: () => Promise.resolve([]),
  listTimeClockEntries: () => Promise.resolve([]),
}))
vi.mock('@/store/useAppStore', () => ({
  useAppStore: (sel: (s: unknown) => unknown) => sel({
    maintenanceInvoices: [
      // The page's "today" is the Chicago date, which differs from the UTC date in the evening.
      { id: 'i1', equipmentId: 't1', date: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }), vendor: 'Joes Tire', amount: 12345, createdAt: '', updatedAt: '', paymentDate: undefined },
    ],
  }),
}))

import { ExpensesOverviewPage } from './ExpensesOverviewPage'

const renderPage = () => render(<MemoryRouter><ExpensesOverviewPage /></MemoryRouter>)

describe('ExpensesOverviewPage', () => {
  beforeEach(() => { mocks.ranges.length = 0; mocks.payables = [] })

  it('one D/W/M choice moves the range behind every card', async () => {
    renderPage()
    const group = await screen.findByRole('group', { name: 'Expense totals' })
    const total = () => within(group).getByText('Total expenses').closest('.tms-kpi-card')!.querySelector('.tms-kpi-card-value')!.textContent
    const dayTotal = (n: number) => `$${(n * 110).toFixed(2)}`
    // Default is month to date (≥1 day, ends today); switch every card to the week.
    fireEvent.click(within(group).getAllByRole('button', { name: 'W' })[0])
    await waitFor(() => expect(total()).toBe(dayTotal(7)))
    expect(within(group).getByText('Fuel').closest('.tms-kpi-card')!.querySelector('.tms-kpi-card-value')!.textContent).toBe('$70.00')
    expect(within(group).getByText('Salary (driver pay)').closest('.tms-kpi-card')!.querySelector('.tms-kpi-card-value')!.textContent).toBe('$700.00')
    fireEvent.click(within(group).getAllByRole('button', { name: 'D' })[2])
    await waitFor(() => expect(total()).toBe(dayTotal(1)))
  })

  it('shows PENDING for an unpaid maintenance invoice and an explicit no-image state', async () => {
    renderPage()
    const row = (await screen.findByRole('button', { name: 'Joes Tire' })).closest('tr')!
    expect(within(row).getByText('Pending')).toBeTruthy()
    expect(within(row).getByText('$123.45')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Joes Tire' }))
    expect(await screen.findByText('No image on file for this receipt')).toBeTruthy()
    expect(screen.getByTestId('receipt-amount').textContent).toContain('$123.45')
  })

  it('a DONE payable turns the receipt Paid', async () => {
    mocks.payables = [{ id: 'p1', sourceInvoiceId: 'i1', status: 'DONE', attachments: [] }]
    renderPage()
    const row = (await screen.findByRole('button', { name: 'Joes Tire' })).closest('tr')!
    expect(within(row).getByText('Paid')).toBeTruthy()
  })
})
