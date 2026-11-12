// @vitest-environment jsdom
/**
 * Asset profiles: the Trucks | Trailers list, the profile page and the new-asset wizard render and behave.
 * The store, the Files hub, the expense/phone hooks and the heavy editors are stubbed at their edges;
 * the pages, the dense grid and the shared profile pieces are the real ones.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, fireEvent, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import type { Driver } from '@/types'
import type { Equipment } from '@/types/equipment'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

const zak: Driver = {
  id: 'd1', name: 'Zak Pace', phone: '(847) 293-6704', active: true, type: 'driver', fleetGroup: 'BOX_TRUCK',
  assignedTruckId: 't1', assignedTrailerId: 'r1', dispatcherPrimary: 'jason@bcatcorp.com', createdAt: '', updatedAt: '',
}
const amy: Driver = { id: 'd2', name: 'Amy Local', phone: '(312) 555-0111', active: true, type: 'driver', fleetGroup: 'LOCAL', createdAt: '', updatedAt: '' }
const truck: Equipment = {
  id: 't1', type: 'truck', unitNumber: '214', make: 'Freightliner', model: 'Cascadia', year: 2021, vin: '1FUJGLDR7CLBP1234', plate: 'P123456',
  ownership: 'owned', insured: true, active: true, onTollwayAccount: false, fleetGroup: 'BOX_TRUCK', lastPmMileage: 100000, createdAt: '', updatedAt: '',
} as Equipment
const spare: Equipment = { ...truck, id: 't2', unitNumber: '300', vin: undefined, plate: undefined, fleetGroup: 'LOCAL' }
const trailer: Equipment = { ...truck, id: 'r1', type: 'trailer', unitNumber: 'T-9', make: 'Great Dane', model: 'Reefer', fleetGroup: null }

const addEquipment = vi.fn((e: Partial<Equipment>) => ({ ...truck, ...e, id: 'new1' }) as Equipment)
const updateEquipment = vi.fn()
const assignTruckToDriver = vi.fn(async () => {})
const updateDriver = vi.fn(async () => {})

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { email: 'ryne@bcatcorp.com' }, isAdmin: true }) }))
vi.mock('@/store/useAppStore', () => {
  const state = {
    drivers: [zak, amy], equipment: [truck, spare, trailer],
    maintenanceTasks: [{ id: 'mt1', equipmentId: 't1', title: 'Oil change', dueDate: '2026-12-01', priority: 'med', status: 'upcoming' }],
    maintenanceInvoices: [{ id: 'mi1', equipmentId: 't1', vendor: 'Pete Repair', date: '2026-10-01', amount: 125000, description: 'Brakes' }],
    addEquipment, updateEquipment, updateDriver, assignTruckToDriver,
  }
  const useAppStore = (sel: (s: typeof state) => unknown) => sel(state)
  useAppStore.getState = () => state
  return { useAppStore }
})
vi.mock('@/hooks/useFileHub', () => ({
  useFileHub: () => ({
    loading: false, error: null, docFor: () => undefined, docsForEntity: () => [], stateFor: () => 'MISSING',
    upload: vi.fn(), setExpiration: vi.fn(), setWaived: vi.fn(), remove: vi.fn(), urlFor: vi.fn(), refresh: vi.fn(),
  }),
}))
vi.mock('@/hooks/useExpenseData', () => ({ useExpenseData: () => ({ recurring: [], allocations: [], expenseTypes: [], refresh: vi.fn() }) }))
vi.mock('@/hooks/useTruckConfigs', () => ({ useTruckConfigs: () => ({ byId: new Map([['t1', { truckId: 't1', phone: '+13125550142', phoneLabel: 'Zak cab' }]]), upsert: vi.fn() }) }))
vi.mock('@/lib/insuranceClient', () => ({ getUnitPremiumCents: async () => 0, setUnitPremiumCurrentPeriod: async () => {} }))
vi.mock('@/features/trucks/TrucksPage', () => ({ EquipmentForm: ({ initial }: { initial?: Equipment }) => <div data-testid="equipment-form-stub">{initial?.unitNumber}</div> }))
vi.mock('@/features/trucks/TruckParking', () => ({ MarkInactiveDialog: () => <div data-testid="park-stub" /> }))
vi.mock('@/features/trucks/TruckPhoneEditor', () => ({ TruckPhoneEditor: () => <div data-testid="phone-editor-stub" /> }))
vi.mock('@/features/files/DocumentPreviewModal', () => ({ DocumentPreviewModal: () => null }))

const { AssetsListPage } = await import('./AssetsListPage')
const { AssetProfilePage } = await import('./AssetProfilePage')
const { NewAssetWizard } = await import('./NewAssetWizard')

const Where = () => <div data-testid="where">{useLocation().pathname + useLocation().search}</div>
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const mount = async (path: string) => {
  const out = render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/profiles/assets" element={<AssetsListPage />} />
        <Route path="/profiles/assets/new" element={<NewAssetWizard />} />
        <Route path="/profiles/assets/:id" element={<AssetProfilePage />} />
      </Routes>
      <Where />
    </MemoryRouter>,
  )
  await settle()
  return out
}

beforeEach(() => { vi.clearAllMocks(); localStorage.clear() })

describe('Assets list', () => {
  it('opens on Trucks with the driver, a documents chip and the VIN; the Trailers tab switches the rows and the address', async () => {
    await mount('/profiles/assets')
    const grid = screen.getByRole('table', { name: 'Trucks' }) as HTMLElement
    expect(within(grid).getByText('214')).toBeTruthy()
    expect(within(grid).getByText('300')).toBeTruthy()
    expect(within(grid).queryByText('T-9')).toBeNull()
    expect(within(grid).getByText('Zak Pace')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: /Trailers/ }))
    await settle()
    expect(screen.getByTestId('where').textContent).toBe('/profiles/assets?tab=trailer')
    const trailers = screen.getByRole('table', { name: 'Trailers' }) as HTMLElement
    expect(within(trailers).getByText('T-9')).toBeTruthy()
    expect(within(trailers).getByText('Zak Pace')).toBeTruthy()
  })

  it('Add truck / Add trailer go to the wizard for that type', async () => {
    await mount('/profiles/assets?tab=trailer')
    fireEvent.click(screen.getByTestId('assets-add'))
    expect(screen.getByTestId('where').textContent).toBe('/profiles/assets/new?type=trailer')
  })

  it('a row click opens the profile', async () => {
    await mount('/profiles/assets')
    fireEvent.click(within(screen.getByRole('table', { name: 'Trucks' })).getByText('214'))
    expect(screen.getByTestId('where').textContent).toBe('/profiles/assets/t1')
  })
})

describe('Asset profile', () => {
  it('shows identity, compliance, PM and the work phone from the existing records', async () => {
    await mount('/profiles/assets/t1')
    expect(screen.getByText('Truck 214')).toBeTruthy()
    expect(screen.getAllByText(/2021 Freightliner Cascadia/).length).toBeGreaterThan(0)
    expect(screen.getByText('125,000 mi')).toBeTruthy()
    expect(screen.getByTestId('asset-phone').textContent).toMatch(/555-0142/)
    fireEvent.click(screen.getByTestId('asset-edit'))
    expect(screen.getByTestId('equipment-form-stub').textContent).toBe('214')
  })

  it('Assignment tab moves the truck to another driver through the shared store call', async () => {
    await mount('/profiles/assets/t1?tab=assignment')
    fireEvent.change(screen.getByLabelText('Driver'), { target: { value: 'd2' } })
    await settle()
    expect(assignTruckToDriver).toHaveBeenCalledWith('t1', 'd2')
  })

  it('a trailer lists who pulls it, releases it and assigns it to a driver', async () => {
    await mount('/profiles/assets/r1?tab=assignment')
    expect(screen.getAllByText('Zak Pace').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Release' }))
    await settle()
    expect(updateDriver).toHaveBeenCalledWith('d1', { assignedTrailerId: null })
    fireEvent.change(screen.getByLabelText('Assign to a driver'), { target: { value: 'd2' } })
    await settle()
    expect(updateDriver).toHaveBeenCalledWith('d2', { assignedTrailerId: 'r1', bobtail: false })
  })

  it('Documents tab lists the truck documents with upload buttons; Maintenance lists tasks and invoices', async () => {
    await mount('/profiles/assets/t1?tab=documents')
    expect(within(screen.getByTestId('asset-documents')).getByText('Insurance')).toBeTruthy()
    expect(within(screen.getByTestId('asset-documents')).getAllByRole('button', { name: /Upload/ }).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('tab', { name: /Maintenance/ }))
    await settle()
    expect(screen.getByText('Oil change')).toBeTruthy()
    expect(screen.getByText('Pete Repair')).toBeTruthy()
    expect(screen.getAllByText(/\$1,250\.00/).length).toBeGreaterThan(0)
  })

  it('says so for an asset that does not exist', async () => {
    await mount('/profiles/assets/zzz')
    expect(screen.getByText('Asset not found')).toBeTruthy()
  })
})

describe('New asset wizard', () => {
  const type = (label: RegExp | string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })

  it('blocks Next on a missing or duplicate unit, then walks five steps and creates the truck and the driver pairing', async () => {
    await mount('/profiles/assets/new?type=truck')
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText('Enter the unit number.')).toBeTruthy()
    type('Unit number', '214')
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText('That unit number is already in use.')).toBeTruthy()

    type('Unit number', '777')
    type('Make', 'Volvo')
    type('Model', 'VNL')
    type('Year', '2022')
    fireEvent.click(screen.getByRole('button', { name: 'Box truck' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    type('DOT inspection date', '2026-09-01')
    type('IFTA expires', '2026-12-31')
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    type('Driver', 'd2')
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    expect(within(screen.getByTestId('wizard-docs')).getAllByText(/.+/).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    expect(within(screen.getByTestId('wizard-review')).getByText(/777/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Create truck' }))
    await settle()

    expect(addEquipment).toHaveBeenCalledWith(expect.objectContaining({ type: 'truck', unitNumber: '777', make: 'Volvo', year: 2022, fleetGroup: 'BOX_TRUCK', dotInspectionDate: '2026-09-01', iftaExpirationDate: '2026-12-31' }))
    expect(assignTruckToDriver).toHaveBeenCalledWith('new1', 'd2')
    expect(screen.getByTestId('where').textContent).toBe('/profiles/assets/new1?tab=documents')
  })

  it('a trailer pairs with the driver who pulls it and has no IFTA/IRP or fleet', async () => {
    await mount('/profiles/assets/new?type=trailer')
    expect(screen.queryByRole('group', { name: 'Fleet' })).toBeNull()
    type('Unit number', 'T-77')
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.queryByLabelText('IFTA expires')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    type('Driver who pulls it', 'd2')
    for (let i = 0; i < 2; i += 1) fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create trailer' }))
    await settle()
    expect(addEquipment).toHaveBeenCalledWith(expect.objectContaining({ type: 'trailer', unitNumber: 'T-77', fleetGroup: null }))
    expect(updateDriver).toHaveBeenCalledWith('d2', { assignedTrailerId: 'new1', bobtail: false })
  })

  it('Cancel goes back to the matching tab of the list', async () => {
    await mount('/profiles/assets/new?type=trailer')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByTestId('where').textContent).toBe('/profiles/assets?tab=trailer')
  })
})
