// @vitest-environment jsdom
/**
 * One-time expenses on the Fuel page: the Add expense action is for the owner, admins and Finances holders (never Jason),
 * a hand-entered fuel row shows with a Manual badge, its dollars count in Fuel Spend, and the blended $/gal skips it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const auth = vi.hoisted(() => ({
  current: { email: 'ryne@bcatcorp.com', groups: [] as string[], isOwner: true, isAdmin: false, finances: true },
}))
const api = vi.hoisted(() => ({
  createFuelTransaction: vi.fn(async (i: Record<string, unknown>) => ({ id: 'new-1', createdAt: '', updatedAt: '', ...i })),
  updateFuelTransaction: vi.fn(),
  deleteFuelTransaction: vi.fn(async () => undefined),
  createAuditLog: vi.fn(async () => undefined),
}))
const today = new Date().toISOString().slice(0, 10)
const txs = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], refresh: vi.fn() }))

vi.mock('@/store/useAppStore', () => ({
  useAppStore: (sel: (s: unknown) => unknown) => sel({
    equipment: [{ id: 'eq-3114', type: 'truck', unitNumber: '3114', active: true, fuelCardNumbers: [] }],
    drivers: [{ id: 'd-1', name: 'Joshua Kly', active: true, type: 'driver', assignedTruckId: 'eq-3114' }],
    updateEquipment: vi.fn(),
  }),
}))
vi.mock('@/hooks/useFuelTransactions', () => ({
  useFuelTransactions: () => ({ transactions: txs.rows, loading: false, addTransactions: vi.fn(), refresh: txs.refresh }),
}))
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }))
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { email: auth.current.email, groups: auth.current.groups },
    isOwner: auth.current.isOwner, isAdmin: auth.current.isAdmin, hasPageAccess: () => auth.current.finances,
  }),
  useAuthUser: () => ({ email: auth.current.email, groups: auth.current.groups }),
}))
vi.mock('@/hooks/useExpenseData', () => ({
  useExpenseData: () => ({ expenseTypes: [], records: [], allocations: [], recurring: [], loading: false, error: null, refresh: vi.fn(), createType: vi.fn(), createRecord: vi.fn(), updateRecord: vi.fn(), deleteRecord: vi.fn() }),
}))
vi.mock('@/lib/apiClient', async (orig) => ({ ...(await orig<typeof import('@/lib/apiClient')>()), ...api }))
vi.mock('@/features/dashboard/DieselPriceWidget', () => ({ DieselPriceWidget: () => <div>diesel-stub</div> }))
vi.mock('@/features/expenses/FuelUploadModal', () => ({ FuelUploadModal: () => <div>upload-modal-stub</div> }))
vi.mock('./TruckMpgTable', () => ({ TruckMpgTable: () => <div>mpg-stub</div> }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { FuelPage } from './FuelPage'

const card = { id: 'c1', transactionDate: today, cardNumber: '00098', unitNumber: '3114', truckId: 'eq-3114', fuelType: 'ULSD', itemCategory: 'FUEL', pricePerUnit: 5, quantity: 100, amount: 500, sourceFile: 'EFS.txt', createdAt: '', updatedAt: '' }
const manual = { id: 'm1', transactionDate: today, cardNumber: 'MANUAL', invoiceNumber: 'JPM99d49lk49', unitNumber: '3114', truckId: 'eq-3114', driverName: 'Joshua Kly', locationName: 'Josh Kly (Zelle) — fuel 11.24.26', fuelType: 'FUEL', itemCategory: 'FUEL', pricePerUnit: 0, quantity: 0, amount: 667.81, sourceFile: 'manual-entry:Zelle', createdAt: '', updatedAt: '' }

const renderPage = () => render(<MemoryRouter><FuelPage /></MemoryRouter>)

beforeEach(() => {
  auth.current = { email: 'ryne@bcatcorp.com', groups: [], isOwner: true, isAdmin: false, finances: true }
  txs.rows = [card, manual]
  Object.values(api).forEach((f) => f.mockClear())
})

describe('one-time expenses on the Fuel page', () => {
  it('lists a hand-entered fuel row with a Manual badge and its reference', () => {
    renderPage()
    const row = screen.getByText('JPM99d49lk49').closest('tr') as HTMLElement
    expect(within(row).getByText('Manual')).toBeTruthy()
    expect(within(row).getByText('$667.81')).toBeTruthy()
    expect(within(row).getByText('Zelle')).toBeTruthy()
  })

  it('counts the manual dollars in Fuel Spend but not in the blended price per gallon', () => {
    renderPage()
    expect(screen.getAllByText('$1,168').length).toBeGreaterThan(0)      // 500 card + 667.81 manual
    expect(screen.getAllByText('$5.00').length).toBeGreaterThan(0)
    expect(screen.queryByText('$11.68')).toBeNull()       // 500 / 100 gal, manual dollars left out
  })

  it('shows Add expense to the owner and files a manual fuel entry with a reference', async () => {
    renderPage()
    fireEvent.click(screen.getAllByRole('button', { name: 'Add expense' })[0])
    fireEvent.change(screen.getByLabelText('Amount ($)'), { target: { value: '667.81' } })
    fireEvent.change(screen.getByLabelText('Driver'), { target: { value: 'd-1' } })
    fireEvent.change(screen.getByLabelText('Reference #'), { target: { value: 'JPM99d49lk49' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Add expense' }).at(-1)!)
    await waitFor(() => expect(api.createFuelTransaction).toHaveBeenCalledTimes(1))
    const sent = api.createFuelTransaction.mock.calls[0][0]
    expect(sent).toMatchObject({ cardNumber: 'MANUAL', truckId: 'eq-3114', amount: 667.81, quantity: 0, invoiceNumber: 'JPM99d49lk49', itemCategory: 'FUEL', sourceFile: 'manual-entry:Zelle' })
    expect(api.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'FuelTransaction', action: 'create', user: 'ryne@bcatcorp.com' }))
    await waitFor(() => expect(txs.refresh).toHaveBeenCalled())
  })

  it('refuses a missing truck with a plain message and writes nothing', async () => {
    renderPage()
    fireEvent.click(screen.getAllByRole('button', { name: 'Add expense' })[0])
    fireEvent.change(screen.getByLabelText('Amount ($)'), { target: { value: '25' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Add expense' }).at(-1)!)
    expect((await screen.findByRole('alert')).textContent).toMatch(/Pick a truck/)
    expect(api.createFuelTransaction).not.toHaveBeenCalled()
  })

  it('lets the owner delete, and only after a second click, with an audit entry', async () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /Delete expense JPM99d49lk49/ }))
    expect(api.deleteFuelTransaction).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.deleteFuelTransaction).toHaveBeenCalledWith('m1'))
    expect(api.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'FuelTransaction', action: 'delete' }))
  })

  it('hides delete from a Finances holder who is not the owner or an admin', () => {
    auth.current = { email: 'jenny@bcatcorp.com', groups: [], isOwner: false, isAdmin: false, finances: true }
    renderPage()
    expect(screen.getAllByRole('button', { name: 'Add expense' }).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /Edit expense JPM99d49lk49/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Delete expense/ })).toBeNull()
  })

  it('shows nothing of it to Jason', () => {
    auth.current = { email: 'jason@bcatcorp.com', groups: [], isOwner: false, isAdmin: false, finances: true }
    renderPage()
    expect(screen.queryByRole('button', { name: 'Add expense' })).toBeNull()
    expect(screen.queryByText('One-time expenses')).toBeNull()
    expect(screen.queryByText('JPM99d49lk49')).toBeNull()
  })

  it('shows nothing to someone without the Finances grant', () => {
    auth.current = { email: 'dennis@bcatcorp.com', groups: [], isOwner: false, isAdmin: false, finances: false }
    renderPage()
    expect(screen.queryByRole('button', { name: 'Add expense' })).toBeNull()
    expect(screen.queryByText('One-time expenses')).toBeNull()
  })
})
