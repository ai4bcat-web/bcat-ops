// @vitest-environment jsdom
/** Tracking must distinguish verified live links from provider settings and preserve the check-call workflow. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { TrackingWorkstation } from './TrackingWorkstation'
import type { ShipmentRow } from '../shipmentViews'
import type { ShipmentBundle, ShipmentViewRecord, TrackingLinkRecord } from '@/types/tms'

const now = Date.parse('2026-10-29T12:00:00Z')
const api = vi.hoisted(() => ({
  getShipmentBundle: vi.fn(), getTmsSettings: vi.fn(), listCarrierPingLinks: vi.fn(),
  listTrackingLinksByShipment: vi.fn(), logCheckCall: vi.fn(), textDriver: vi.fn(),
  saveShipmentView: vi.fn(), archiveShipmentView: vi.fn(),
  sendTrackingLink: vi.fn(), revokeTrackingLink: vi.fn(),
}))
vi.mock('@/lib/apiClient', () => api)
const refresh = vi.fn(async () => {})
const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn() } }))
let shipments: ShipmentRow[] = []
const views: ShipmentViewRecord[] = []
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({
  user: { email: 'rep@bcatcorp.com', groups: ['ADMIN'] }, isAdmin: true, isOwner: false,
}) }))
vi.mock('@/hooks/useDirectory', () => ({ useDirectory: () => ({ customers: [], locations: [] }) }))
vi.mock('@/hooks/useShipments', () => ({ useShipments: () => ({ shipments, loading: false, error: null, refresh }) }))
vi.mock('@/hooks/useStaff', () => ({ useStaff: () => ({ nameOf: () => 'Dana Carr', me: null }) }))
vi.mock('@/features/tms/useShipmentViews', () => ({ useShipmentViews: () => ({ views, refresh }) }))

function row(id: string, patch: Partial<ShipmentRow> = {}): ShipmentRow {
  return {
    id, number: id, status: 'DISPATCHED', customerId: 'cust-1', customerName: 'Acme Freight',
    mode: 'FTL', source: 'MANUAL', originCity: 'Austin, TX', destinationCity: 'Dallas, TX',
    pickupAppt: '2026-10-29T14:00:00Z', deliveryAppt: '2026-10-30T10:00:00Z',
    createdBy: 'rep@bcatcorp.com', updatedBy: 'rep@bcatcorp.com',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...patch,
  }
}
const active = row('S001', {
  lastUpdateAt: '2026-10-29T11:00:00Z', lastUpdatePlace: 'Waco, TX', trackingProvider: 'LINK',
  nextCheckCallAt: '2026-10-29T09:00:00Z', dispatcherAssignedId: 'rep-1',
})
const delivered = row('S002', { status: 'DELIVERED', deliveredAt: '2026-10-29T10:00:00Z' })
const liveLink = {
  id: 'link-1', shipmentId: active.id, kind: 'CARRIER_PING', status: 'ACTIVE',
  expiresAt: '2026-10-30T12:00:00Z', loadId: 'load-1', loadCarrierId: 'carrier-1',
} as TrackingLinkRecord
const bundle: ShipmentBundle = {
  shipment: active, loads: [{ id: 'load-1', shipmentId: active.id, loadNumber: 'S001-1', status: 'DISPATCHED', updatedAt: '2026-10-29T11:00:00Z', stops: [] }],
  orders: [], loadCarriers: [], charges: [], financials: [], documents: [],
}

function Destination() {
  const location = useLocation()
  return <p>{location.pathname}{location.search}</p>
}
function renderPage() {
  return render(<MemoryRouter initialEntries={['/tms/tracking']}><Routes>
    <Route path="/tms/tracking" element={<TrackingWorkstation />} />
    <Route path="/tms/shipments/:id" element={<Destination />} />
  </Routes></MemoryRouter>)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.setSystemTime(now)
  localStorage.clear()
  shipments = [active, delivered]
  api.getTmsSettings.mockResolvedValue(null)
  api.listCarrierPingLinks.mockResolvedValue([liveLink])
  api.getShipmentBundle.mockResolvedValue(bundle)
  api.listTrackingLinksByShipment.mockResolvedValue([liveLink])
  api.logCheckCall.mockResolvedValue({ bundle, event: null })
  api.saveShipmentView.mockResolvedValue({ slug: 'evening-desk' })
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('TrackingWorkstation', () => {
  it('moves delivered and voided shipments into Closed and back out of Active', async () => {
    shipments.push(row('S003', { status: 'DISPATCHED', voidedAt: '2026-10-28T12:00:00Z' }))
    renderPage()
    expect(screen.getByText('S001')).toBeVisible()
    expect(screen.queryByText('S002')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Closed', exact: true }))
    expect(screen.getByText('S002')).toBeVisible()
    expect(screen.getByText('S003')).toBeVisible()
    expect(screen.queryByText('S001')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Active', exact: true }))
    expect(screen.getByText('S001')).toBeVisible()
    expect(screen.queryByText('S002')).not.toBeInTheDocument()
    expect(screen.queryByText('S003')).not.toBeInTheDocument()
    await waitFor(() => expect(api.listCarrierPingLinks).toHaveBeenCalled())
  })

  it('shows verified tracking, last location and age without inventing motion or source', async () => {
    renderPage()
    const cell = screen.getByRole('cell', { name: /Waco, TX/ })
    expect(await within(cell).findByText('Tracking')).toBeVisible()
    expect(cell).toHaveTextContent('Waco, TX, 1 h ago')
    expect(cell).toHaveTextContent('Latest ping source unavailable')
    expect(screen.getByText('No signal')).toBeVisible()
    expect(screen.getByText('Overdue')).toBeVisible()
    expect(screen.getByText('Dana Carr')).toBeVisible()
    expect(screen.getByText('Pickup starts in 2 h')).toBeVisible()
  })

  it('does not call an expired or revoked link live even when the provider is LINK', async () => {
    api.listCarrierPingLinks.mockResolvedValue([
      { ...liveLink, expiresAt: '2026-10-29T11:59:00Z' },
      { ...liveLink, id: 'revoked', status: 'REVOKED' },
    ])
    renderPage()
    await waitFor(() => expect(api.listCarrierPingLinks).toHaveBeenCalled())
    const cell = screen.getByRole('cell', { name: /Waco, TX/ })
    expect(within(cell).queryByText('Tracking', { exact: true })).not.toBeInTheDocument()
  })

  it('opens the shipment Tracking tab rather than the default Overview tab', async () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'S001' }))
    expect(screen.getByText('/tms/shipments/S001?tab=tracking')).toBeVisible()
  })

  it('logs a check call without requiring a carrier assignment', async () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Log check call for S001' }))
    const dialog = await screen.findByRole('dialog', { name: 'Log check call' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Log check call', exact: true }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.logCheckCall).toHaveBeenCalledWith(expect.objectContaining({ loadId: 'load-1', expectedUpdatedAt: '2026-10-29T11:00:00Z', type: 'LOCATION_UPDATE' }))
    expect(refresh).toHaveBeenCalled()
  })

  it('keeps a failed check-call form open and reports the server error', async () => {
    api.logCheckCall.mockRejectedValueOnce(new Error('Load changed; reload it'))
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Log check call for S001' }))
    const dialog = await screen.findByRole('dialog', { name: 'Log check call' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Log check call', exact: true }))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Load changed; reload it'))
    expect(dialog).toBeVisible()
  })

  it('saves the working filters from the panel rather than leaving Save as view inert', async () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Closed', exact: true }))
    fireEvent.click(screen.getByRole('button', { name: /Save as view/i }))
    const dialog = await screen.findByRole('dialog', { name: 'Save tracking view' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'View name' }), { target: { value: 'Evening desk' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save view' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.saveShipmentView).toHaveBeenCalledWith(expect.objectContaining({ name: 'Evening desk', filters: { board: expect.objectContaining({ statuses: ['DELIVERED', 'VOIDED'] }) } }))
  })
})
