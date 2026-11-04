// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { CustomerRecord, LocationRecord, Division, TmsSettings, UserProfileRecord } from '@/types/tms'
import { MemoryRouter, useLocation } from 'react-router-dom'
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

const authState: { isAdmin: boolean; user: { email: string; groups?: string[] }; isOwner: boolean } = { isAdmin: true, user: { email: 'admin@bcatcorp.com' }, isOwner: false }
const crmRows = vi.hoisted(() => ({ value: [] as unknown[] }))
const crmAction = vi.hoisted(() => vi.fn())

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
  crmAction,
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

function SearchProbe() {
  return <span data-testid="search">{useLocation().search}</span>
}

function renderCustomers(url = '/tms/customers') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <CustomersPage />
      <SearchProbe />
    </MemoryRouter>,
  )
}

const PAST = '2020-01-01T12:00:00.000Z'

describe('DirectoryPages', () => {
  beforeEach(() => {
    authState.isAdmin = true
    authState.user = { email: 'admin@bcatcorp.com' }
    crmRows.value = []
    crmAction.mockReset()
    crmAction.mockImplementation(async (action: string, input: { scope?: string }) => {
      if (action === 'CRM_LIST_ACCOUNTS') {
        const all = crmRows.value as Array<{ customerId: string; mine?: boolean }>
        return { rows: input.scope === 'mine' ? all.filter((r) => r.mine !== false) : all }
      }
      return {}
    })
  })

  describe('CRM columns and scope (§5.6, §7.4)', () => {
    const rowFor = (customerId: string, extra: Record<string, unknown> = {}) => ({
      customerId, ownerId: 'dana@bcatcorp.com', stage: 'ACTIVE', lastTouchAt: PAST, lastTouchKind: 'CALL',
      nextStep: null, nextStepDueAt: null, openTaskCount: 0, ...extra,
    })

    it('shows owner, last touch and an overdue next step on the row', async () => {
      crmRows.value = [rowFor('c-active', { nextStep: 'Send rate sheet', nextStepDueAt: PAST })]
      renderCustomers()
      await waitFor(() => expect(screen.getByTestId('crm-next-step-c-active')).toBeTruthy())
      const next = screen.getByTestId('crm-next-step-c-active')
      expect(next.textContent).toContain('Send rate sheet')
      expect(next.getAttribute('data-overdue')).toBe('true')
      expect(screen.getByTestId('crm-last-touch-c-active').textContent).toContain('Call')
      expect(screen.getByText('Dana Carr')).toBeTruthy()
    })

    it('a rep sees only the accounts the server returns and gets no Mine/All switch', async () => {
      authState.isAdmin = false
      authState.user = { email: 'rep@bcatcorp.com', groups: ['role-CUSTOMER_REP'] }
      crmRows.value = [rowFor('c-active')]
      renderCustomers()
      await waitFor(() => expect(screen.getByText('Active Co')).toBeTruthy())
      await waitFor(() => expect(screen.queryByText('Pending Co')).toBeNull())
      expect(screen.queryByTestId('crm-scope')).toBeNull()
      expect(crmAction).toHaveBeenCalledWith('CRM_LIST_ACCOUNTS', { scope: 'mine' })
      expect(crmAction).not.toHaveBeenCalledWith('CRM_LIST_ACCOUNTS', { scope: 'all' })
    })

    it('a manager starts on All and Mine narrows the list to owned accounts', async () => {
      authState.isAdmin = false
      authState.user = { email: 'boss@bcatcorp.com', groups: ['role-MANAGER'] }
      crmRows.value = [rowFor('c-active'), rowFor('c-pending', { mine: false })]
      renderCustomers()
      await waitFor(() => expect(screen.getByText('Pending Co')).toBeTruthy())
      expect(screen.getByText('Active Co')).toBeTruthy()
      fireEvent.click(screen.getByTestId('crm-scope-mine'))
      await waitFor(() => expect(screen.queryByText('Pending Co')).toBeNull())
      expect(screen.getByText('Active Co')).toBeTruthy()
    })

    it('Add note posts a NOTE for that customer', async () => {
      renderCustomers()
      await waitFor(() => expect(screen.getByText('Active Co')).toBeTruthy())
      fireEvent.click(screen.getByLabelText('Add note to Active Co'))
      fireEvent.change(await screen.findByTestId('crm-note-text'), { target: { value: 'Met at the expo' } })
      fireEvent.click(screen.getByTestId('crm-note-save'))
      await waitFor(() => expect(crmAction).toHaveBeenCalledWith('CRM_ADD_ACTIVITY', { customerId: 'c-active', kind: 'NOTE', summary: 'Met at the expo' }))
    })
  })

  it('renders the customer board with tab counts', async () => {
    renderCustomers()
    await waitFor(() => expect(screen.getByText('Active Co')).toBeTruthy())
    expect(screen.getByText('Pending Co')).toBeTruthy()
    expect(screen.getByText('Legacy Active')).toBeTruthy()

    fireEvent.click(screen.getByText('Prospects'))
    await waitFor(() => expect(screen.getByText('Lead Co')).toBeTruthy())

    fireEvent.click(screen.getByText('Inactive'))
    await waitFor(() => {
      expect(screen.getByText('Blocked Co')).toBeTruthy()
      expect(screen.getByText('Legacy Archived')).toBeTruthy()
    })
  })

  it('filters rows by board tab', async () => {
    renderCustomers()
    await waitFor(() => expect(screen.getByText('Active Co')).toBeTruthy())
    expect(screen.queryByText('Lead Co')).toBeNull()

    fireEvent.click(screen.getByText('Prospects'))
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
    renderCustomers()
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
    crmRows.value = [{ customerId: 'c-legacy-true' }]
    renderCustomers()
    await waitFor(() => expect(screen.getByText('Legacy Active')).toBeTruthy())
    fireEvent.click(screen.getByText('Legacy Active'))
    await waitFor(() => expect(screen.getByText('Credit')).toBeTruthy())

    const creditInput = screen.getByLabelText('Credit limit ($)')
    expect((creditInput as HTMLInputElement).disabled).toBe(true)
    authState.isAdmin = true
  })

  it('CreditLimitCard shows org default when customer credit limit is null', async () => {
    renderCustomers()
    await waitFor(() => expect(screen.getByText('Legacy Active')).toBeTruthy())
    fireEvent.click(screen.getByText('Legacy Active'))
    await waitFor(() => expect(screen.getByText('Credit')).toBeTruthy())
    expect(screen.getAllByText('(org default)').length).toBeGreaterThanOrEqual(1)
  })

  it('pending customer shows Approve action', async () => {
    renderCustomers()
    await waitFor(() => expect(screen.getByText('Pending Co')).toBeTruthy())
    fireEvent.click(screen.getByText('Pending Co'))
    await waitFor(() => expect(screen.getByText('Approve')).toBeTruthy())
  })

  it('keeps a free-text rep and owner exactly as the record holds them', async () => {
    renderCustomers()
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
    renderCustomers()
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

  describe('?customer=<id> deep link', () => {
    it('opens that customer\'s profile, even from a board tab that does not list it', async () => {
      renderCustomers('/tms/customers?customer=c-lead')
      expect((await screen.findAllByText('Lead Co')).length).toBeGreaterThan(0) // not in the Active tab's rows, so it is the profile
      expect(screen.getByTestId('search').textContent).toBe('?customer=c-lead')
    })

    it('writes the param when a row is opened, so the profile is linkable', async () => {
      renderCustomers()
      fireEvent.click(await screen.findByText('Active Co'))
      await waitFor(() => expect(screen.getByTestId('search').textContent).toBe('?customer=c-active'))
      expect(await screen.findByText('Deactivate')).toBeTruthy()
    })

    it('drops a param that names no customer instead of leaving it behind', async () => {
      renderCustomers('/tms/customers?customer=nope&keep=1')
      await waitFor(() => expect(screen.getByTestId('search').textContent).toBe('?keep=1'))
      expect(screen.queryByText('Deactivate')).toBeNull()
    })
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
