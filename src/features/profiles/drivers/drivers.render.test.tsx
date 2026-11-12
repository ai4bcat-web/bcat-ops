// @vitest-environment jsdom
/**
 * Driver profiles: the list, the profile page and the new-driver wizard render and behave.
 * The store, the Files hub, the pay-setting hook and the heavy editors are stubbed at their edges;
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
  id: 'd1', name: 'Zak Pace', phone: '(847) 293-6704', active: true, type: 'driver', email: 'zak@bcatcorp.com',
  fleetGroup: 'BOX_TRUCK', assignedTruckId: 't1', dispatcherPrimary: 'jason@bcatcorp.com', createdAt: '', updatedAt: '',
}
const amy: Driver = { id: 'd2', name: 'Amy Local', phone: '(312) 555-0111', active: false, type: 'driver', fleetGroup: 'LOCAL', createdAt: '', updatedAt: '' }
const lee: Driver = { id: 'd3', name: 'Lee Local', phone: '(312) 555-0122', active: true, type: 'driver', fleetGroup: 'LOCAL', createdAt: '', updatedAt: '' }
const truck: Equipment = {
  id: 't1', type: 'truck', unitNumber: '214', make: 'Freightliner', model: 'Cascadia', ownership: 'owned', insured: true,
  active: true, onTollwayAccount: false, createdAt: '', updatedAt: '',
} as Equipment
const spare: Equipment = { ...truck, id: 't2', unitNumber: '300' }

const addDriver = vi.fn(async (d: Partial<Driver>) => ({ ...zak, ...d, id: 'new1' }))
const assignTruckToDriver = vi.fn(async () => {})
const updateDriver = vi.fn(async () => {})
const createDriverPaySetting = vi.fn(async () => ({}))

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { email: 'ryne@bcatcorp.com' }, isAdmin: true }) }))
vi.mock('@/store/useAppStore', () => {
  const state = {
    drivers: [zak, amy, lee], equipment: [truck, spare], loads: [{ id: 'l1', aljexId: '10793', customer: 'Acme', pickupDriverId: 'd1', deliveryDriverId: 'd1', originCity: 'Chicago, IL', destinationCity: 'Gary, IN', deliveryAppt: '2026-11-10T15:00:00Z' }],
    addDriver, updateDriver, assignTruckToDriver,
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
vi.mock('./useDriverPaySettings', () => ({
  useDriverPaySettings: () => ({
    settings: [], loading: false, error: null, refresh: vi.fn(), save: vi.fn(),
    byDriver: new Map([['d1', { id: 's1', driverId: 'd1', payGroup: 'BOX_TRUCK', payPercent: 0.5, expensesBeforePercent: true, fuelCardNumber: '00049', email: 'zak@bcatcorp.com', fixedExpenses: [], createdAt: '', updatedAt: '' }]]),
  }),
}))
vi.mock('@/lib/apiClient', () => ({ driverTrailerFieldDeployed: () => true, createDriverPaySetting: (...a: unknown[]) => createDriverPaySetting(...(a as [])) }))
vi.mock('@/features/drivers/DriverDrawer', () => ({ DriverDrawer: () => <div data-testid="drawer-stub" /> }))
vi.mock('@/features/driver-pay/DriverPayForms', () => ({ SettingsModal: () => <div data-testid="amazon-pay-stub" /> }))
vi.mock('@/features/driver-pay-box-trucks/BoxTruckPayForms', () => ({ SettingsModal: () => <div data-testid="box-pay-stub" /> }))
vi.mock('@/features/owner-operator-pay/OwnerOperatorPayForms', () => ({ SettingsModal: () => <div data-testid="oo-pay-stub" /> }))
vi.mock('@/features/files/DocumentPreviewModal', () => ({ DocumentPreviewModal: () => null }))

const { DriversListPage } = await import('./DriversListPage')
const { DriverProfilePage } = await import('./DriverProfilePage')
const { NewDriverWizard } = await import('./NewDriverWizard')

const Where = () => <div data-testid="where">{useLocation().pathname + useLocation().search}</div>
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const mount = async (path: string) => {
  const out = render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/profiles/drivers" element={<DriversListPage />} />
        <Route path="/profiles/drivers/new" element={<NewDriverWizard />} />
        <Route path="/profiles/drivers/:id" element={<DriverProfilePage />} />
      </Routes>
      <Where />
    </MemoryRouter>,
  )
  await settle()
  return out
}

const type = (label: RegExp | string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })

beforeEach(() => { vi.clearAllMocks(); localStorage.clear() })

describe('Drivers list', () => {
  it('lists active drivers with type, truck, dispatcher and a documents chip; Inactive and All switch the rows', async () => {
    await mount('/profiles/drivers')
    const grid = screen.getByRole('table', { name: 'Drivers' })
    expect(within(grid).getByText('Zak Pace')).toBeTruthy()
    expect(within(grid).getByText('Box truck')).toBeTruthy()
    expect(within(grid).getByText('Truck 214')).toBeTruthy()
    expect(within(grid).getByText('jason@bcatcorp.com')).toBeTruthy()
    expect(within(grid).getAllByText(/^Missing \d+$/).length).toBeGreaterThan(0)
    expect(within(grid).queryByText('Amy Local')).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: /Inactive/ }))
    expect(within(screen.getByRole('table', { name: 'Drivers' })).getByText('Amy Local')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: /All/ }))
    expect(within(screen.getByRole('table', { name: 'Drivers' })).getByText('Zak Pace')).toBeTruthy()
  })

  it('searches by name and opens the profile on a row click; Add driver opens the wizard', async () => {
    await mount('/profiles/drivers')
    fireEvent.change(screen.getByTestId('ap-search'), { target: { value: 'nobody' } })
    expect(screen.queryByText('Zak Pace')).toBeNull()
    fireEvent.change(screen.getByTestId('ap-search'), { target: { value: 'zak' } })
    fireEvent.click(screen.getByText('Zak Pace'))
    expect(screen.getByTestId('where').textContent).toBe('/profiles/drivers/d1')
  })

  it('Add driver goes to the wizard', async () => {
    await mount('/profiles/drivers')
    fireEvent.click(screen.getByTestId('drivers-add'))
    expect(screen.getByTestId('where').textContent).toBe('/profiles/drivers/new')
  })
})

describe('Hire date (needed for PTO)', () => {
  it('the list flags Ivan drivers with no hire date: a Needs hire date tab with the count, and a badge in the Hired column', async () => {
    await mount('/profiles/drivers')
    const tab = screen.getByRole('tab', { name: /Needs hire date/ })
    expect(tab.textContent).toMatch(/1/)
    fireEvent.click(tab)
    const grid = screen.getByRole('table', { name: 'Drivers' })
    expect(within(grid).getByText('Lee Local')).toBeTruthy()
    expect(within(grid).queryByText('Zak Pace')).toBeNull()
    expect(within(grid).getByText('Needs hire date')).toBeTruthy()
  })

  it('the profile warns that PTO needs a hire date and the button opens the editor; a contractor gets no warning', async () => {
    await mount('/profiles/drivers/d3')
    expect(screen.getByText('Hire date needed for PTO')).toBeTruthy()
    fireEvent.click(screen.getByTestId('driver-add-hire-date'))
    expect(screen.getByTestId('drawer-stub')).toBeTruthy()
  })

  it('a contractor with no hire date is not flagged', async () => {
    await mount('/profiles/drivers/d1')
    expect(screen.queryByText('Hire date needed for PTO')).toBeNull()
  })

  it('the wizard requires the hire date for a Local (employee) driver, not for a contractor', async () => {
    await mount('/profiles/drivers/new')
    type('Full name', 'Hourly Hank')
    type('Phone', '3125550101')
    fireEvent.click(screen.getByRole('button', { name: 'Local driver' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText(/Enter the hire date \(first day of work\)/)).toBeTruthy()
  })
})

describe('Driver profile', () => {
  it('shows the header and the overview facts from the existing records', async () => {
    await mount('/profiles/drivers/d1')
    expect(screen.getByRole('heading', { name: 'Zak Pace' })).toBeTruthy()
    expect(screen.getAllByText('jason@bcatcorp.com').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByTestId('driver-edit'))
    expect(screen.getByTestId('drawer-stub')).toBeTruthy()
  })

  it('Pay tab reads the stored DriverPaySetting and opens the box-truck settings editor', async () => {
    await mount('/profiles/drivers/d1?tab=pay')
    expect(screen.getByText('50%')).toBeTruthy()
    expect(screen.getByText('% of net, after expenses')).toBeTruthy()
    expect(screen.getByText('00049')).toBeTruthy()
    fireEvent.click(screen.getByTestId('pay-edit'))
    expect(screen.getByTestId('box-pay-stub')).toBeTruthy()
  })

  it('Documents tab lists the required documents for the type with upload buttons', async () => {
    await mount('/profiles/drivers/d1?tab=documents')
    const docs = screen.getByTestId('pf-documents')
    expect(within(docs).getAllByRole('button', { name: /Upload/ }).length).toBeGreaterThan(0)
    expect(within(docs).getAllByText('Missing').length).toBeGreaterThan(0)
  })

  it('Equipment tab changes the truck through the shared assignment path', async () => {
    await mount('/profiles/drivers/d1?tab=equipment')
    fireEvent.change(screen.getByLabelText('Truck'), { target: { value: 't2' } })
    await settle()
    expect(assignTruckToDriver).toHaveBeenCalledWith('t2', 'd1')
  })

  it('a box truck driver has no trailer field at all (box trucks do not pull trailers)', async () => {
    await mount('/profiles/drivers/d1?tab=equipment')
    expect(screen.queryByLabelText('Trailer today')).toBeNull()
    expect(screen.queryByLabelText('Standing trailer')).toBeNull()
  })

  it('a company (Local) driver gets today’s trailer from the pool, not a standing one', async () => {
    await mount('/profiles/drivers/d2?tab=equipment')
    expect(screen.getByLabelText('Trailer today')).toBeTruthy()
    expect(screen.getByText(/take a trailer from the pool each day/)).toBeTruthy()
  })

  it('Activity tab lists recent loads for the driver', async () => {
    await mount('/profiles/drivers/d1?tab=activity')
    expect(screen.getByText(/10793/)).toBeTruthy()
  })

  it('says so for a driver that does not exist', async () => {
    await mount('/profiles/drivers/zzz')
    expect(screen.getByText('Driver not found')).toBeTruthy()
  })
})

describe('New driver wizard', () => {

  it('blocks Next until the basics are valid, then walks the five steps and creates driver, pay and equipment', async () => {
    await mount('/profiles/drivers/new')
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText('Enter the driver’s name.')).toBeTruthy()

    type('Full name', 'New Person')
    type('Phone', '3125550100')
    fireEvent.click(screen.getByRole('button', { name: 'Box truck' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    // Pay: box trucks start at 50%, after expenses
    expect((screen.getByLabelText('Pay percent') as HTMLInputElement).value).toBe('50')
    type('Fuel card # (EFS)', '00123')
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    // Equipment
    type('Truck', 't2')
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    // Documents checklist
    expect(within(screen.getByTestId('wizard-docs')).getAllByText(/.+/).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    // Review
    expect(within(screen.getByTestId('wizard-review')).getByText(/New Person/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Create driver' }))
    await settle()

    expect(addDriver).toHaveBeenCalledWith(expect.objectContaining({ name: 'New Person', phone: '(312) 555-0100', fleetGroup: 'BOX_TRUCK', onboardingStatus: 'NOT_STARTED' }))
    expect(createDriverPaySetting).toHaveBeenCalledWith(expect.objectContaining({ driverId: 'new1', payGroup: 'BOX_TRUCK', payPercent: 0.5, expensesBeforePercent: true, fuelCardNumber: '00123' }))
    expect(assignTruckToDriver).toHaveBeenCalledWith('t2', 'new1')
    expect(screen.getByTestId('where').textContent).toBe('/profiles/drivers/new1?tab=documents')
  })

  it('a local driver has no pay setting to create', async () => {
    await mount('/profiles/drivers/new')
    type('Full name', 'Hourly Hank')
    type('Phone', '3125550101')
    type('Hire date', '2026-11-02')
    fireEvent.click(screen.getByRole('button', { name: 'Local driver' }))
    for (let i = 0; i < 4; i += 1) fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create driver' }))
    await settle()
    expect(addDriver).toHaveBeenCalled()
    expect(createDriverPaySetting).not.toHaveBeenCalled()
  })

  it("collects CDL, med card and hire date on step 1 and saves a local driver's starting hourly rate as the Employee hours page does", async () => {
    await mount('/profiles/drivers/new')
    type('Full name', 'Hourly Hank')
    type('Phone', '3125550101')
    type('CDL number', 'CDL-A IL-1')
    type('CDL expires', '2027-05-01')
    type('Med card expires', '2027-03-01')
    type('Hire date', '2026-11-02')
    expect(screen.queryByRole('button', { name: /Amazon/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Local driver' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    type('Starting hourly rate', '25')
    for (let i = 0; i < 3; i += 1) fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create driver' }))
    await settle()
    expect(addDriver).toHaveBeenCalledWith(expect.objectContaining({ cdl: 'CDL-A IL-1', cdlExpiration: '2027-05-01', medCardExpiration: '2027-03-01', hireDate: '2026-11-02' }))
    expect(createDriverPaySetting).toHaveBeenCalledWith(expect.objectContaining({ driverId: 'new1', payGroup: 'LOCAL', payPercent: 0, hourlyRate: 25 }))
  })

  it('Cancel on the first step goes back to the list', async () => {
    await mount('/profiles/drivers/new')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByTestId('where').textContent).toBe('/profiles/drivers')
  })
})
