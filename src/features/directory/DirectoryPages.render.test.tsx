// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { CustomerRecord, LocationRecord, Division, TmsSettings, UserProfileRecord } from '@/types/tms'
import { CustomersPage, LocationsPage } from './DirectoryPages'
import { CustomerForm } from './components/CustomerForm'
import { useCustomerForm } from './components/useCustomerForm'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})

const authState = { isAdmin: true, user: { email: 'admin@bcatcorp.com' }, isOwner: false }

const setCustomerStatus = vi.fn(async (current: CustomerRecord) => current)
const saveCustomer = vi.fn(async (_current: CustomerRecord, patch: Partial<CustomerRecord>) => patch as CustomerRecord)

// The settings tab's rep and team fields are pickers now: one reads the staff
// directory, the other the teams on the org settings.
const staff = vi.hoisted(() => [
  {
    id: 'dana@bcatcorp.com', email: 'dana@bcatcorp.com', name: 'Dana Carr', role: 'CUSTOMER_REP',
    createdBy: 'a@b.c', updatedBy: 'a@b.c', version: 1,
  },
] as UserProfileRecord[])

const settings: TmsSettings = {
  id: 'default',
  defaultCreditLimitCents: 100000,
  defaultCreditUsageWarningBps: 8000,
  defaultFreeCreditRequired: false,
  defaultMaxDaysLate: 60,
  teams: [{ key: 'DESK_1', name: 'Desk One', memberIds: [] }],
}

const customers: CustomerRecord[] = [
  {
    id: 'c-lead', name: 'Lead Co', status: 'NEW', active: true,
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
  } as CustomerRecord,
  {
    id: 'c-active', name: 'Active Co', status: 'ACTIVE', active: true,
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
  } as CustomerRecord,
  {
    id: 'c-pending', name: 'Pending Co', status: 'PENDING', active: true,
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
  } as CustomerRecord,
  {
    id: 'c-blocked', name: 'Blocked Co', status: 'BLOCKED', active: false,
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
  } as CustomerRecord,
  {
    id: 'c-legacy-false', name: 'Legacy Archived', status: null, active: false,
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
  } as CustomerRecord,
  // Free text typed before there were profiles: the pickers must print it, flag it and
  // hand it back to the server unchanged.
  {
    id: 'c-legacy-true', name: 'Legacy Active', status: null, active: true,
    operatedById: 'legacy.rep@nowhere.test', accountOwnerIds: ['legacy.owner@nowhere.test'],
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
  } as CustomerRecord,
]

const locations: LocationRecord[] = []

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => authState }))
vi.mock('@/hooks/useDirectory', () => ({
  useDirectory: () => ({
    customers,
    locations,
    loading: false,
    error: null,
    refresh: vi.fn(),
    addCustomer: vi.fn(),
    saveCustomer,
    archiveCustomer: vi.fn(),
    setCustomerStatus,
    addLocation: vi.fn(),
    saveLocation: vi.fn(),
    archiveLocation: vi.fn(),
  }),
}))
vi.mock('@/hooks/useCustomerOrders', () => ({
  useCustomerOrders: () => ({
    orders: [], shipments: [], loads: [], legacyLoads: [], lastLoadAt: null,
    loading: false, error: null, refetch: vi.fn(),
  }),
}))
vi.mock('@/hooks/useCustomerAr', () => ({
  useCustomerAr: () => ({
    invoices: [], payments: [], openCents: 0, unappliedCents: 0,
    loading: false, error: null, refresh: vi.fn(async () => {}),
  }),
}))
vi.mock('@/lib/apiClient', () => ({
  listUserProfiles: vi.fn(async () => staff),
  listDivisions: vi.fn(async () => [{ id: 'd1', key: 'BCAT_LOGISTICS', name: 'BCAT Logistics', active: true, createdAt: '', updatedAt: '' } satisfies Division]),
  getTmsSettings: vi.fn(async () => settings),
  saveTmsSettings: vi.fn(async (patch: Partial<TmsSettings>) => ({ ...settings, ...patch }) as TmsSettings),
  previewLocationMerge: vi.fn(async () => ({ sourceId: 'l1', targetId: 'l1', loadCount: 0 })),
  startLocationMerge: vi.fn(async () => ({ id: 'j1', sourceId: 'l1', targetId: 'l1', status: 'PENDING', processedCount: 0 })),
  resumeLocationMerge: vi.fn(async () => ({ id: 'j1', sourceId: 'l1', targetId: 'l1', status: 'RUNNING', processedCount: 1 })),
  listLocationMergeJobs: vi.fn(async () => []),
  geocodeAddress: vi.fn(),
  autocompleteAddress: vi.fn(async () => []),
  getPlaceDetails: vi.fn(),
  graphqlErrorText: (e: unknown) => (e instanceof Error ? e.message : ''),
}))

