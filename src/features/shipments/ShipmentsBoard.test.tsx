// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ShipmentRow } from './shipmentViews'
import { ShipmentsBoard } from './ShipmentsBoard'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

function row(id: string, patch: Partial<ShipmentRow>): ShipmentRow {
  return {
    id,
    number: id,
    status: 'OPEN',
    customerId: 'cust-1',
    customerName: 'Acme Freight',
    mode: 'FTL',
    source: 'MANUAL',
    createdBy: 'a@b.c',
    updatedBy: 'a@b.c',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  }
}

const shipments: ShipmentRow[] = [
  row('S000001', { status: 'DRAFT', searchKey: 's000001 acme freight chicago il' }),
  row('S000002', { status: 'OPEN', searchKey: 's000002 acme freight dallas tx' }),
  row('S000003', { status: 'IN_TRANSIT', searchKey: 's000003 globex denver co', customerName: 'Globex' }),
  row('S000004', { status: 'DELIVERED', searchKey: 's000004 globex denver co', customerName: 'Globex' }),
  row('S000005', { status: 'UNLOADING', searchKey: 's000005 initech boise id', customerName: 'Initech' }),
]

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ isAdmin: true, isOwner: false, user: { email: 'ryne@bcatcorp.com' } }) }))
vi.mock('@/hooks/useDirectory', () => ({ useDirectory: () => ({ customers: [], locations: [] }) }))
vi.mock('@/hooks/useShipments', () => ({
  useShipments: () => ({ shipments, loading: false, error: null, refresh: vi.fn() }),
}))
const { setShipmentStatus } = vi.hoisted(() => ({ setShipmentStatus: vi.fn(async () => ({})) }))
vi.mock('@/lib/apiClient', () => ({
  getTmsSettings: vi.fn(async () => null),
  createShipment: vi.fn(),
  deleteShipment: vi.fn(),
  duplicateShipment: vi.fn(),
  restoreShipment: vi.fn(),
  setShipmentStatus,
  tenderRespond: vi.fn(),
  graphqlErrorText: () => '',
  listDocumentReviewQueue: vi.fn(async () => []),
}))
vi.mock('./components/ShipmentDrawer', () => ({ ShipmentDrawer: () => null }))

function renderBoard() {
  return render(<MemoryRouter><ShipmentsBoard /></MemoryRouter>)
}

function tab(name: string): HTMLElement {
  return screen.getByRole('tab', { name: new RegExp(`^${name}`) })
}

describe('ShipmentsBoard', () => {
  it('shows a count on every status tab', async () => {
    renderBoard()
    await waitFor(() => expect(screen.getByText('Shipments')).toBeTruthy())

    expect(within(tab('All')).getByText('5')).toBeTruthy()
    expect(within(tab('Draft')).getByText('1')).toBeTruthy()
    expect(within(tab('In transit')).getByText('2')).toBeTruthy()
    expect(within(tab('Delivered')).getByText('1')).toBeTruthy()
    expect(within(tab('Canceled')).getByText('0')).toBeTruthy()
  })

  it('lists only the selected tab’s shipments', async () => {
    renderBoard()
    await waitFor(() => expect(screen.getByText('S000001')).toBeTruthy())

    fireEvent.click(tab('In transit'))
    await waitFor(() => expect(screen.queryByText('S000001')).toBeNull())
    expect(screen.getByText('S000003')).toBeTruthy()
    expect(screen.getByText('S000005')).toBeTruthy()
    expect(screen.queryByText('S000004')).toBeNull()
  })

  it('narrows the list from the search box', async () => {
    renderBoard()
    await waitFor(() => expect(screen.getByText('S000003')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('Search shipments'), { target: { value: 'globex denver' } })
    await waitFor(() => expect(screen.queryByText('S000001')).toBeNull())
    expect(screen.getByText('S000003')).toBeTruthy()
    expect(screen.getByText('S000004')).toBeTruthy()
  })

  it('tells the user when the current view is empty', async () => {
    renderBoard()
    await waitFor(() => expect(screen.getByText('S000001')).toBeTruthy())

    fireEvent.click(tab('Canceled'))
    await waitFor(() => expect(screen.getByText('No shipments in this view.')).toBeTruthy())
  })

  it('cancels a shipment from the row menu with the row’s own CAS token', async () => {
    renderBoard()
    await waitFor(() => expect(screen.getByText('S000002')).toBeTruthy())

    const menus = screen.getAllByLabelText('Shipment actions')
    fireEvent.pointerDown(menus[1], { button: 0, ctrlKey: false, pointerType: 'mouse' })
    await waitFor(() => expect(screen.getByText('Cancel')).toBeTruthy())
    fireEvent.click(screen.getByText('Cancel'))

    await waitFor(() => expect(screen.getByText('Cancel shipment')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Customer pulled the freight' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

    await waitFor(() => expect(setShipmentStatus).toHaveBeenCalledWith({
      shipmentId: 'S000002',
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
      status: 'CANCELED',
      reason: 'Customer pulled the freight',
    }))
  })
})
