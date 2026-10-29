// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type * as AuthModule from '@/hooks/useAuth'
import type { ShipmentViewRecord } from '@/types/tms'
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

/** Noon today, local — what "picking up today" means to the quick-tab. */
const today = () => {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).toISOString()
}

const shipments: ShipmentRow[] = [
  row('S000001', { status: 'DRAFT', searchKey: 's000001 acme freight chicago il' }),
  row('S000002', {
    status: 'OPEN',
    searchKey: 's000002 acme freight dallas tx',
    pickupAppt: today(),
    revDivision: 'ASSETS',
    revSubdivision: 'BOX_TRUCK',
    salesRepId: 'pavel',
  }),
  row('S000003', {
    status: 'IN_TRANSIT',
    searchKey: 's000003 globex denver co',
    customerName: 'Globex',
    revDivision: 'BROKERAGE',
  }),
  row('S000004', { status: 'DELIVERED', searchKey: 's000004 globex denver co', customerName: 'Globex' }),
  row('S000005', { status: 'UNLOADING', searchKey: 's000005 initech boise id', customerName: 'Initech' }),
  row('S000006', {
    status: 'DELIVERED',
    searchKey: 's000006 acme freight voided',
    voidedAt: '2026-02-01T00:00:00.000Z',
    voidedBy: 'ryne@bcatcorp.com',
    voidReason: 'Billed twice by mistake',
  }),
]

const views: ShipmentViewRecord[] = [{
  id: 'brokerage-board',
  slug: 'brokerage-board',
  name: 'Brokerage board',
  department: 'Brokerage',
  description: null,
  filters: { divisions: ['BROKERAGE'] },
  columns: null,
  sort: null,
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

const { auth } = vi.hoisted(() => ({ auth: { isAdmin: true, isOwner: false } }))
vi.mock('@/hooks/useAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthModule>()),
  useAuth: () => ({ ...auth, user: { email: 'ryne@bcatcorp.com', userId: 'ryne', groups: ['ADMIN'] } }),
  useAuthUser: () => ({ email: 'ryne@bcatcorp.com', userId: 'ryne', groups: ['ADMIN'] }),
}))
vi.mock('@/hooks/useDirectory', () => ({ useDirectory: () => ({ customers: [], locations: [] }) }))
vi.mock('@/hooks/useShipments', () => ({
  useShipments: () => ({ shipments, loading: false, error: null, refresh: vi.fn() }),
}))
vi.mock('@/hooks/useStaff', () => ({
  useStaff: () => ({
    staff: [], byId: {}, loading: false, error: null, refresh: vi.fn(),
    nameOf: (id: string | null) => (id ? `Rep ${id}` : '—'),
  }),
}))
vi.mock('@/features/tms/useShipmentViews', () => ({
  useShipmentViews: () => ({ views, loading: false, error: null, refresh: vi.fn() }),
  useOwnershipDivisions: () => ({
    divisions: [
      { code: 'ASSETS', name: 'Ivan Cartage', color: '#1ba774' },
      { code: 'BOX_TRUCK', name: 'Box trucks', color: '#0a81ff' },
      { code: 'BROKERAGE', name: 'BCAT Logistics', color: '#f4c50c' },
    ],
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}))
const { setShipmentStatus } = vi.hoisted(() => ({ setShipmentStatus: vi.fn(async () => ({})) }))
vi.mock('@/lib/apiClient', () => ({
  getTmsSettings: vi.fn(async () => null),
  createShipment: vi.fn(),
  duplicateShipment: vi.fn(),
  saveShipmentView: vi.fn(),
  setShipmentStatus,
  tenderRespond: vi.fn(),
  voidShipment: vi.fn(),
  graphqlErrorText: () => '',
  listDocumentReviewQueue: vi.fn(async () => []),
}))
vi.mock('./components/ShipmentDrawer', () => ({ ShipmentDrawer: () => null }))
// The row that opens it is covered in ShipmentsBoard.unlinked.test.tsx; here it would
// only drag the whole load-editing tree into a test about the board.
vi.mock('@/features/loads/LoadDrawer', () => ({ LoadDrawer: () => null }))

function renderBoard(path = '/tms/shipments') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/tms/shipments" element={<ShipmentsBoard />} />
        <Route path="/tms/shipments/view/:slug" element={<ShipmentsBoard />} />
      </Routes>
    </MemoryRouter>,
  )
}

/** The status quick-tabs are the second tablist; the first is the saved views. */
function tab(name: string): HTMLElement {
  const lists = screen.getAllByRole('tablist')
  return within(lists[lists.length - 1]).getByRole('tab', { name: new RegExp(`^${name}`) })
}

function rowMenu(id: string): HTMLElement {
  const rowEl = screen.getByText(id).closest('tr')
  if (!rowEl) throw new Error(`no row for ${id}`)
  return within(rowEl).getByLabelText('Shipment actions')
}

