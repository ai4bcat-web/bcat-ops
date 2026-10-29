// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router-dom'
import type { OwnershipDivisionRecord, ShipmentViewRecord } from '@/types/tms'

const mocks = vi.hoisted(() => ({
  listShipmentViews: vi.fn(),
  listOwnershipDivisions: vi.fn(),
  saveShipmentView: vi.fn(),
  archiveShipmentView: vi.fn(),
  listUserProfiles: vi.fn(),
}))
vi.mock('@/lib/apiClient', () => mocks)

const auth = vi.hoisted(() => ({ isOwner: true, isAdmin: false }))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }))

import ShipmentViewsPage from './ShipmentViewsPage'

const DIVISIONS: OwnershipDivisionRecord[] = [
  {
    id: 'ASSETS', code: 'ASSETS', name: 'Ivan Cartage', brand: 'Ivan Cartage', parentId: null, color: null,
    sortOrder: 10, active: true, owners: null, flows: null, createdBy: 's', updatedBy: 's', version: 1,
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
  },
]

const VIEW: ShipmentViewRecord = {
  id: 'dispatch',
  slug: 'dispatch',
  name: 'Dispatch',
  department: 'Dispatch',
  description: "Ivan Cartage's own trucks.",
  filters: { divisions: ['ASSETS'], pickupWindow: 'today_tomorrow' },
  columns: null,
  sort: null,
  isDefault: false,
  audience: { roles: ['CARRIER_REP'] },
  sortOrder: 10,
  active: true,
  createdBy: 's',
  updatedBy: 's',
  version: 1,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  auth.isOwner = true
  auth.isAdmin = false
  mocks.listShipmentViews.mockResolvedValue([VIEW])
  mocks.listOwnershipDivisions.mockResolvedValue(DIVISIONS)
  mocks.listUserProfiles.mockResolvedValue([])
  mocks.saveShipmentView.mockResolvedValue(VIEW)
})

const renderPage = () => render(<MemoryRouter><ShipmentViewsPage /></MemoryRouter>)

describe('ShipmentViewsPage', () => {
  it('lists each view with its slug, audience and a link onto the board', async () => {
    renderPage()

    const row = (await screen.findByText('dispatch', { selector: 'td' })).closest('tr') as HTMLTableRowElement
    expect(row.cells[0]).toHaveTextContent('Dispatch')
    expect(row.cells[1]).toHaveTextContent('Dispatch')
    expect(row.cells[3]).toHaveTextContent('Carrier rep')
    expect(row.cells[5]).toHaveTextContent('Active')
    expect(within(row).getByRole('link', { name: 'Open view' })).toHaveAttribute(
      'href',
      '/tms/shipments/view/dispatch',
    )
  })

  it('saves exactly the filter clauses the editor set, under the slug the name makes', async () => {
    mocks.listShipmentViews.mockResolvedValue([])
    renderPage()

    await waitFor(() => expect(mocks.listOwnershipDivisions).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Add view' }))

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Night dispatch' } })
    fireEvent.change(screen.getByLabelText('Department'), { target: { value: 'Dispatch' } })

    const filterDivisions = screen.getByRole('group', { name: 'Divisions' })
    fireEvent.click(within(filterDivisions).getByLabelText('Ivan Cartage (ASSETS)'))

    const statuses = screen.getByRole('group', { name: 'Statuses' })
    fireEvent.click(within(statuses).getByLabelText('DELIVERED'))

    fireEvent.change(screen.getByLabelText('Pickup window'), { target: { value: 'today_tomorrow' } })
    fireEvent.change(screen.getByLabelText('Search text'), { target: { value: ' reefer ' } })

    fireEvent.click(screen.getByRole('button', { name: 'Save view' }))

    await waitFor(() => expect(mocks.saveShipmentView).toHaveBeenCalled())
    const input = mocks.saveShipmentView.mock.calls[0][0]
    expect(input.id).toBe('night-dispatch')
    expect(input.slug).toBe('night-dispatch')
    expect(input.name).toBe('Night dispatch')
    expect(input.department).toBe('Dispatch')
    // Exactly the clauses that were set — an absent clause filters nothing, and an
    // empty one would read as a clause somebody wrote.
    expect(input.filters).toEqual({
      divisions: ['ASSETS'],
      statuses: ['DELIVERED'],
      pickupWindow: 'today_tomorrow',
      search: 'reefer',
    })
    expect(input.audience).toBeNull()
    expect(input.columns).toEqual([
      'number', 'status', 'originCity', 'destinationCity', 'pickupAppt', 'deliveryAppt',
      'stops', 'salesRepId', 'customerName', 'carrier', 'division', 'driver',
    ])
  })

  it('keeps an existing view’s slug when its name is edited', async () => {
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Edit dispatch' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Dispatch board' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save view' }))

    await waitFor(() => expect(mocks.saveShipmentView).toHaveBeenCalled())
    const input = mocks.saveShipmentView.mock.calls[0][0]
    expect(input.slug).toBe('dispatch')
    expect(input.name).toBe('Dispatch board')
    expect(input.filters).toEqual({ divisions: ['ASSETS'], pickupWindow: 'today_tomorrow' })
    expect(input.audience).toEqual({ roles: ['CARRIER_REP'] })
  })

  it('blocks a save the view rules refuse and never calls the router', async () => {
    mocks.listShipmentViews.mockResolvedValue([])
    renderPage()

    await waitFor(() => expect(mocks.listOwnershipDivisions).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Add view' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save view' }))

    expect(await screen.findByText('The view needs a name.')).toBeInTheDocument()
    expect(mocks.saveShipmentView).not.toHaveBeenCalled()
  })

  it('shows the server’s refusal verbatim when an archive is refused', async () => {
    mocks.archiveShipmentView.mockRejectedValue(new Error('Only the owner may archive a seed view.'))
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Archive dispatch' }))

    expect(await screen.findByText('Only the owner may archive a seed view.')).toBeInTheDocument()
  })

  it('tells a signed-in user who is neither owner nor ADMIN to ask one of them', async () => {
    auth.isOwner = false
    renderPage()

    expect(await screen.findByText(/edited by the owner and the ADMIN group/)).toBeInTheDocument()
    expect(mocks.listShipmentViews).not.toHaveBeenCalled()
  })
})
