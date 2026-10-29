// @vitest-environment jsdom
/**
 * The Rate field on a shipment-linked load is a mirror, not a number of its own.
 *
 * It is written by RECALC_CHARGES, which rewrites the customer linehaul, the order's
 * revenue and the mirror together — so the sync must happen BEFORE the load is written,
 * or a sync that fails leaves a saved load whose money nobody moved. Clearing the box
 * means zero, which the form used to turn into NaN and refuse to save at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import type { Load } from '@/types'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

const order: string[] = []
const syncMock = vi.fn(async () => { order.push('sync'); return true })
const updateLoadMock = vi.fn(async () => { order.push('update') })

vi.mock('@/features/shipments/loadRateSync', () => ({
  syncLoadRateToShipment: (...args: unknown[]) => syncMock(...(args as [])),
}))
vi.mock('@/features/pods/LoadPods', () => ({ LoadPods: () => null }))
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { email: 'a@b.c' }, isAdmin: true, isOwner: true }),
  useAuthUser: () => ({ email: 'a@b.c' }),
}))
vi.mock('@/hooks/useDirectory', () => ({
  useDirectory: () => ({
    customers: [], locations: [], loading: false, error: null,
    refresh: vi.fn(), addCustomer: vi.fn(), addLocation: vi.fn(),
    saveCustomer: vi.fn(), saveLocation: vi.fn(),
    archiveCustomer: vi.fn(), archiveLocation: vi.fn(),
  }),
}))

let state: Record<string, unknown> = {}
vi.mock('@/store/useAppStore', () => ({
  useAppStore: (sel: (s: Record<string, unknown>) => unknown) => sel(state),
}))

const stops = [
  { id: 's1', type: 'pickup', sequence: 0, name: 'Shipper', appt: '2026-03-02T14:00:00.000Z', apptType: 'exact', driverId: null },
  { id: 's2', type: 'delivery', sequence: 1, name: 'Consignee', appt: '2026-03-03T14:00:00.000Z', apptType: 'exact', driverId: null },
]

const load = {
  id: 'l1', shipmentId: 'shp-1', aljexId: '55501', tmsId: 'PO-9', pickupNumber: 'PU-1',
  customer: 'Metz', rate: 100000, stops,
  readyToInvoice: false, active: true, createdAt: '', updatedAt: '',
} as unknown as Load

const { LoadDrawer } = await import('./LoadDrawer')

beforeEach(() => {
  order.length = 0
  syncMock.mockClear()
  updateLoadMock.mockClear()
  state = {
    loads: [load], drivers: [], equipment: [], selectedLoadId: 'l1', drawerMode: 'edit',
    createPreFill: null, setSelectedLoad: vi.fn(), pendingIntakeItemId: null,
    setPendingIntakeItem: vi.fn(), updateLoad: updateLoadMock, addLoad: vi.fn(),
    maintenanceInvoices: [], intakeItems: [],
  }
})

describe('shipment-linked load save', () => {
  it('syncs the rate before writing the load', async () => {
    render(<LoadDrawer />)
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '1500' } })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))

    await waitFor(() => expect(updateLoadMock).toHaveBeenCalled())
    expect(syncMock).toHaveBeenCalledWith('shp-1', 'l1', 150000)
    expect(order).toEqual(['sync', 'update'])
  })

  it('treats a cleared rate as zero on the linehaul', async () => {
    render(<LoadDrawer />)
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))

    await waitFor(() => expect(updateLoadMock).toHaveBeenCalled())
    expect(syncMock).toHaveBeenCalledWith('shp-1', 'l1', 0)
    expect(order).toEqual(['sync', 'update'])
  })
})
