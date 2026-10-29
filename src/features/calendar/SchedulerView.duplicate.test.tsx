// @vitest-environment jsdom
/**
 * Duplicating a leg on the scheduler duplicates its SHIPMENT.
 *
 * The old version spread the whole Load — `shipmentId` included — into a bare create, so a
 * shipment-born leg duplicated here became a phantom extra leg under the SOURCE shipment
 * rather than a shipment of its own. It also stamped the copy `<pro>-copy`, which a PRO
 * claim refuses on the second duplicate because a PRO is never reissued. And it copied
 * `source.loads[0]` server-side, which is the wrong leg whenever somebody right-clicked
 * the second one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { Load } from '@/types'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

const duplicateShipmentMock = vi.fn()
vi.mock('@/lib/apiClient', () => ({
  duplicateShipment: (...a: unknown[]) => duplicateShipmentMock(...a),
  getTmsSettings: async () => null,
}))

/*
 * FullCalendar needs a real layout engine, which jsdom is not. The stub keeps the one
 * thing this test is about: the event card it would have rendered, so the right-click that
 * raises the context menu is reachable.
 */
vi.mock('@fullcalendar/react', () => ({
  default: ({ events, eventContent }: {
    events: Array<{ id: string; extendedProps: Record<string, unknown> }>
    eventContent: (info: { event: { id: string; extendedProps: Record<string, unknown> } }) => React.ReactNode
  }) => <div>{events.map((e) => <div key={e.id}>{eventContent({ event: e })}</div>)}</div>,
}))
vi.mock('@fullcalendar/resource-timeline', () => ({ default: {} }))
vi.mock('@fullcalendar/interaction', () => ({ default: {} }))

vi.mock('./EventCard', () => ({
  EventCard: ({ load, onContextMenu }: { load: Load; onContextMenu: (e: React.MouseEvent) => void }) => (
    <button type="button" aria-label={`leg ${load.id}`} onContextMenu={onContextMenu}>{load.aljexId}</button>
  ),
}))

vi.mock('@/features/shipments/components/ShipmentDrawer', () => ({
  ShipmentDrawer: ({ shipmentId }: { shipmentId: string | null }) =>
    shipmentId ? <div data-testid="shipment-detail">{shipmentId}</div> : null,
}))

vi.mock('@/hooks/useLoads', () => ({ useLoads: () => ({ loads: [], allLoads: [], updateLoad: vi.fn() }) }))
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { email: 'ryne@bcatcorp.com' }, isAdmin: true, isOwner: true }),
  useAuthUser: () => ({ email: 'ryne@bcatcorp.com' }),
}))
vi.mock('@/hooks/useDirectory', () => ({
  useDirectory: () => ({
    customers: [], locations: [], loading: false, error: null,
    refresh: vi.fn(), addCustomer: vi.fn(), addLocation: vi.fn(),
    saveCustomer: vi.fn(), saveLocation: vi.fn(),
    archiveCustomer: vi.fn(), archiveLocation: vi.fn(),
  }),
}))
vi.mock('@/store/useAppStore', () => ({
  useAppStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ setSelectedLoad: vi.fn(), openNewShipment: vi.fn() }),
}))

const { SchedulerView } = await import('./SchedulerView')

/** The SECOND leg of a two-leg shipment — the one the operator right-clicks. */
const legTwo = {
  id: 'load-2', shipmentId: 'shp-1', aljexId: 'BC100100-2',
  pickupAppt: '2026-10-12T14:00:00.000Z', deliveryAppt: '2026-10-13T14:00:00.000Z',
  pickupDriverId: 'drv-1', readyToInvoice: false, customer: 'Metz', createdAt: '', updatedAt: '',
} as unknown as Load

beforeEach(() => {
  duplicateShipmentMock.mockReset()
  duplicateShipmentMock.mockResolvedValue({
    shipment: { id: 'shp-1' }, orders: [], loads: [], created: ['shp-2'],
  })
})

const renderScheduler = () =>
  render(
    <SchedulerView
      calendarRef={{ current: null }}
      loads={[legTwo]}
      drivers={[]}
      conflictIds={new Set()}
      filterDriverId={null}
      viewMode="week"
      weekStart="2026-10-12"
      onDatesSet={vi.fn()}
    />,
  )

const duplicateLeg = async () => {
  fireEvent.contextMenu(screen.getByRole('button', { name: 'leg load-2' }))
  fireEvent.click(await screen.findByText('Duplicate'))
}

describe('scheduler duplicate', () => {
  it('duplicates the shipment through the clicked leg, keeping the driver', async () => {
    renderScheduler()
    await duplicateLeg()

    await waitFor(() => expect(duplicateShipmentMock).toHaveBeenCalledTimes(1))
    expect(duplicateShipmentMock.mock.calls[0][0]).toMatchObject({
      shipmentId: 'shp-1',
      loadId: 'load-2',
      keepDriver: true,
    })
  })

  /*
   * The copy takes a derived PRO from the counter. `<pro>-copy` collided on the second
   * duplicate once a PRO became a permanent claim, and it was never an Aljex number
   * anyway.
   */
  it('never stamps a -copy PRO', async () => {
    renderScheduler()
    await duplicateLeg()

    await waitFor(() => expect(duplicateShipmentMock).toHaveBeenCalledTimes(1))
    expect(JSON.stringify(duplicateShipmentMock.mock.calls[0][0])).not.toContain('-copy')
  })

  it('opens the copy on its own shipment detail', async () => {
    renderScheduler()
    await duplicateLeg()

    await waitFor(() => expect(screen.getByTestId('shipment-detail').textContent).toBe('shp-2'))
  })
})
