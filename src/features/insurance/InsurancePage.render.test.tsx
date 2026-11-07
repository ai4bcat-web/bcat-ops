// @vitest-environment jsdom
/**
 * With no insurance period yet the page offers to create one; naming it calls addPeriod
 * (as the current period, since it is the first).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const addPeriod = vi.fn(async (label: string) => ({ id: 'p-1', label }))

vi.mock('@/hooks/useInsurance', () => ({
  useInsurance: () => ({
    loading: false, periods: [], currentPeriod: null, addPeriod,
    summary: () => null, unitRows: () => [], wcItem: () => null, refresh: vi.fn(),
  }),
}))
vi.mock('@/hooks/useInsuranceRecovery', () => ({ useInsuranceRecovery: () => ({}) }))
vi.mock('@/hooks/useExpenseData', () => ({
  useExpenseData: () => ({ recurring: [], allocations: [], expenseTypes: [] }),
}))
vi.mock('@/hooks/useTrucks', () => ({ useTrucks: () => ({ equipment: [] }) }))
vi.mock('@/lib/insuranceClient', () => ({ importLegacyTruckPremiums: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { InsurancePage } from './InsurancePage'

beforeEach(() => { addPeriod.mockClear() })
afterEach(() => { vi.unstubAllGlobals() })

describe('InsurancePage render', () => {
  it('shows the heading and the empty state', () => {
    render(<InsurancePage />)
    expect(screen.getByRole('heading', { name: 'Insurance' })).toBeTruthy()
    expect(screen.getByText('No insurance periods yet')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Create first period/ })).toBeTruthy()
  })

  it('creates the first period as current from the prompted name', async () => {
    vi.stubGlobal('prompt', vi.fn(() => '  Test Policy Year  '))
    render(<InsurancePage />)
    fireEvent.click(screen.getByRole('button', { name: /Create first period/ }))
    await waitFor(() => expect(addPeriod).toHaveBeenCalledWith('Test Policy Year', { makeCurrent: true }))
  })
})
