// @vitest-environment jsdom
/**
 * Step R's gap, end to end: a Load that no Shipment ever claimed is read off the API by
 * `useShipments`, lands on this board as its own row, is found by its PRO, and opens
 * something real when it is clicked. There is no shipment to open and no
 * `/tms/shipments/:id` page to navigate to, so the row opens the legacy load drawer —
 * the same drawer the calendar and the factoring queue open — which means that drawer
 * has to be mounted on this route.
 *
 * The hook is deliberately *not* mocked here: the projection and the board are the two
 * halves of the same promise, and a fixture row would prove only the half below it.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type * as AuthModule from '@/hooks/useAuth'
import type { LoadBoardSummary } from '@/lib/apiClient'
import type { ShipmentRecord } from '@/types/tms'
import { ShipmentsBoard } from './ShipmentsBoard'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

const shipment: ShipmentRecord = {
  id: 'shp-1',
  number: 'S000001',
  status: 'OPEN',
  customerId: 'cust-1',
  customerName: 'Acme Freight',
  mode: 'FTL',
  source: 'MANUAL',
  createdBy: 'a@b.c',
  updatedBy: 'a@b.c',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

/** One of the two loads dev has with no shipment, as `listLoadSummaries` returns it. */
const orphanLoad: LoadBoardSummary = {
  id: 'lod-orphan',
  shipmentId: null,
  aljexId: '14865  ',
  customer: 'DIRECT DRIVE LOGISTICS',
  rate: 75000,
  pickupAppt: '2026-10-28T14:00:00.000Z',
}

const { data, setSelectedLoad } = vi.hoisted(() => ({
  data: { loads: [] as unknown[] },
  setSelectedLoad: vi.fn(),
}))