describe('DirectoryPages', () => {
  it('renders the customer board with tab counts', async () => {
    render(<CustomersPage />)
    await waitFor(() => expect(screen.getByText('Active Co')).toBeTruthy())
    expect(screen.getByText('Pending Co')).toBeTruthy()
    expect(screen.getByText('Legacy Active')).toBeTruthy()

    fireEvent.click(screen.getByText('Leads'))
    await waitFor(() => expect(screen.getByText('Lead Co')).toBeTruthy())

    fireEvent.click(screen.getByText('Inactive'))
    await waitFor(() => {
      expect(screen.getByText('Blocked Co')).toBeTruthy()
      expect(screen.getByText('Legacy Archived')).toBeTruthy()
    })
  })

  it('filters rows by board tab', async () => {
    render(<CustomersPage />)
    await waitFor(() => expect(screen.getByText('Active Co')).toBeTruthy())
    expect(screen.queryByText('Lead Co')).toBeNull()

    fireEvent.click(screen.getByText('Leads'))
    await waitFor(() => expect(screen.getByText('Lead Co')).toBeTruthy())
    expect(screen.queryByText('Active Co')).toBeNull()

    fireEvent.click(screen.getByText('Inactive'))
    await waitFor(() => {
      expect(screen.getByText('Blocked Co')).toBeTruthy()
      expect(screen.getByText('Legacy Archived')).toBeTruthy()
    })
  })

  it('renders the location list', () => {
    render(<LocationsPage />)
    expect(screen.getByText('Locations')).toBeTruthy()
  })

  it('opens customer profile and deactivating requires a reason', async () => {
    render(<CustomersPage />)
    await waitFor(() => expect(screen.getByText('Active Co')).toBeTruthy())
    fireEvent.click(screen.getByText('Active Co'))
    await waitFor(() => expect(screen.getByText('Deactivate')).toBeTruthy())
    fireEvent.click(screen.getByText('Deactivate'))
    await waitFor(() => expect(screen.getByText('Deactivate customer')).toBeTruthy())

    const confirm = screen.getByRole('button', { name: 'Deactivate' })
    expect((confirm as HTMLButtonElement).disabled).toBe(true)

    const reasonInput = screen.getByLabelText('Reason *')
    fireEvent.change(reasonInput, { target: { value: 'Non-payment' } })
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false))

    fireEvent.click(confirm)
    await waitFor(() => expect(setCustomerStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c-active' }),
      expect.objectContaining({ status: 'BLOCKED', reason: 'Non-payment' })
    ))
  })

  it('credit inputs are disabled for non-admin', async () => {
    authState.isAdmin = false
    render(<CustomersPage />)
    await waitFor(() => expect(screen.getByText('Legacy Active')).toBeTruthy())
    fireEvent.click(screen.getByText('Legacy Active'))
    await waitFor(() => expect(screen.getByText('Credit')).toBeTruthy())

    const creditInput = screen.getByLabelText('Credit limit ($)')
    expect((creditInput as HTMLInputElement).disabled).toBe(true)
    authState.isAdmin = true
  })

  it('CreditLimitCard shows org default when customer credit limit is null', async () => {
    render(<CustomersPage />)
    await waitFor(() => expect(screen.getByText('Legacy Active')).toBeTruthy())
    fireEvent.click(screen.getByText('Legacy Active'))
    await waitFor(() => expect(screen.getByText('Credit')).toBeTruthy())
    expect(screen.getAllByText('(org default)').length).toBeGreaterThanOrEqual(1)
  })

  it('pending customer shows Approve action', async () => {
    render(<CustomersPage />)
    await waitFor(() => expect(screen.getByText('Pending Co')).toBeTruthy())
    fireEvent.click(screen.getByText('Pending Co'))
    await waitFor(() => expect(screen.getByText('Approve')).toBeTruthy())
  })

  it('keeps a free-text rep and owner exactly as the record holds them', async () => {
    render(<CustomersPage />)
    await waitFor(() => expect(screen.getByText('Legacy Active')).toBeTruthy())
    fireEvent.click(screen.getByText('Legacy Active'))
    fireEvent.click(await screen.findByText('Settings'))

    expect(await screen.findByText('legacy.rep@nowhere.test')).toBeTruthy()
    expect(screen.getByText('legacy.owner@nowhere.test')).toBeTruthy()
    expect(screen.getAllByText('not a user')).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(saveCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c-legacy-true' }),
      expect.objectContaining({
        operatedById: 'legacy.rep@nowhere.test',
        accountOwnerIds: ['legacy.owner@nowhere.test'],
      }),
    ))
  })

  it('saves the username of a rep picked from the directory', async () => {
    render(<CustomersPage />)
    await waitFor(() => expect(screen.getByText('Legacy Active')).toBeTruthy())
    fireEvent.click(screen.getByText('Legacy Active'))
    fireEvent.click(await screen.findByText('Settings'))

    fireEvent.click(await screen.findByText('legacy.rep@nowhere.test'))
    fireEvent.click(await screen.findByRole('option', { name: /Dana Carr/ }))

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(saveCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c-legacy-true' }),
      expect.objectContaining({ operatedById: 'dana@bcatcorp.com' }),
    ))
  })
})

