// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { Equipment } from '@/types/equipment'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

const api = vi.hoisted(() => ({
  listTruckConfigs: vi.fn(),
  upsertTruckConfig: vi.fn(async (input: Record<string, unknown>) => ({ createdAt: '', updatedAt: '', ...input })),
}))
vi.mock('@/lib/apiClient', () => api)
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ hasPageAccess: () => false, isAdmin: true, user: { email: 'a@b.test' } }) }))
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }))
vi.mock('@/hooks/useAllComplianceDocuments', () => ({ useAllComplianceDocuments: () => ({ docFor: () => undefined, loading: false }) }))
vi.mock('@/hooks/useExpenseData', () => ({
  useExpenseData: () => ({ recurring: [], allocations: [], expenseTypes: [], loading: false, refresh: vi.fn() }),
}))
vi.mock('@/lib/insuranceClient', () => ({ getUnitPremiumCents: vi.fn(async () => 0), setUnitPremiumCurrentPeriod: vi.fn() }))

import { invalidateLists } from '@/lib/listCache'
import { useAppStore } from '@/store/useAppStore'
import { TooltipProvider } from '@/components/ui/tooltip'
import { TrucksPage } from './TrucksPage'

const truck = (id: string, unitNumber: string, extra: Partial<Equipment> = {}) =>
  ({ id, unitNumber, type: 'truck', active: true, make: '', model: '', ...extra }) as Equipment

const unitOrder = () =>
  screen.getAllByText(/^#\d+$/).map((el) => el.textContent)

beforeEach(() => {
  vi.clearAllMocks()
  invalidateLists()
  api.listTruckConfigs.mockResolvedValue([
    { truckId: 'a', unitNumber: '1', phone: '+13125550100', phoneLabel: 'Cab', createdAt: '', updatedAt: '' },
    { truckId: 'c', unitNumber: '3', phone: '+13125550101', createdAt: '', updatedAt: '' },
  ])
  useAppStore.setState({
    equipment: [truck('a', '1'), truck('b', '2'), truck('c', '3'), truck('p', '4', { active: false })],
    drivers: [], fleetLoaded: true, maintenanceTasks: [], maintenanceInvoices: [],
  })
})

const renderPage = () => render(<MemoryRouter><TooltipProvider><TrucksPage /></TooltipProvider></MemoryRouter>)

describe('TrucksPage work phones', () => {
  it('shows each truck\'s phone and label, and a prompt where there is none', async () => {
    renderPage()
    expect(await screen.findByText('(312) 555-0100')).toBeTruthy()
    expect(screen.getByText('Cab')).toBeTruthy()
    expect(screen.getAllByText('+ Add phone')).toHaveLength(2)
  })

  it('the "No phone (n)" chip counts active trucks only and filters the table to them', async () => {
    renderPage()
    const chip = await screen.findByRole('button', { name: 'No phone (1)' })
    fireEvent.click(chip)
    expect(unitOrder()).toEqual(['#2'])
  })

  it('sorting by phone puts trucks with none last, in both directions', async () => {
    renderPage()
    await screen.findByText('(312) 555-0100')
    fireEvent.click(screen.getByText('Phone'))
    expect(unitOrder().slice(0, 2)).toEqual(['#1', '#3'])
    expect(unitOrder().at(-1)).not.toBe('#1')
    fireEvent.click(screen.getByText('Phone'))
    expect(unitOrder().slice(0, 2)).toEqual(['#3', '#1'])
  })

  it('typing a number into the row editor saves E.164 and the chip count drops', async () => {
    renderPage()
    const row = (await screen.findByText('#2')).closest('tr') as HTMLElement
    fireEvent.click(within(row).getByText('+ Add phone'))
    fireEvent.change(within(row).getByLabelText('Work phone, truck 2'), { target: { value: '(312) 555-0142' } })
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.upsertTruckConfig).toHaveBeenCalledWith({ truckId: 'b', unitNumber: '2', phone: '+13125550142', phoneLabel: null }))
    await waitFor(() => expect(screen.queryByRole('button', { name: /No phone/ })).toBeNull())
  })
})