vi.mock('@/hooks/useAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthModule>()),
  useAuth: () => ({ isAdmin: true, isOwner: false, user: { email: 'ryne@bcatcorp.com', userId: 'ryne', groups: ['ADMIN'] } }),
  useAuthUser: () => ({ email: 'ryne@bcatcorp.com', userId: 'ryne', groups: ['ADMIN'] }),
}))
vi.mock('@/hooks/useDirectory', () => ({ useDirectory: () => ({ customers: [], locations: [] }) }))
vi.mock('@/hooks/useStaff', () => ({
  useStaff: () => ({
    staff: [], byId: {}, loading: false, error: null, refresh: vi.fn(),
    nameOf: (id: string | null) => id ?? '—',
  }),
}))
vi.mock('@/features/tms/useShipmentViews', () => ({
  useShipmentViews: () => ({ views: [], loading: false, error: null, refresh: vi.fn() }),
  useOwnershipDivisions: () => ({ divisions: null, loading: false, error: null, refresh: vi.fn() }),
}))
vi.mock('@/lib/apiClient', () => ({
  listShipments: vi.fn(async () => [shipment]),
  listShipmentsByStatus: vi.fn(async () => [shipment]),
  listShipmentsByCustomer: vi.fn(async () => [shipment]),
  listShipmentsByMonth: vi.fn(async () => [shipment]),
  listOrders: vi.fn(async () => []),
  listLoadSummaries: vi.fn(async () => data.loads),
  listLoadCarriers: vi.fn(async () => []),
  listQuotes: vi.fn(async () => []),
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
vi.mock('@/store/useAppStore', () => ({
  useAppStore: (select: (state: unknown) => unknown) => select({ setSelectedLoad }),
}))
vi.mock('./components/ShipmentDrawer', () => ({ ShipmentDrawer: () => null }))
// Stubbed for its identity only: the test asks whether the board mounts it, not what it
// renders — the real one drags the whole load-editing tree into a board test.
vi.mock('@/features/loads/LoadDrawer', () => ({ LoadDrawer: () => <div data-testid="load-drawer" /> }))

function renderBoard() {
  return render(
    <MemoryRouter initialEntries={['/tms/shipments']}>
      <Routes>
        <Route path="/tms/shipments" element={<ShipmentsBoard />} />
        <Route path="/tms/shipments/view/:slug" element={<ShipmentsBoard />} />
        <Route path="/tms/shipments/:id" element={<p>shipment detail page</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

function rowFor(text: string): HTMLElement {
  const cell = screen.getByText(text).closest('tr')
  if (!cell) throw new Error(`no row for ${text}`)
  return cell
}

describe('ShipmentsBoard — loads with no shipment', () => {
  it('lists the load under its own PRO and finds it by that PRO', async () => {
    data.loads = [orphanLoad]
    renderBoard()
    // The PRO is stored with trailing spaces; the row shows the number, not the blanks.
    await waitFor(() => expect(screen.getByText('14865')).toBeTruthy())
    expect(screen.getByText('DIRECT DRIVE LOGISTICS')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Search'), { target: { value: '14865' } })
    await waitFor(() => expect(screen.queryByText('S000001')).toBeNull())
    expect(screen.getByText('14865')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'direct drive' } })
    await waitFor(() => expect(screen.getByText('14865')).toBeTruthy())
  })

  it('opens the load drawer for the row, and mounts the drawer that answers it', async () => {
    data.loads = [orphanLoad]
    setSelectedLoad.mockClear()
    renderBoard()
    await waitFor(() => expect(screen.getByText('14865')).toBeTruthy())

    expect(screen.getByTestId('load-drawer')).toBeTruthy()
    fireEvent.click(screen.getByText('14865'))
    expect(setSelectedLoad).toHaveBeenCalledWith('lod-orphan', 'view')
  })

  it('never sends an unlinked load to a shipment page it does not have', async () => {
    data.loads = [orphanLoad]
    setSelectedLoad.mockClear()
    renderBoard()
    await waitFor(() => expect(screen.getByText('14865')).toBeTruthy())

    fireEvent.doubleClick(screen.getByText('14865'))
    expect(screen.queryByText('shipment detail page')).toBeNull()
    expect(setSelectedLoad).toHaveBeenCalledWith('lod-orphan', 'view')

    fireEvent.doubleClick(screen.getByText('S000001'))
    await waitFor(() => expect(screen.getByText('shipment detail page')).toBeTruthy())
  })

  it('offers no shipment actions on a row that is not a shipment', async () => {
    data.loads = [orphanLoad]
    renderBoard()
    await waitFor(() => expect(screen.getByText('14865')).toBeTruthy())

    expect(within(rowFor('S000001')).getByLabelText('Shipment actions')).toBeTruthy()
    expect(within(rowFor('14865')).queryByLabelText('Shipment actions')).toBeNull()
  })

  it('says what an unlinked load is, and only while the list holds one', async () => {
    data.loads = [orphanLoad]
    const withOrphan = renderBoard()
    await waitFor(() => expect(screen.getByText('14865')).toBeTruthy())
    expect(screen.getByText(/no customer record is matched to it/i)).toBeTruthy()
    expect(within(rowFor('14865')).getByText('Unlinked load')).toBeTruthy()
    withOrphan.unmount()

    data.loads = []
    renderBoard()
    await waitFor(() => expect(screen.getByText('S000001')).toBeTruthy())
    expect(screen.queryByText(/no customer record is matched to it/i)).toBeNull()
  })

  it('keeps a voided load off the live tabs and shows it under Voided', async () => {
    data.loads = [orphanLoad, { ...orphanLoad, id: 'lod-void', aljexId: '14864', voidedAt: '2026-10-29T00:00:00.000Z' }]
    renderBoard()
    await waitFor(() => expect(screen.getByText('14865')).toBeTruthy())
    expect(screen.queryByText('14864')).toBeNull()

    const lists = screen.getAllByRole('tablist')
    fireEvent.click(within(lists[lists.length - 1]).getByRole('tab', { name: /^Voided/ }))
    await waitFor(() => expect(screen.getByText('14864')).toBeTruthy())
    expect(screen.queryByText('14865')).toBeNull()
  })
})
