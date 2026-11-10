// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { CarrierRecord, UserProfileRecord } from '@/types/tms'
import { listCarrierRemitEmails } from '@/lib/apiClient'
import { CarriersPage } from './CarriersPage'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

function carrier(id: string, patch: Partial<CarrierRecord>): CarrierRecord {
  return {
    id,
    name: id,
    type: 'TL',
    status: 'ACTIVE',
    createdBy: 'a@b.c',
    updatedBy: 'a@b.c',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  }
}

const carriers: CarrierRecord[] = [
  carrier('Alpha Trucking', { status: 'PENDING', mcNumber: '111111' }),
  carrier('Bravo Lines', { status: 'REVIEW', mcNumber: '222222' }),
  carrier('Charlie Freight', {
    status: 'ACTIVE',
    mcNumber: '333333',
    mcpRiskScore: 10,
    loadCount: 12,
    insurancePolicies: [
      { id: 'c1', type: 'CARGO', expiresAt: '2099-03-01T00:00:00.000Z' },
      { id: 'c2', type: 'AUTO_LIABILITY', expiresAt: '2099-03-05T00:00:00.000Z' },
    ],
  }),
  carrier('Golf Lines', {
    status: 'ACTIVE',
    mcNumber: '777777',
    mcpRiskScore: 40,
    loadCount: 3,
    insurancePolicies: [{ id: 'g1', type: 'CARGO', expiresAt: '2098-12-01T00:00:00.000Z' }],
  }),
  // Stored ACTIVE, but every cargo certificate lapsed — the board derives Inactive.
  carrier('Delta Haul', {
    status: 'ACTIVE',
    mcNumber: '444444',
    insurancePolicies: [{ id: 'p1', type: 'CARGO', expiresAt: '2020-01-01T00:00:00.000Z' }],
  }),
  carrier('Echo Carriers', { status: 'DO_NOT_USE', mcNumber: '555555' }),
  carrier('Foxtrot Transport', { status: 'INACTIVE', mcNumber: '666666' }),
]

const auth = vi.hoisted(() => ({ isAdmin: true }))
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ isAdmin: auth.isAdmin, isOwner: false, user: { email: 'ryne@bcatcorp.com' } }),
}))
vi.mock('@/hooks/useCarriers', () => ({
  useCarriers: () => ({ carriers, loading: false, error: null, refresh: vi.fn(), replace: vi.fn() }),
}))
const { upsertCarrier } = vi.hoisted(() => ({
  upsertCarrier: vi.fn(async () => ({ id: 'car-new' })),
}))
// The account-owner field is a RepPicker, so the dialog reads the staff directory.
const staff = vi.hoisted(() => [
  {
    id: 'dana@bcatcorp.com', email: 'dana@bcatcorp.com', name: 'Dana Carr', role: 'CARRIER_REP',
    createdBy: 'a@b.c', updatedBy: 'a@b.c', version: 1,
  },
] as UserProfileRecord[])
vi.mock('@/lib/apiClient', () => ({
  getTmsSettings: vi.fn(async () => null),
  listCarrierRemitEmails: vi.fn(async () => [{ carrierId: 'Charlie Freight', payeeEmail: 'pay@example.test' }]),
  listUserProfiles: vi.fn(async () => staff),
  upsertCarrier,
  graphqlErrorText: () => '',
}))
vi.mock('./components/CarrierProfile', () => ({
  CarrierProfile: ({ carrierId }: { carrierId: string }) => <div data-testid="profile">{carrierId}</div>,
}))

function renderBoard() {
  return render(<MemoryRouter><CarriersPage /></MemoryRouter>)
}

/** Names in the order the grid draws them (first cell of every body row). */
function names(): string[] {
  return [...document.querySelectorAll('tbody tr:not(.tms-dg-spacer) td:first-child')].map((td) => td.textContent ?? '')
}

function openFilter(header: string) {
  fireEvent.click(screen.getByRole('button', { name: `Filter ${header}` }))
}

function tab(name: string): HTMLElement {
  return screen.getByRole('tab', { name: new RegExp(`^${name}`) })
}

beforeEach(() => { auth.isAdmin = true; localStorage.clear() })

