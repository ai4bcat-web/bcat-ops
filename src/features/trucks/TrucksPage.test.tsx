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
  updateEquipment: vi.fn(async () => ({})),
  updateDriver: vi.fn(async (id: string, patch: Record<string, unknown>) => ({ id, ...patch })),
  createAuditLog: vi.fn(async () => {}),
  graphqlErrorText: vi.fn(() => ''),
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
    // Truck 2 only: the parked truck 4 is under the Inactive tab, not in the default list.
    expect(screen.getAllByText('+ Add phone')).toHaveLength(1)
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

describe('TrucksPage trailers: active / inactive', () => {
  const trailer = (id: string, unitNumber: string, extra: Partial<Equipment> = {}) =>
    ({ id, unitNumber, type: 'trailer', active: true, make: '', model: '', ...extra }) as Equipment

  beforeEach(() => {
    api.listTruckConfigs.mockResolvedValue([])
    useAppStore.setState({
      equipment: [truck('a', '1'), trailer('t1', '501'), trailer('t2', '502'), trailer('t3', '503', { active: false, inactiveSince: '2026-10-01' })],
      drivers: [], fleetLoaded: true, maintenanceTasks: [], maintenanceInvoices: [], auditLog: [], currentUserEmail: 'ops@bcat.test',
    })
  })

  const rowOf = async (unit: string) => (await screen.findByText(`#${unit}`)).closest('tr') as HTMLElement
  const dialog = () => screen.findByRole('dialog')

  it('lists active units under All and Trailers, and the parked ones only under Inactive', async () => {
    renderPage()
    await screen.findByText('#501')
    expect(unitOrder()).toEqual(['#1', '#501', '#502'])
    fireEvent.click(screen.getByRole('button', { name: 'Trailers' }))
    expect(unitOrder()).toEqual(['#501', '#502'])
    fireEvent.click(screen.getByRole('button', { name: 'Inactive (1)' }))
    expect(unitOrder()).toEqual(['#503'])
    expect(within(await rowOf('503')).getByRole('button', { name: 'Reactivate' })).toBeTruthy()
  })

  it('marking a trailer inactive records the day, drops it from the counts and writes an audit entry', async () => {
    renderPage()
    fireEvent.click(within(await rowOf('501')).getByRole('button', { name: 'Mark inactive' }))
    const d = within(await dialog())
    // A trailer has no plates/ELD to hold, so none of those questions appear.
    expect(d.queryByText(/plates|ELD/i)).toBeNull()
    fireEvent.click(d.getByRole('button', { name: 'Mark inactive' }))

    await waitFor(() => expect(useAppStore.getState().equipment.find((e) => e.id === 't1')?.active).toBe(false))
    expect(useAppStore.getState().equipment.find((e) => e.id === 't1')?.inactiveSince).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(api.updateEquipment).toHaveBeenCalledWith('t1', { active: false, inactiveSince: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) })
    expect(api.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      entityType: 'Equipment', entityId: 't1', action: 'update',
      changes: expect.objectContaining({ active: { from: true, to: false } }),
    }))
    expect(screen.queryByText('#501')).toBeNull()
    expect(screen.getByRole('button', { name: 'Inactive (2)' })).toBeTruthy()
  })

  it('reactivating clears inactiveSince and audits it', async () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Inactive (1)' }))
    fireEvent.click(within(await rowOf('503')).getByRole('button', { name: 'Reactivate' }))

    await waitFor(() => expect(useAppStore.getState().equipment.find((e) => e.id === 't3')?.active).toBe(true))
    expect(useAppStore.getState().equipment.find((e) => e.id === 't3')?.inactiveSince).toBeNull()
    expect(api.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      entityType: 'Equipment', entityId: 't3',
      changes: { active: { from: false, to: true }, inactiveSince: { from: '2026-10-01', to: null } },
    }))
  })

  it('a trailer still assigned to a driver cannot be parked until it is unassigned', async () => {
    useAppStore.setState({ drivers: [{ id: 'd1', name: 'Dana Driver', active: true, type: 'driver', assignedTrailerId: 't1' }] as never })
    renderPage()
    fireEvent.click(within(await rowOf('501')).getByRole('button', { name: 'Mark inactive' }))
    const d = within(await dialog())
    expect(d.getByText('Dana Driver')).toBeTruthy()
    const save = d.getByRole('button', { name: 'Mark inactive' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)

    fireEvent.click(d.getByRole('button', { name: 'Unassign' }))
    await waitFor(() => expect(api.updateDriver).toHaveBeenCalledWith('d1', { assignedTrailerId: null }))
    await waitFor(() => expect((within(screen.getByRole('dialog')).getByRole('button', { name: 'Mark inactive' }) as HTMLButtonElement).disabled).toBe(false))
  })
})
