// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, cleanup, act } from '@testing-library/react'
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
  {
    id: 'c-zeta', name: 'Zeta Active', status: 'ACTIVE', active: true, factored: true, creditLimitCents: 500000,
    paymentTermsDays: 30, billingEmail: 'ap@zeta.test, ar@zeta.test', teamKey: 'DESK_1',
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
  } as CustomerRecord,
  {
    id: 'c-alpha', name: 'Alpha Active', status: 'ACTIVE', active: true, factored: false, creditLimitCents: 100000,
    paymentTermsDays: 45,
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
    localStorage.clear()
    crmAction.mockReset()
    crmAction.mockImplementation(async (action: string, input: { scope?: string }) => {
      if (action === 'CRM_LIST_ACCOUNTS') {
        const all = crmRows.value as Array<{ customerId: string; mine?: boolean }>
        return { rows: input.scope === 'mine' ? all.filter((r) => r.mine !== false) : all }
      }
      return {}
    })
  })

  it('counts actionable invoice flags separately, includes factored only on request, and shows the detail badge', async () => {
    const previous = customers.map((c) => ({ billingMethod: c.billingMethod, apEmail: c.apEmail }))
    customers.forEach((c) => { c.apEmail = 'ap@example.test' })
    customers[0].apEmail = ' '
    customers[1].apEmail = null
    customers[1].billingMethod = 'FACTOR'
    customers[2].apEmail = 'invalid'
    customers[2].billingMethod = 'MANUAL'
    try {
      renderCustomers()
      fireEvent.click(await screen.findByRole('button', { name: 'Missing invoice e-mail (2)' }))
      expect(screen.getByText('Lead Co')).toBeTruthy()
      expect(screen.getByText('Pending Co')).toBeTruthy()
      expect(screen.queryByText('Active Co')).toBeNull()
      fireEvent.click(screen.getByLabelText('Include factored'))
      expect(screen.getByRole('button', { name: 'Missing invoice e-mail (3)' })).toBeTruthy()
      expect(screen.getByText('Active Co')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Factored, missing invoice e-mail (1)' }))
      expect(screen.queryByText('Lead Co')).toBeNull()
      // A factored customer with no invoice address is flagged like any other.
      expect(within(screen.getByText('Active Co').closest('tr') as HTMLElement).getByText('Missing invoice e-mail — needed for factored billing')).toBeTruthy()
      fireEvent.click(screen.getByText('Active Co'))
      const detail = await screen.findByRole('dialog', { name: 'Customer profile' })
      expect(within(detail).getByText('Missing invoice e-mail — needed for factored billing')).toBeTruthy()
    } finally {
      customers.forEach((c, i) => Object.assign(c, previous[i]))
    }
  })

  it('shows the AP address (+N extras), the NOA e-mail, and shows a factored customer\'s address', async () => {
    const previous = customers.map((c) => ({ billingMethod: c.billingMethod, apEmail: c.apEmail, apEmailsExtra: c.apEmailsExtra, noaEmail: c.noaEmail }))
    customers[1].billingMethod = 'MANUAL'
    customers[1].apEmail = 'ap@active.test'
    customers[1].apEmailsExtra = ['two@active.test', 'three@active.test']
    customers[2].billingMethod = 'FACTOR'
    customers[2].apEmail = 'ap@pending.test'
    customers[2].noaEmail = 'noa@factor.test'
    try {
      renderCustomers()
      const active = (await screen.findByText('Active Co')).closest('tr') as HTMLElement
      expect(within(active).getByTestId('invoice-email-c-active').textContent).toBe('ap@active.test +2')
      const pending = screen.getByText('Pending Co').closest('tr') as HTMLElement
      expect(within(pending).getByTestId('invoice-email-c-pending').textContent).toBe('ap@pending.test')
      expect(pending.textContent).toContain('noa@factor.test')
      expect(screen.getByRole('columnheader', { name: /^NOA e-mail/ })).toBeTruthy()
    } finally {
      customers.forEach((c, i) => Object.assign(c, previous[i]))
    }
  })

  it('Possible duplicates shows only same-name accounts, each set together', async () => {
    const previous = customers.map((c) => ({ name: c.name, aljexCode: c.aljexCode }))
    customers[0].name = 'Zeta Active, Inc.'
    customers[0].aljexCode = 'Z1'
    const zeta = customers.find((c) => c.name === 'Zeta Active')!
    zeta.aljexCode = 'Z2'
    try {
      renderCustomers()
      await screen.findByText('Active Co')
      fireEvent.click(screen.getByTestId('customers-duplicates-chip'))
      await waitFor(() => expect(screen.queryByText('Active Co')).toBeNull())
      expect(screen.getByText('Zeta Active')).toBeTruthy()
      expect(screen.getByText('Zeta Active, Inc.')).toBeTruthy()
      expect(screen.getByTestId('customers-duplicates-chip').textContent).toBe('Possible duplicates (2)')
    } finally {
      customers.forEach((c, i) => Object.assign(c, previous[i]))
    }
  })

  it('flags customers with no billing method as their own badge and filter, apart from the e-mail flag', async () => {
    const previous = customers.map((c) => ({ billingMethod: c.billingMethod, apEmail: c.apEmail }))
    customers.forEach((c) => { c.apEmail = 'ap@example.test'; c.billingMethod = 'MANUAL' })
    customers[0].billingMethod = null
    customers[1].billingMethod = undefined
    customers[2].billingMethod = 'FACTOR'
    try {
      renderCustomers()
      fireEvent.click(await screen.findByRole('button', { name: 'Billing method not set (2)' }))
      expect(screen.getByText('Lead Co')).toBeTruthy()
      expect(screen.getByText('Active Co')).toBeTruthy()
      expect(screen.queryByText('Pending Co')).toBeNull()
      expect(screen.getAllByText('Billing method not set').length).toBe(2)
    } finally {
      customers.forEach((c, i) => Object.assign(c, previous[i]))
    }
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
      expect(crmAction).toHaveBeenCalledWith('CRM_LIST_ACCOUNTS', { scope: 'mine', withActivity: true })
      expect(crmAction).not.toHaveBeenCalledWith('CRM_LIST_ACCOUNTS', expect.objectContaining({ scope: 'all' }))
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

  describe('dense grid', () => {
    const names = () => Array.from(document.querySelectorAll('tbody tr:not(.tms-dg-spacer) td:nth-child(2)')).map((td) => customers.find((c) => within(td as HTMLElement).queryByText(c.name, { exact: true }))?.name)
    const header = (name: string) => screen.getByRole('columnheader', { name: new RegExp(`^${name}`) })

    it('lists every active customer sorted by name, with the Customers columns', async () => {
      renderCustomers()
      await waitFor(() => expect(names()).toEqual(['Active Co', 'Alpha Active', 'Legacy Active', 'Pending Co', 'Zeta Active']))
      for (const h of ['Customer', 'Status', 'Owner', 'Last touch', 'Next step', 'Credit limit', 'Terms', 'Contact', 'City']) {
        expect(header(h)).toBeTruthy()
      }
      // The rest live in the Columns dialog so the default set fits a 1440px window.
      for (const h of ['Team', 'Billing e-mails', 'Factored', 'E-mail', 'State']) {
        expect(screen.queryByRole('columnheader', { name: new RegExp(`^${h}`) })).toBeNull()
      }
      expect(header('Customer').className).toContain('tms-dg-sticky')
      const zeta = screen.getByText('Zeta Active').closest('tr') as HTMLElement
      expect(zeta.textContent).toContain('$5,000')
      expect(zeta.textContent).toContain('Net 30')
    })

    it('a header type-ahead filter narrows the rows', async () => {
      renderCustomers()
      await screen.findByText('Zeta Active')
      fireEvent.click(screen.getByRole('button', { name: 'Filter Customer' }))
      fireEvent.change(screen.getByPlaceholderText('Filter Customer…'), { target: { value: 'zeta' } })
      await waitFor(() => expect(names()).toEqual(['Zeta Active']))
    })

    it('Shipments shows by default (activity query on); Open AR and Last shipment are in the Columns dialog, with values and sort once added', async () => {
      crmRows.value = [{ customerId: 'c-active', shipmentCount: 1234 }, { customerId: 'c-pending', shipmentCount: 7 }]
      renderCustomers()
      await screen.findByText('Zeta Active')
      for (const h of ['Open AR', 'Last shipment']) expect(screen.queryByRole('columnheader', { name: new RegExp(`^${h}`) })).toBeNull()
      expect(header('Shipments')).toBeTruthy()
      await waitFor(() => expect(crmAction).toHaveBeenCalledWith('CRM_LIST_ACCOUNTS', { scope: 'all', withActivity: true }))
      await waitFor(() => expect((screen.getByText('Active Co').closest('tr') as HTMLElement).textContent).toContain('1,234'))
      cleanup()

      localStorage.setItem('tms:grid:customers:admin@bcatcorp.com:v1', JSON.stringify({ columns: ['name', 'openAr', 'lastShipment'] }))
      crmRows.value = [
        { customerId: 'c-active', openArCents: 250_000, lastShipmentAt: '2026-05-09T08:00:00.000Z' },
        { customerId: 'c-pending', openArCents: 4_000, lastShipmentAt: '2026-02-01T08:00:00.000Z' },
      ]
      renderCustomers()
      await screen.findByText('Active Co')
      await waitFor(() => expect(crmAction).toHaveBeenCalledWith('CRM_LIST_ACCOUNTS', { scope: 'all', withActivity: true }))
      const active = (await screen.findByText('Active Co')).closest('tr') as HTMLElement
      await waitFor(() => expect(active.textContent).toContain('$2,500'))
      expect(active.textContent).toContain('2026-05-09')

      fireEvent.click(within(header('Open AR')).getByTitle('Sort by Open AR'))
      await waitFor(() => expect(names().slice(0, 2)).toEqual(['Pending Co', 'Active Co']))
      fireEvent.click(within(header('Last shipment')).getByTitle('Sort by Last shipment'))
      await waitFor(() => expect(names().slice(0, 2)).toEqual(['Pending Co', 'Active Co']))
      fireEvent.click(within(header('Last shipment')).getByTitle('Sort by Last shipment'))
      await waitFor(() => expect(names().slice(0, 2)).toEqual(['Active Co', 'Pending Co']))

      fireEvent.click(screen.getByRole('button', { name: 'Filter Open AR' }))
      fireEvent.change(screen.getByLabelText('Open AR min'), { target: { value: '100' } })
      await waitFor(() => expect(names()).toEqual(['Active Co']))
    })

    it('a numeric range on credit limit and a multi-select on Factored narrow the rows', async () => {
      localStorage.setItem('tms:grid:customers:admin@bcatcorp.com:v1', JSON.stringify({ columns: ['name', 'credit', 'factored', 'team', 'billingEmails'] }))
      renderCustomers()
      await screen.findByText('Zeta Active')
      fireEvent.click(screen.getByRole('button', { name: 'Filter Credit limit' }))
      fireEvent.change(screen.getByLabelText('Credit limit min'), { target: { value: '2000' } })
      await waitFor(() => expect(names()).toEqual(['Zeta Active']))
      fireEvent.change(screen.getByLabelText('Credit limit min'), { target: { value: '' } })
      fireEvent.change(screen.getByLabelText('Credit limit max'), { target: { value: '1500' } })
      await waitFor(() => expect(names()).toEqual(['Alpha Active']))
      fireEvent.click(screen.getByRole('button', { name: 'Clear 1 filter' }))
      await waitFor(() => expect(names()).toHaveLength(5))

      fireEvent.click(screen.getByRole('button', { name: 'Filter Factored' }))
      fireEvent.click(screen.getByRole('checkbox', { name: 'Factored: Yes' }))
      await waitFor(() => expect(names()).toEqual(['Zeta Active']))
      const zeta = screen.getByText('Zeta Active').closest('tr') as HTMLElement
      expect(zeta.textContent).toContain('Desk One')
      expect(within(zeta).getAllByRole('cell').map((c) => c.textContent)).toContain('2') // two billing e-mails
    })

    it('clicking a header sorts ascending, then descending, and the order persists for that user only', async () => {
      const { unmount } = renderCustomers()
      await screen.findByText('Zeta Active')
      const sortBy = (label: string) => fireEvent.click(within(header(label)).getByTitle(`Sort by ${label}`))
      sortBy('Credit limit')
      await waitFor(() => expect(names().slice(0, 2)).toEqual(['Alpha Active', 'Zeta Active'])) // blanks sort last
      sortBy('Credit limit')
      await waitFor(() => expect(names().slice(0, 2)).toEqual(['Zeta Active', 'Alpha Active']))
      unmount()

      renderCustomers()
      await waitFor(() => expect(names().slice(0, 2)).toEqual(['Zeta Active', 'Alpha Active']))
      expect(header('Credit limit').getAttribute('aria-sort')).toBe('descending')
      cleanup()

      authState.user = { email: 'other@bcatcorp.com' }
      renderCustomers()
      await waitFor(() => expect(names()[0]).toBe('Active Co'))
      expect(localStorage.getItem('tms:grid:customers:admin@bcatcorp.com:v1')).not.toBeNull()
    })

    it('keeps the layout the user chose: a hidden column stays hidden after a reload', async () => {
      localStorage.setItem('tms:grid:customers:admin@bcatcorp.com:v1', JSON.stringify({ columns: ['name', 'status'] }))
      renderCustomers()
      await screen.findByText('Zeta Active')
      expect(header('Customer')).toBeTruthy()
      expect(header('Status')).toBeTruthy()
      expect(screen.queryByRole('columnheader', { name: /^Owner/ })).toBeNull()
    })

    it('the Prospects tab shows the CRM columns of its rows', async () => {
      crmRows.value = [{
        customerId: 'c-lead', ownerId: 'dana@bcatcorp.com', stage: 'NEW', lastTouchAt: PAST, lastTouchKind: 'CALL',
        nextStep: 'Send intro', nextStepDueAt: PAST, openTaskCount: 1,
      }]
      renderCustomers()
      fireEvent.click(await screen.findByText('Prospects'))
      const lead = (await screen.findByText('Lead Co')).closest('tr') as HTMLElement
      await waitFor(() => expect(within(lead).getByTestId('crm-next-step-c-lead').textContent).toContain('Send intro'))
      expect(within(lead).getByText('NEW')).toBeTruthy()
      expect(within(lead).getByText('Dana Carr')).toBeTruthy()
      expect(within(lead).getByTestId('crm-last-touch-c-lead').textContent).toContain('Call')
    })

    it('shows 100 rows and offers the next hundred', async () => {
      const original = customers.length
      for (let i = 0; i < 130; i += 1) customers.push({ id: `bulk-${i}`, name: `Bulk ${String(i).padStart(3, '0')}`, status: 'ACTIVE', active: true, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' } as CustomerRecord)
      try {
        renderCustomers()
        await screen.findByText('Active Co')
        expect(screen.getByTestId('customers-more').textContent).toContain('Showing 100 of 135')
        fireEvent.click(screen.getByRole('button', { name: 'Show next 100' }))
        await waitFor(() => expect(screen.queryByTestId('customers-more')).toBeNull())
      } finally {
        customers.length = original
      }
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

  it('status tabs: Active first with counts that ignore the search box, linkable and remembered', async () => {
    renderCustomers()
    await waitFor(() => expect(screen.getByText('Active Co')).toBeTruthy())
    const tabs = within(screen.getByRole('tablist', { name: 'Customer status' })).getAllByRole('tab')
    expect(tabs.map((t) => t.textContent?.replace(/\d+$/, ''))).toEqual(['Active', 'Prospects', 'Inactive', 'All'])
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true')
    const before = tabs.map((t) => t.textContent)
    fireEvent.change(screen.getByLabelText('Search customers'), { target: { value: 'Pending' } })
    await waitFor(() => expect(screen.queryByText('Active Co')).toBeNull())
    expect(within(screen.getByRole('tablist', { name: 'Customer status' })).getAllByRole('tab').map((t) => t.textContent)).toEqual(before)
    fireEvent.change(screen.getByLabelText('Search customers'), { target: { value: '' } })
    fireEvent.click(screen.getByTestId('customers-tab-leads'))
    await waitFor(() => expect(screen.getByTestId('search').textContent).toContain('status=leads'))
    expect(localStorage.getItem('tms:customers:status-tab')).toBe('leads')
  })

  it('opens on the status in the link, else the last one used', async () => {
    renderCustomers('/tms/customers?status=inactive')
    await waitFor(() => expect(screen.getByText('Blocked Co')).toBeTruthy())
    expect(screen.getByTestId('customers-tab-inactive').getAttribute('aria-selected')).toBe('true')
    cleanup()
    localStorage.setItem('tms:customers:status-tab', 'leads')
    renderCustomers()
    await waitFor(() => expect(screen.getByText('Lead Co')).toBeTruthy())
    expect(screen.getByTestId('customers-tab-leads').getAttribute('aria-selected')).toBe('true')
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

  it('saves a tracking choice made in the profile, and leaves the keys off when none was made', async () => {
    saveCustomer.mockClear()
    renderCustomers()
    await waitFor(() => expect(screen.getByText('Legacy Active')).toBeTruthy())
    fireEvent.click(screen.getByText('Legacy Active'))
    fireEvent.click(await screen.findByText('Settings'))

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(saveCustomer).toHaveBeenCalledTimes(1))
    expect(saveCustomer.mock.calls[0][1]).not.toHaveProperty('trackingMode')

    fireEvent.click(screen.getByRole('radio', { name: 'Manual' }))
    fireEvent.click(screen.getByRole('radio', { name: 'SMS to driver' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(saveCustomer).toHaveBeenCalledTimes(2))
    expect(saveCustomer.mock.calls[1][1]).toEqual(expect.objectContaining({ trackingMode: 'MANUAL', trackingMethod: 'SMS' }))
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
function CustomerFormHarness({ initial, onSave }: { initial: CustomerRecord | null; onSave: (record: CustomerRecord) => void }) {
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

  it('preselects AGENT / BOTH / work-then-personal on a new customer and writes all three', async () => {
    const onSave = vi.fn()
    await act(async () => { render(<CustomerFormHarness initial={null} onSave={onSave} />) })
    expect((screen.getByRole('radio', { name: 'AI agent tracking' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('radio', { name: 'Both' }) as HTMLInputElement).checked).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Save form' }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      trackingMode: 'AGENT', trackingMethod: 'BOTH', driverSmsTarget: 'WORK_THEN_PERSONAL',
    }))
  })

  it('round-trips a changed choice into the saved record', async () => {
    const onSave = vi.fn()
    await act(async () => { render(<CustomerFormHarness initial={null} onSave={onSave} />) })
    fireEvent.click(screen.getByRole('radio', { name: 'Manual' }))
    fireEvent.click(screen.getByRole('radio', { name: 'SMS to driver' }))
    fireEvent.change(screen.getByLabelText('Driver SMS goes to'), { target: { value: 'PERSONAL' } })

    fireEvent.click(screen.getByRole('button', { name: 'Save form' }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      trackingMode: 'MANUAL', trackingMethod: 'SMS', driverSmsTarget: 'PERSONAL',
    }))
  })

  it('shows "Not set" for a legacy customer and sends no tracking keys when another field is saved', async () => {
    const onSave = vi.fn()
    await act(async () => { render(<CustomerFormHarness initial={legacy} onSave={onSave} />) })
    expect(screen.getByText(/Not set — follows Settings/)).toBeTruthy()
    expect(screen.getAllByRole('radio').every((r) => !(r as HTMLInputElement).checked)).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Save form' }))
    const record = onSave.mock.calls[0][0] as Record<string, unknown>
    expect(record).not.toHaveProperty('trackingMode')
    expect(record).not.toHaveProperty('trackingMethod')
    expect(record).not.toHaveProperty('driverSmsTarget')
  })

  it('keeps the stored choices of a customer that has them', async () => {
    const onSave = vi.fn()
    await act(async () => { render(<CustomerFormHarness initial={{ ...legacy, trackingMode: 'MANUAL', trackingMethod: 'EMAIL', driverSmsTarget: 'WORK_ONLY' }} onSave={onSave} />) })
    expect((screen.getByRole('radio', { name: 'Manual' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('radio', { name: 'E-mail thread (dispatcher)' }) as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Save form' }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ trackingMode: 'MANUAL', trackingMethod: 'EMAIL', driverSmsTarget: 'WORK_ONLY' }))
  })
})