describe('ShipmentsBoard', () => {
  it('counts MVMNT’s quick-tab groups', async () => {
    renderBoard()
    await waitFor(() => expect(screen.getByText('Shipments')).toBeTruthy())

    expect(within(tab("Today's Open")).getByText('1')).toBeTruthy()
    expect(within(tab('In Transit')).getByText('1')).toBeTruthy()
    expect(within(tab('Unload')).getByText('1')).toBeTruthy()
    expect(within(tab('Del')).getByText('1')).toBeTruthy()
    // The voided shipment is in the book but out of every working tab.
    expect(within(tab('All')).getByText('5')).toBeTruthy()
    expect(within(tab('Voided')).getByText('1')).toBeTruthy()
  })

  it('lists only the selected tab’s shipments', async () => {
    renderBoard()
    await waitFor(() => expect(screen.getByText('S000001')).toBeTruthy())

    fireEvent.click(tab('In Transit'))
    await waitFor(() => expect(screen.queryByText('S000001')).toBeNull())
    expect(screen.getByText('S000003')).toBeTruthy()
    expect(screen.queryByText('S000005')).toBeNull()
  })

  it('shows a voided shipment only under Voided, with who, when and why', async () => {
    renderBoard()
    await waitFor(() => expect(screen.getByText('S000001')).toBeTruthy())
    expect(screen.queryByText('S000006')).toBeNull()

    fireEvent.click(tab('Voided'))
    await waitFor(() => expect(screen.getByText('S000006')).toBeTruthy())
    expect(screen.queryByText('S000001')).toBeNull()

    const badge = screen.getByText('VOIDED')
    expect(badge.getAttribute('title')).toContain('ryne@bcatcorp.com')
    expect(badge.getAttribute('title')).toContain('Billed twice by mistake')
  })

  it('narrows the list from the search box', async () => {
    renderBoard()
    await waitFor(() => expect(screen.getByText('S000003')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'globex denver' } })
    await waitFor(() => expect(screen.queryByText('S000001')).toBeNull())
    expect(screen.getByText('S000003')).toBeTruthy()
    expect(screen.getByText('S000004')).toBeTruthy()
  })

  it('opens the view named in the URL and filters to it', async () => {
    renderBoard('/tms/shipments/view/brokerage-board')
    await waitFor(() => expect(screen.getByText('S000003')).toBeTruthy())

    expect(screen.queryByText('S000002')).toBeNull()
    expect(screen.getByRole('tab', { name: 'Brokerage board' }).getAttribute('aria-selected')).toBe('true')
  })

  it('filters to one division from the sidebar’s synthetic view', async () => {
    renderBoard('/tms/shipments/view/division-ASSETS')
    await waitFor(() => expect(screen.getByText('S000002')).toBeTruthy())
    expect(screen.queryByText('S000003')).toBeNull()
  })

  it('chips the division with its name, its subsidiary and its colour', async () => {
    renderBoard()
    await waitFor(() => expect(screen.getByText('S000002')).toBeTruthy())

    const chip = screen.getByText('Ivan Cartage (Box trucks)')
    expect(chip.dataset.testid).toBe('board-division')
    expect(chip.style.color).toBe('rgb(27, 167, 116)')
  })

  it('names the rep behind the id', async () => {
    renderBoard()
    await waitFor(() => expect(screen.getByText('Rep pavel')).toBeTruthy())
  })

  it('offers Save as view to an admin and to nobody else', async () => {
    const admin = renderBoard()
    await waitFor(() => expect(screen.getByLabelText('Save as view')).toBeTruthy())
    admin.unmount()

    auth.isAdmin = false
    auth.isOwner = false
    renderBoard()
    await waitFor(() => expect(screen.getByText('Shipments')).toBeTruthy())
    expect(screen.queryByLabelText('Save as view')).toBeNull()
    auth.isAdmin = true
  })

  it('never says “Order” anywhere on the page', async () => {
    renderBoard()
    await waitFor(() => expect(screen.getByText('S000001')).toBeTruthy())
    expect(screen.queryByText(/\bOrder\b/)).toBeNull()
  })

  it('cancels a shipment from the row menu with the row’s own CAS token', async () => {
    renderBoard()
    await waitFor(() => expect(screen.getByText('S000002')).toBeTruthy())

    fireEvent.pointerDown(rowMenu('S000002'), { button: 0, ctrlKey: false, pointerType: 'mouse' })
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

  it('offers Void to an admin, and no delete to anybody', async () => {
    const admin = renderBoard()
    await waitFor(() => expect(screen.getByText('S000002')).toBeTruthy())
    fireEvent.pointerDown(rowMenu('S000002'), { button: 0, ctrlKey: false, pointerType: 'mouse' })
    await waitFor(() => expect(screen.getByText(/Void shipment/)).toBeTruthy())
    expect(screen.queryByText(/Delete/)).toBeNull()
    expect(screen.queryByText(/Restore/)).toBeNull()
    admin.unmount()

    auth.isAdmin = false
    renderBoard()
    await waitFor(() => expect(screen.getByText('S000002')).toBeTruthy())
    fireEvent.pointerDown(rowMenu('S000002'), { button: 0, ctrlKey: false, pointerType: 'mouse' })
    await waitFor(() => expect(screen.getByText('Duplicate')).toBeTruthy())
    expect(screen.queryByText(/Void shipment/)).toBeNull()
    auth.isAdmin = true
  })
})