/** The add/edit dialog's form, driven the way the dialog drives it. */
function CustomerFormHarness({ initial, onSave }: { initial: CustomerRecord; onSave: (record: CustomerRecord) => void }) {
  const { value, set, toRecord, errors } = useCustomerForm(initial)
  return (
    <>
      <CustomerForm value={value} set={set} errors={errors} divisions={[]} />
      <button type="button" onClick={() => onSave(toRecord())}>Save form</button>
    </>
  )
}

describe('CustomerForm', () => {
  const legacy = {
    id: 'c-form', name: 'Form Co', status: 'ACTIVE', active: true, teamKey: 'DESK_1',
    operatedById: 'legacy.rep@nowhere.test', accountOwnerIds: ['legacy.owner@nowhere.test'],
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
  } as CustomerRecord

  it('hands back the free-text rep and owner it was given', async () => {
    const onSave = vi.fn()
    render(<CustomerFormHarness initial={legacy} onSave={onSave} />)
    fireEvent.click(screen.getByText('Settings'))

    expect(await screen.findByText('legacy.rep@nowhere.test')).toBeTruthy()
    expect(screen.getAllByText('not a user')).toHaveLength(2)
    // The key on the record, printed as the team's name off the org settings.
    expect(screen.getByText('Desk One')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Save form' }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      operatedById: 'legacy.rep@nowhere.test',
      accountOwnerIds: ['legacy.owner@nowhere.test'],
      teamKey: 'DESK_1',
    }))
  })

  it('adds a picked account owner to the saved record', async () => {
    const onSave = vi.fn()
    render(<CustomerFormHarness initial={legacy} onSave={onSave} />)
    fireEvent.click(screen.getByText('Settings'))

    fireEvent.click(await screen.findByText('Add an account owner…'))
    fireEvent.click(await screen.findByRole('option', { name: /Dana Carr/ }))

    fireEvent.click(screen.getByRole('button', { name: 'Save form' }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      accountOwnerIds: ['legacy.owner@nowhere.test', 'dana@bcatcorp.com'],
    }))
  })
})
