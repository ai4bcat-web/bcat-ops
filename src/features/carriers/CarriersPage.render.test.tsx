// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { CarrierRecord } from '@/types/tms'
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
  carrier('Charlie Freight', { status: 'ACTIVE', mcNumber: '333333' }),
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
vi.mock('@/lib/apiClient', () => ({
  getTmsSettings: vi.fn(async () => null),
  listCarrierDocuments: vi.fn(async () => []),
  upsertCarrier: vi.fn(),
  graphqlErrorText: () => '',
}))
vi.mock('./components/CarrierProfile', () => ({ CarrierProfile: () => null }))

function renderBoard() {
  return render(<MemoryRouter><CarriersPage /></MemoryRouter>)
}

function tab(name: string): HTMLElement {
  return screen.getByRole('tab', { name: new RegExp(`^${name}`) })
}

beforeEach(() => { auth.isAdmin = true })

describe('CarriersPage', () => {
  it('counts every carrier under its effective status', async () => {
    renderBoard()
    await waitFor(() => expect(screen.getByText('Carriers')).toBeTruthy())

    expect(within(tab('Pending/Review')).getByText('2')).toBeTruthy()
    expect(within(tab('Active')).getByText('1')).toBeTruthy()
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

    fireEvent.change(screen.getByLabelText('Search carriers'), { target: { value: '222222' } })
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

  it('tells the user when the current view is empty', async () => {
    renderBoard()
    await waitFor(() => expect(screen.getByText('Charlie Freight')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('Search carriers'), { target: { value: 'nobody' } })
    await waitFor(() => expect(screen.getByText('No carriers in this view.')).toBeTruthy())
  })
})
