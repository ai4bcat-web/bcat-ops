// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
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
  } as ShipmentRow
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

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ isAdmin: true, isOwner: false, user: { email: 'ryne@bcatcorp.com' } }) }))
vi.mock('@/hooks/useDirectory', () => ({ useDirectory: () => ({ customers: [], locations: [] }) }))
vi.mock('@/hooks/useShipments', () => ({
  useShipments: () => ({ shipments, loading: false, error: null, refresh: vi.fn() }),
}))
vi.mock('@/lib/apiClient', () => ({
  getTmsSettings: vi.fn(async () => null),
  createShipment: vi.fn(),
  deleteShipment: vi.fn(),
  duplicateShipment: vi.fn(),
  restoreShipment: vi.fn(),
  setShipmentStatus: vi.fn(),
  tenderRespond: vi.fn(),
  graphqlErrorText: () => '',
}))
vi.mock('./components/ShipmentDrawer', () => ({ ShipmentDrawer: () => null }))

const cellFor = (id: string): HTMLElement => {
  const cells = screen.getAllByTestId('board-next-check-call')
  const rowEl = screen.getByText(id).closest('tr')
  const found = cells.find((c) => rowEl?.contains(c))
  if (!found) throw new Error(`no check-call cell on row ${id}`)
  return found
}

describe('ShipmentsBoard tracking columns', () => {
  it('tones the next check call by how late it is', async () => {
    render(<MemoryRouter><ShipmentsBoard /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('S-OVERDUE')).toBeTruthy())

    expect(cellFor('S-OVERDUE').dataset.state).toBe('OVERDUE')
    expect(cellFor('S-OVERDUE').className).toContain('text-destructive')
    expect(cellFor('S-DUE').dataset.state).toBe('DUE')
    expect(cellFor('S-DUE').className).toContain('text-amber-700')
    expect(cellFor('S-LATER').dataset.state).toBe('SCHEDULED')
    expect(cellFor('S-LATER').className).not.toContain('text-destructive')
    expect(cellFor('S-QUIET').dataset.state).toBe('NONE')
    expect(cellFor('S-QUIET').textContent).toBe('')
  })

  it('badges open exceptions and shows where the freight last was', async () => {
    render(<MemoryRouter><ShipmentsBoard /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('S-OVERDUE')).toBeTruthy())

    const badges = screen.getAllByTestId('board-exceptions')
    expect(badges.length).toBe(1)
    expect(badges[0].textContent).toBe('2')
    expect(screen.getByText(/Joliet, IL/)).toBeTruthy()
  })

  it('narrows to the loads that are actually late', async () => {
    render(<MemoryRouter><ShipmentsBoard /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('S-LATER')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /Filters/ }))
    await waitFor(() => expect(screen.getByLabelText('Filter check call overdue')).toBeTruthy())

    fireEvent.click(screen.getByLabelText('Filter check call overdue'))
    await waitFor(() => expect(screen.queryByText('S-LATER')).toBeNull())
    expect(screen.getByText('S-OVERDUE')).toBeTruthy()
    expect(screen.queryByText('S-DUE')).toBeNull()

    // Due includes overdue — a load past its grace is still a load that needs calling.
    fireEvent.click(screen.getByLabelText('Filter check call overdue'))
    fireEvent.click(screen.getByLabelText('Filter check call due'))
    await waitFor(() => expect(screen.getByText('S-DUE')).toBeTruthy())
    expect(screen.getByText('S-OVERDUE')).toBeTruthy()
    expect(screen.queryByText('S-QUIET')).toBeNull()
  })

  it('shows only the shipments carrying an open exception', async () => {
    render(<MemoryRouter><ShipmentsBoard /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('S-DUE')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /Filters/ }))
    fireEvent.click(await screen.findByLabelText('Filter open exceptions'))

    await waitFor(() => expect(screen.queryByText('S-DUE')).toBeNull())
    expect(screen.getByText('S-OVERDUE')).toBeTruthy()
  })
})