describe('CarriersPage', () => {
  it('does not label carriers missing when the payment-method read fails', async () => {
    vi.mocked(listCarrierRemitEmails).mockRejectedValueOnce(new Error('unavailable'))
    renderBoard()
    expect((await screen.findByRole('alert')).textContent).toContain('Remittance e-mail flags unavailable')
    expect(screen.queryByText('Missing remittance e-mail')).toBeNull()
    expect(screen.getByRole('button', { name: 'Missing remit e-mail (…)'}).hasAttribute('disabled')).toBe(true)
  })

  it('counts missing remit across every status and filters to those carriers', async () => {
    renderBoard()
    fireEvent.click(await screen.findByRole('button', { name: 'Missing remit e-mail (6)' }))
    expect(names()).toEqual(['Alpha Trucking', 'Bravo Lines', 'Delta Haul', 'Echo Carriers', 'Foxtrot Transport', 'Golf Lines'])
    expect(screen.getAllByText('Missing remittance e-mail').length).toBe(6)
    expect(screen.queryByText('Charlie Freight')).toBeNull()
  })

  it('counts every carrier under its effective status', async () => {
    renderBoard()
    await waitFor(() => expect(screen.getByText('Carriers')).toBeTruthy())

    expect(within(tab('Pending/Review')).getByText('2')).toBeTruthy()
    expect(within(tab('Active')).getByText('2')).toBeTruthy()
    // Echo, Foxtrot and Delta — the last one only because its cargo cover expired.
    expect(within(tab('Inactive/Do not use')).getByText('3')).toBeTruthy()
  })

  it('lists only the selected tab’s carriers', async () => {
    renderBoard()
    await waitFor(() => expect(screen.getByText('Charlie Freight')).toBeTruthy())
    expect(screen.queryByText('Alpha Trucking')).toBeNull()

    fireEvent.click(tab('Pending/Review'))
    await waitFor(() => expect(screen.getByText('Alpha Trucking')).toBeTruthy())
    expect(screen.getByText('Bravo Lines')).toBeTruthy()
    expect(screen.queryByText('Charlie Freight')).toBeNull()
  })

  it('narrows the list by MC number from the search box', async () => {
    renderBoard()
    fireEvent.click(tab('Pending/Review'))
    await waitFor(() => expect(screen.getByText('Alpha Trucking')).toBeTruthy())

    // The kit's list page labels its search box "Search"; the placeholder names the fields.
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: '222222' } })
    await waitFor(() => expect(screen.queryByText('Alpha Trucking')).toBeNull())
    expect(screen.getByText('Bravo Lines')).toBeTruthy()
  })

  it('offers the CSV export to an admin only', async () => {
    auth.isAdmin = false
    const nonAdmin = renderBoard()
    await waitFor(() => expect(screen.getByText('Carriers')).toBeTruthy())
    expect(screen.queryByRole('button', { name: /CSV/ })).toBeNull()
    nonAdmin.unmount()

    auth.isAdmin = true
    renderBoard()
    await waitFor(() => expect(screen.getByRole('button', { name: /CSV/ })).toBeTruthy())
  })

  it('Export all is for admins, and writes every carrier with every field whatever the tab or search shows', async () => {
    auth.isAdmin = false
    const nonAdmin = renderBoard()
    await waitFor(() => expect(screen.getByText('Carriers')).toBeTruthy())
    expect(screen.queryByTestId('export-all-carriers')).toBeNull()
    nonAdmin.unmount()

    auth.isAdmin = true
    const blobs: Blob[] = []
    ;(URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b) => { blobs.push(b); return 'blob:all' }
    ;(URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => undefined
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    renderBoard()
    await waitFor(() => expect(screen.getByText('Charlie Freight')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: '333333' } })
    fireEvent.click(screen.getByTestId('export-all-carriers'))
    const text = await blobs[0]!.text()
    const lines = text.replace('\ufeff', '').split('\r\n')
    expect(lines).toHaveLength(carriers.length + 1)
    expect(lines[0]).toContain('mcNumber')
    expect(lines[0]).toContain('insurancePolicies')
    expect(text).toContain('Alpha Trucking')
    expect(text).toContain('Echo Carriers')
    click.mockRestore()
  })

  it('tells the user when the current view is empty', async () => {
    renderBoard()
    await waitFor(() => expect(screen.getByText('Charlie Freight')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'nobody' } })
    await waitFor(() => expect(screen.getByText('No carriers in this view.')).toBeTruthy())
  })

  it('creates a carrier owned by the rep picked from the directory', async () => {
    renderBoard()
    await waitFor(() => expect(screen.getByText('Carriers')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /admin data fix/ }))

    fireEvent.change(await screen.findByLabelText('Carrier name'), { target: { value: 'New Haul' } })
    fireEvent.change(screen.getByLabelText('MC number'), { target: { value: '999999' } })
    fireEvent.click(screen.getByText('Pick an account owner…'))
    fireEvent.click(await screen.findByRole('option', { name: /Dana Carr/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Add carrier' }))

    await waitFor(() => expect(upsertCarrier).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'New Haul', accountOwnerIds: ['dana@bcatcorp.com'] }),
    ))
  })

  it('still takes an owner nobody has a profile for, exactly as typed', async () => {
    renderBoard()
    await waitFor(() => expect(screen.getByText('Carriers')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /admin data fix/ }))

    fireEvent.change(await screen.findByLabelText('Carrier name'), { target: { value: 'Old Haul' } })
    fireEvent.change(screen.getByLabelText('MC number'), { target: { value: '888888' } })
    fireEvent.click(screen.getByText('Pick an account owner…'))
    const search = await screen.findByLabelText('Search people')
    fireEvent.change(search, { target: { value: 'legacy.rep@nowhere.test' } })
    fireEvent.click(await screen.findByRole('option', { name: /Use “legacy\.rep@nowhere\.test”/ }))

    expect(screen.getByText('not a user')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add carrier' }))

    await waitFor(() => expect(upsertCarrier).toHaveBeenCalledWith(
      expect.objectContaining({ accountOwnerIds: ['legacy.rep@nowhere.test'] }),
    ))
  })

  it('hides hand entry of a carrier from everyone but an admin: carriers come through MyCarrierPackets', async () => {
    auth.isAdmin = false
    renderBoard()
    await waitFor(() => expect(screen.getByText('Carriers')).toBeTruthy())
    expect(screen.queryByRole('button', { name: /admin data fix/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Add carrier/ })).toBeNull()
  })

  it('launches Find & invite from the Carriers header for every user', () => {
    auth.isAdmin = false
    renderBoard()
    expect(screen.getByTestId('launch-find-invite').getAttribute('href')).toBe('/tms/carriers/find')
  })

  it('sorts on a header click: ascending, then descending', async () => {
    renderBoard()
    await waitFor(() => expect(names()).toEqual(['Charlie Freight', 'Golf Lines']))
    fireEvent.click(screen.getByRole('button', { name: 'Risk' }))
    expect(names()).toEqual(['Charlie Freight', 'Golf Lines'])
    fireEvent.click(screen.getByRole('button', { name: 'Risk' }))
    expect(names()).toEqual(['Golf Lines', 'Charlie Freight'])
  })

  it('narrows by the risk score range in the header filter', async () => {
    renderBoard()
    await waitFor(() => expect(names()).toHaveLength(2))
    openFilter('Risk')
    fireEvent.change(screen.getByLabelText('Risk min'), { target: { value: '20' } })
    expect(names()).toEqual(['Golf Lines'])
  })

  it('narrows by the insurance expiry date range', async () => {
    renderBoard()
    await waitFor(() => expect(names()).toHaveLength(2))
    openFilter('Cargo ins. exp.')
    fireEvent.change(screen.getByLabelText('Cargo ins. exp. from'), { target: { value: '2099-01-01' } })
    expect(names()).toEqual(['Charlie Freight'])
    fireEvent.change(screen.getByLabelText('Cargo ins. exp. from'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Cargo ins. exp. to'), { target: { value: '2098-12-31' } })
    expect(names()).toEqual(['Golf Lines'])
  })

  it('filters the status column by multi-select, across the effective statuses', async () => {
    renderBoard()
    await waitFor(() => expect(names()).toHaveLength(2))
    fireEvent.click(tab('Inactive/Do not use'))
    await waitFor(() => expect(names()).toHaveLength(3))
    openFilter('Status')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Status: Do not use' }))
    expect(names()).toEqual(['Echo Carriers'])
  })

  it('remembers density per user and board', async () => {
    const view = renderBoard()
    await waitFor(() => expect(names()).toHaveLength(2))
    fireEvent.click(screen.getByRole('button', { name: 'Comfortable' }))
    const stored = JSON.parse(localStorage.getItem('tms:grid:carriers:ryne@bcatcorp.com:v1') ?? '{}')
    expect(stored.density).toBe('comfortable')

    view.unmount()
    renderBoard()
    expect(screen.getByRole('button', { name: 'Comfortable' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('opens the carrier profile when a row is clicked', async () => {
    renderBoard()
    await waitFor(() => expect(names()).toHaveLength(2))
    expect(screen.queryByTestId('profile')).toBeNull()
    fireEvent.click(screen.getByText('Golf Lines'))
    expect(screen.getByTestId('profile').textContent).toBe('Golf Lines')
  })

  it('shows counts across status tabs and the all-status scope', async () => {
    renderBoard()
    await waitFor(() => expect(names()).toHaveLength(2))
    fireEvent.click(tab('Pending/Review'))
    expect(within(tab('Active')).getByText('2')).toBeTruthy()
    expect(within(tab('All statuses')).getByText('7')).toBeTruthy()
  })

})
