// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type * as AuthModule from '@/hooks/useAuth'
import type { ShipmentViewRecord } from '@/types/tms'
import type { ShipmentRow } from './shipmentViews'
import { ShipmentsBoard } from './ShipmentsBoard'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

const HOUR = 3_600_000

function row(id: string, patch: Partial<ShipmentRow>): ShipmentRow {
  return {
    id,
    number: id,
    status: 'IN_TRANSIT',
    customerId: 'cust-1',
    customerName: 'Acme Freight',
    mode: 'FTL',
    source: 'MANUAL',
    createdBy: 'a@b.c',
    updatedBy: 'a@b.c',
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
    ...patch,
  }
}

const shipments: ShipmentRow[] = [
  row('S-OVERDUE', {
    nextCheckCallAt: new Date(Date.now() - HOUR).toISOString(),
    lastUpdateAt: new Date(Date.now() - 2 * HOUR).toISOString(),
    lastUpdatePlace: 'Joliet, IL',
    openIncidentCount: 2,
  }),
  row('S-DUE', { nextCheckCallAt: new Date(Date.now() - 60_000).toISOString() }),
  row('S-LATER', { nextCheckCallAt: new Date(Date.now() + 6 * HOUR).toISOString() }),
  row('S-QUIET', {}),
]

/**
 * The tracking columns are not among MVMNT's thirteen, so they reach the screen the way
 * a dispatcher would get them: a saved view that names its own columns.
 */
const views: ShipmentViewRecord[] = [{
  id: 'tracking',
  slug: 'tracking',
  name: 'Tracking',
  department: 'Tracking',
  description: null,
  filters: {},
  columns: ['number', 'status', 'lastUpdateAt', 'nextCheckCallAt', 'openIncidentCount'],
  sort: { key: 'number', dir: 'asc' },
  isDefault: false,
  audience: null,
  sortOrder: 10,
  active: true,
  createdBy: 'a@b.c',
  updatedBy: 'a@b.c',
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}]

vi.mock('@/hooks/useAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthModule>()),
  useAuth: () => ({ isAdmin: true, isOwner: false, user: { email: 'ryne@bcatcorp.com', userId: 'ryne', groups: ['ADMIN'] } }),
  useAuthUser: () => ({ email: 'ryne@bcatcorp.com', userId: 'ryne', groups: ['ADMIN'] }),
}))
vi.mock('@/hooks/useDirectory', () => ({ useDirectory: () => ({ customers: [], locations: [] }) }))
vi.mock('@/hooks/useShipments', () => ({
  useShipments: () => ({ shipments, loading: false, error: null, refresh: vi.fn() }),
}))
vi.mock('@/hooks/useStaff', () => ({
  useStaff: () => ({
    staff: [], byId: {}, loading: false, error: null, refresh: vi.fn(),
    nameOf: (id: string | null) => id ?? '—',
  }),
}))
vi.mock('@/features/tms/useShipmentViews', () => ({
  useShipmentViews: () => ({ views, loading: false, error: null, refresh: vi.fn() }),
  useOwnershipDivisions: () => ({ divisions: null, loading: false, error: null, refresh: vi.fn() }),
}))
vi.mock('@/lib/apiClient', () => ({
  getTmsSettings: vi.fn(async () => null),
  createShipment: vi.fn(),
  duplicateShipment: vi.fn(),
  saveShipmentView: vi.fn(),
  setShipmentStatus: vi.fn(),
  tenderRespond: vi.fn(),
  voidShipment: vi.fn(),
  graphqlErrorText: () => '',
  listDocumentReviewQueue: vi.fn(async () => []),
}))
vi.mock('./components/ShipmentDrawer', () => ({ ShipmentDrawer: () => null }))

function renderBoard() {
  return render(
    <MemoryRouter initialEntries={['/tms/shipments/view/tracking']}>
      <Routes>
        <Route path="/tms/shipments" element={<ShipmentsBoard />} />
        <Route path="/tms/shipments/view/:slug" element={<ShipmentsBoard />} />
      </Routes>
    </MemoryRouter>,
  )
}

const cellFor = (id: string): HTMLElement => {
  const cells = screen.getAllByTestId('board-next-check-call')
  const rowEl = screen.getByText(id).closest('tr')
  const found = cells.find((c) => rowEl?.contains(c))
  if (!found) throw new Error(`no check-call cell on row ${id}`)
  return found
}

describe('ShipmentsBoard tracking columns', () => {
  it('tones the next check call by how late it is', async () => {
    renderBoard()
    await waitFor(() => expect(screen.getByText('S-OVERDUE')).toBeTruthy())

    expect(cellFor('S-OVERDUE').dataset.state).toBe('OVERDUE')
    expect(cellFor('S-OVERDUE').className).toContain('tms-overdue')
    expect(cellFor('S-DUE').dataset.state).toBe('DUE')
    expect(cellFor('S-DUE').className).toContain('tms-due')
    expect(cellFor('S-LATER').dataset.state).toBe('SCHEDULED')
    expect(cellFor('S-LATER').className).not.toContain('tms-overdue')
    expect(cellFor('S-QUIET').dataset.state).toBe('NONE')
    expect(cellFor('S-QUIET').textContent).toBe('')
  })

  it('badges open exceptions and shows where the freight last was', async () => {
    renderBoard()
    await waitFor(() => expect(screen.getByText('S-OVERDUE')).toBeTruthy())

    const badges = screen.getAllByTestId('board-exceptions')
    expect(badges.length).toBe(1)
    expect(badges[0].textContent).toBe('2')
    expect(screen.getByText(/Joliet, IL/)).toBeTruthy()
  })

  it('narrows to the loads that are actually late', async () => {
    renderBoard()
    await waitFor(() => expect(screen.getByText('S-LATER')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /Filter/ }))
    fireEvent.click(await screen.findByLabelText('Filter overdue'))
    await waitFor(() => expect(screen.queryByText('S-LATER')).toBeNull())
    expect(screen.getByText('S-OVERDUE')).toBeTruthy()
    expect(screen.queryByText('S-DUE')).toBeNull()

    // Due includes overdue — a load past its grace is still a load that needs calling.
    fireEvent.click(screen.getByLabelText('Filter overdue'))
    fireEvent.click(screen.getByLabelText('Filter check call due'))
    await waitFor(() => expect(screen.getByText('S-DUE')).toBeTruthy())
    expect(screen.getByText('S-OVERDUE')).toBeTruthy()
    expect(screen.queryByText('S-QUIET')).toBeNull()
  })

  it('shows only the shipments carrying an open exception', async () => {
    renderBoard()
    await waitFor(() => expect(screen.getByText('S-DUE')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /Filter/ }))
    fireEvent.click(await screen.findByLabelText('Filter open exceptions'))

    await waitFor(() => expect(screen.queryByText('S-DUE')).toBeNull())
    expect(screen.getByText('S-OVERDUE')).toBeTruthy()
  })
})
