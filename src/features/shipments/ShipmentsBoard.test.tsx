// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, fireEvent, waitFor, act } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { useState } from 'react'
import { ShipmentsBoard } from './ShipmentsBoard'
import type { ShipmentRow } from './shipmentViews'
import type { ShipmentViewRecord, OrderRecord } from '@/types/tms'
import type { Load } from '@/types'

// Force the tab strip to show every tab; its ResizeObserver would otherwise collapse
// everything into the overflow menu under jsdom's zero-width container.
globalThis.ResizeObserver = undefined as unknown as typeof ResizeObserver
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

function row(id: string, patch: Partial<ShipmentRow> = {}): ShipmentRow {
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
  } as ShipmentRow
}

function deliveredRow(id: string, patch: Partial<ShipmentRow> = {}): ShipmentRow {
  return row(id, {
    status: 'DELIVERED',
    docsMissing: [],
    revenueCents: 100_000,
    costCents: 80_000,
    profitCents: 20_000,
    marginBps: 2000,
    stops: [{ type: 'pickup', departedAt: '2026-01-02T00:00:00Z' }, { type: 'delivery', departedAt: '2026-01-03T00:00:00Z' }] as unknown as ShipmentRow['stops'],
    ...patch,
  })
}

const customers = [
  { id: 'cust-1', name: 'Acme Freight' },
  { id: 'cust-2', name: 'Globex' },
]

const views: ShipmentViewRecord[] = [
  {
    id: 'active-shipments',
    slug: 'active-shipments',
    name: 'Active Shipments',
    department: 'Shipments',
    description: null,
    filters: {
      board: {
        statuses: ['OPEN', 'COVERED', 'DISPATCHED', 'ARRIVED', 'DEPARTED', 'DELIVERED'],
        details: {},
        dates: {},
      },
    },
    columns: null,
    sort: null,
    isDefault: true,
    audience: null,
    sortOrder: 0,
    active: true,
    createdBy: 'a@b.c',
    updatedBy: 'a@b.c',
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'all-shipments',
    slug: 'all-shipments',
    name: 'All Shipments',
    department: 'Shipments',
    description: null,
    filters: {
      board: {
        statuses: [],
        details: {},
        dates: {},
      },
    },
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
  },
]

const statusOnlyView: ShipmentViewRecord = {
  id: 'status-only',
  slug: 'status-only',
  name: 'Status Only',
  department: 'Shipments',
  description: null,
  filters: { board: { statuses: ['OPEN'], details: {}, dates: {} } },
  columns: ['status'],
  sort: null,
  isDefault: false,
  audience: null,
  sortOrder: 20,
  active: true,
  createdBy: 'a@b.c',
  updatedBy: 'a@b.c',
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

let __views: ShipmentViewRecord[] = views
let __loading = false
let __setViews: React.Dispatch<React.SetStateAction<ShipmentViewRecord[]>> | null = null
let __setLoading: React.Dispatch<React.SetStateAction<boolean>> | null = null

function setMockViews(next: ShipmentViewRecord[], loading = false) {
  __views = next
  __loading = loading
  __setViews?.(next)
  __setLoading?.(loading)
}

const { auth } = vi.hoisted(() => ({ auth: { isAdmin: true, isOwner: false } }))

const {
  setShipmentStatus,
  duplicateShipment,
  tenderRespond,
  readyToInvoice,
  setSalesRep,
  createShipmentForLoad,
  unvoidShipment,
  voidShipment,
  repointShipmentCustomer,
  repointInvoicedCustomer,
  batchShipmentTask,
  resolveRevTag,
  getShipmentBundle,
  getInvoice,
  saveShipmentView,
  archiveShipmentView,
  saveShipmentColumnTemplate,
  deleteShipmentColumnTemplate,
  listOrders,
  listShipmentColumnTemplates,
  saveBlob,
  getTmsSettings,
  graphqlErrorText,
} = vi.hoisted(() => ({
  setShipmentStatus: vi.fn(),
  duplicateShipment: vi.fn(),
  tenderRespond: vi.fn(),
  readyToInvoice: vi.fn(),
  setSalesRep: vi.fn(),
  createShipmentForLoad: vi.fn(),
  unvoidShipment: vi.fn(),
  voidShipment: vi.fn(),
  repointShipmentCustomer: vi.fn(),
  repointInvoicedCustomer: vi.fn(),
  batchShipmentTask: vi.fn(),
  resolveRevTag: vi.fn(),
  getShipmentBundle: vi.fn(),
  getInvoice: vi.fn(),
  saveShipmentView: vi.fn(),
  archiveShipmentView: vi.fn(),
  saveShipmentColumnTemplate: vi.fn(),
  deleteShipmentColumnTemplate: vi.fn(),
  listOrders: vi.fn(async () => []),
  listShipmentColumnTemplates: vi.fn(async () => []),
  saveBlob: vi.fn(),
  getTmsSettings: vi.fn(async () => null),
  graphqlErrorText: vi.fn((err: unknown) => (err instanceof Error ? err.message : 'Error')),
}))

vi.mock('@/hooks/useAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useAuth')>()),
  useAuth: () => ({ ...auth, user: { email: 'ryne@bcatcorp.com', userId: 'ryne', groups: ['ADMIN'] } }),
  useAuthUser: () => ({ email: 'ryne@bcatcorp.com', userId: 'ryne', groups: ['ADMIN'] }),
}))

vi.mock('@/hooks/useDirectory', () => ({
  useDirectory: () => ({ customers, locations: [] }),
}))

const refresh = vi.fn()
let __shipments: ShipmentRow[] = []
vi.mock('@/hooks/useShipments', () => ({
  useShipments: () => ({ shipments: __shipments, loading: false, error: null, refresh }),
}))

let __loads: Load[] = []
vi.mock('@/hooks/useLoads', () => ({
  useLoads: () => ({ allLoads: __loads, loads: [], updateLoad: vi.fn() }),
}))

vi.mock('@/hooks/useStaff', () => ({
  useStaff: () => ({
    staff: [],
    byId: {},
    loading: false,
    error: null,
    refresh: vi.fn(),
    nameOf: (id: string | null) => (id ? `Rep ${id}` : '—'),
    me: null,
  }),
}))

vi.mock('@/features/tms/useShipmentViews', () => ({
  useShipmentViews: () => {
    const [v, setV] = useState(__views)
    const [loading, setLoading] = useState(__loading)
    __setViews = setV
    __setLoading = setLoading
    return { views: v, loading, error: null, refresh: vi.fn() }
  },
  useOwnershipDivisions: () => ({
    divisions: [
      { code: 'ASSETS', name: 'Ivan Cartage', color: '#1ba774' },
      { code: 'BROKERAGE', name: 'BCAT Logistics', color: '#f4c50c' },
    ],
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}))

vi.mock('@/lib/apiClient', () => ({
  listOrders,
  listShipmentColumnTemplates,
  saveShipmentView,
  archiveShipmentView,
  saveShipmentColumnTemplate,
  deleteShipmentColumnTemplate,
  setShipmentStatus,
  duplicateShipment,
  tenderRespond,
  setSalesRep,
  readyToInvoice,
  createShipmentForLoad,
  unvoidShipment,
  voidShipment,
  repointShipmentCustomer,
  repointInvoicedCustomer,
  batchShipmentTask,
  resolveRevTag,
  getShipmentBundle,
  getInvoice,
  getTmsSettings,
  graphqlErrorText,
}))

vi.mock('@/lib/download', () => ({ saveBlob }))

vi.mock('./components/ShipmentDrawer', () => ({ ShipmentDrawer: () => null }))

function renderBoard(path = '/tms/shipments', initialShipments: ShipmentRow[] = []) {
  __shipments = initialShipments
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/tms/shipments" element={<ShipmentsBoard />} />
        <Route path="/tms/shipments/view/:slug" element={<ShipmentsBoard />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('ShipmentsBoard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    auth.isAdmin = true
    auth.isOwner = false
    __views = views
    __loading = false
  })

  it('lands on the Active Shipments default view', async () => {
    const shipments = [
      row('S001', { status: 'OPEN' }),
      row('S002', { status: 'DELIVERED' }),
      row('S003', { status: 'ON_HOLD' }),
      row('S004', { status: 'DELIVERED', voidedAt: '2026-02-01T00:00:00Z' }),
    ]
    renderBoard('/tms/shipments', shipments)
    await waitFor(() => expect(screen.getByRole('combobox', { name: /View/i })).toHaveValue('active-shipments'))

    // Default view excludes VOIDED and HOLD rows.
    expect(screen.queryByText('S003')).toBeNull()
    expect(screen.queryByText('S004')).toBeNull()
    expect(screen.getByText('S001')).toBeTruthy()
    expect(screen.getByText('S002')).toBeTruthy()
  })

  it('filters rows when a status is checked and keeps counts from the unfiltered set', async () => {
    const shipments = [
      row('S001', { status: 'OPEN' }),
      row('S002', { status: 'DELIVERED' }),
      row('S003', { status: 'DELIVERED' }),
    ]
    renderBoard('/tms/shipments/view/active-shipments', shipments)
    await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())

    // The Open checkbox shows the unfiltered count (1).
    const openCheckbox = screen.getByRole('checkbox', { name: /Open\s+1/i })
    expect(openCheckbox).toBeChecked()

    // Uncheck Delivered; the count stays visible.
    const deliveredCheckbox = screen.getByRole('checkbox', { name: /Delivered\s+2/i })
    expect(deliveredCheckbox).toBeChecked()
    fireEvent.click(deliveredCheckbox)

    await waitFor(() => expect(screen.queryByText('S002')).toBeNull())
    expect(screen.queryByText('S003')).toBeNull()
    expect(screen.getByText('S001')).toBeTruthy()

    // Counts remain the same.
    expect(screen.getByRole('checkbox', { name: /Delivered\s+2/i })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: /Open\s+1/i })).toBeTruthy()
  })

  it('Exclude toggle inverts one facet only', async () => {
    const shipments = [
      row('S001', { status: 'OPEN', customerId: 'cust-1' }),
      row('S002', { status: 'OPEN', customerId: 'cust-2' }),
      row('S003', { status: 'DELIVERED', customerId: 'cust-1' }),
    ]
    renderBoard('/tms/shipments/view/active-shipments', shipments)
    await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())

    // Pick Acme Freight in the Customer facet type-ahead.
    const customerInput = screen.getByRole('combobox', { name: /Customer/i })
    fireEvent.change(customerInput, { target: { value: 'Acme' } })

    const customerOptions = await screen.findByRole('listbox', { name: /Customer options/i })
    fireEvent.click(within(customerOptions).getByText('Acme Freight'))

    await waitFor(() => expect(screen.getByRole('button', { name: /Remove Acme Freight/i })).toBeTruthy())
    expect(screen.getByText('S001')).toBeTruthy()
    expect(screen.getByText('S003')).toBeTruthy()
    expect(screen.queryByText('S002')).toBeNull()

    // Flip Exclude for Customer only.
    const customerFacet = customerInput.closest('.tms-board-detail-row') as HTMLElement
    const excludeCheckbox = within(customerFacet).getByRole('checkbox', { name: /Exclude/i })
    fireEvent.click(excludeCheckbox)

    await waitFor(() => {
      expect(screen.queryByText('S001')).toBeNull()
      expect(screen.queryByText('S003')).toBeNull()
    })
    expect(screen.getByText('S002')).toBeTruthy()

    // Other facets (statuses) stay untouched.
    expect(screen.getByRole('checkbox', { name: /Open\s+2/i })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /Delivered\s+1/i })).toBeChecked()
  })

  it('gives a row the tone its status implies and voided rows are struck through', async () => {
    const shipments = [deliveredRow('S001'), row('S002', { status: 'OPEN', voidedAt: '2026-02-01T00:00:00Z' })]
    renderBoard('/tms/shipments/view/active-shipments', shipments)
    await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())

    const deliveredRowEl = screen.getByText('S001').closest('tr')!
    expect(deliveredRowEl).toHaveAttribute('data-tone', 'delivered')

    // Show the voided row by selecting VOIDED.
    const voidedCheckbox = screen.getByRole('checkbox', { name: /Voided/i })
    fireEvent.click(voidedCheckbox)
    await waitFor(() => expect(screen.getByText('S002')).toBeTruthy())

    const voidedRowEl = screen.getByText('S002').closest('tr')!
    expect(voidedRowEl).toHaveAttribute('data-tone', 'voided')
  })

  it('shows a Mass Release checkbox only for releasable shipments and the reason otherwise', async () => {
    const shipments = [
      deliveredRow('S001', { docsMissing: [] }),
      deliveredRow('S002', { docsMissing: null }),
      deliveredRow('S003', { docsMissing: ['POD'], readyToInvoiceAt: null }),
      deliveredRow('S004', { docsMissing: [], readyToInvoiceAt: '2026-02-01T00:00:00Z' }),
    ]
    renderBoard('/tms/shipments/view/active-shipments', shipments)
    await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())

    const row1 = screen.getByText('S001').closest('tr')!
    expect(within(row1).getByRole('checkbox', { name: /Release S001/i })).toBeTruthy()

    const row2 = screen.getByText('S002').closest('tr')!
    expect(within(row2).getByText('Documents not checked')).toBeTruthy()

    const row3 = screen.getByText('S003').closest('tr')!
    expect(within(row3).getByText(/Missing documents:/i)).toBeTruthy()

    const row4 = screen.getByText('S004').closest('tr')!
    expect(within(row4).getByText('Already released to accounting')).toBeTruthy()
  })

  it('Get next 50 shows more rows', async () => {
    const shipments = Array.from({ length: 75 }, (_, i) => row(`S${String(i).padStart(3, '0')}`, { status: 'OPEN' }))
    renderBoard('/tms/shipments/view/active-shipments', shipments)
    await waitFor(() => expect(screen.getByText('S000')).toBeTruthy())

    expect(screen.getByText((_, node) => node?.textContent === 'Records shown 50 of 75')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Get next 50/i }))
    await waitFor(() => expect(screen.getByText((_, node) => node?.textContent === 'Records shown 75 of 75')).toBeTruthy())
  })

  it('Export to CSV writes the visible columns', async () => {
    const shipments = [deliveredRow('S001', { customerReference: 'PO-123', equipmentType: 'Van', revenueCents: 100_000 })]
    renderBoard('/tms/shipments/view/active-shipments', shipments)
    await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /Export to CSV/i }))

    await waitFor(() => expect(saveBlob).toHaveBeenCalled())
    const blob = saveBlob.mock.calls[0][0] as Blob
    const csv = await blob.text()
    expect(csv).toContain('Status')
    expect(csv).toContain('PRO #')
    expect(csv).toContain('Customer Reference Number')
    expect(csv).toContain('PO-123')
  })

  it('Batch Task reports a per-row failure rather than swallowing it', async () => {
    batchShipmentTask.mockResolvedValueOnce({
      results: [
        { shipmentId: 'S001', number: 'S-a', ok: true, message: null },
        { shipmentId: 'S002', number: 'S-b', ok: false, message: 'Gate refused: missing POD' },
      ],
    })

    const shipments = [deliveredRow('S001'), deliveredRow('S002')]
    vi.mocked(listOrders).mockResolvedValue([
      { id: 'ord-1', shipmentId: 'S001', updatedAt: '2026-01-01T00:00:00Z' },
      { id: 'ord-2', shipmentId: 'S002', updatedAt: '2026-01-01T00:00:00Z' },
    ] as unknown as OrderRecord[])

    renderBoard('/tms/shipments/view/active-shipments', shipments)
    await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())

    // Select both rows via the master checkbox.
    fireEvent.click(screen.getByRole('checkbox', { name: /Select all rows/i }))

    fireEvent.click(screen.getByRole('button', { name: /Batch task/i }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: /Batch task/i })).toBeTruthy())

    const dialog = screen.getByRole('dialog', { name: /Batch task/i })
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'release' } })
    fireEvent.click(screen.getByRole('button', { name: /^Run$/i }))

    await waitFor(() => expect(batchShipmentTask).toHaveBeenCalledTimes(1))
    expect(batchShipmentTask).toHaveBeenCalledWith(expect.objectContaining({
      task: 'RELEASE_TO_BILLING',
      shipmentIds: ['S001', 'S002'],
      params: {},
    }))
    expect(readyToInvoice).not.toHaveBeenCalled()

    const resultDialog = screen.getByRole('dialog', { name: /Batch task/i })
    await waitFor(() => {
      expect(within(resultDialog).getByText('S001')).toBeTruthy()
      expect(within(resultDialog).getByText('S002')).toBeTruthy()
      expect(within(resultDialog).getByText('Gate refused: missing POD')).toBeTruthy()
    })
  })

  it('Create shipment lists only loads without a shipment and calls the backfill wrapper', async () => {
    const loads = [
      { id: 'load-1', pickupNumber: 'L001', shipmentId: 'ship-1', originCity: 'Chicago', destinationCity: 'Dallas', pickupAppt: '2026-01-01T00:00:00Z' },
      { id: 'load-2', pickupNumber: 'L002', shipmentId: null, originCity: 'Denver', destinationCity: 'Boise', pickupAppt: '2026-01-02T00:00:00Z' },
    ]
    __loads = loads as unknown as Load[]

    renderBoard('/tms/shipments/view/active-shipments')
    await waitFor(() => expect(screen.getByRole('button', { name: /Create shipment/i })).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /Create shipment/i }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: /Create shipment/i })).toBeTruthy())

    expect(screen.queryByText('L001')).toBeNull()
    expect(screen.getByText('L002')).toBeTruthy()

    createShipmentForLoad.mockResolvedValueOnce({})
    fireEvent.click(screen.getByRole('button', { name: /^Create$/i }))

    await waitFor(() => expect(createShipmentForLoad).toHaveBeenCalledWith('load-2'))
  })

  it('Unvoid requires a reason', async () => {
    const shipments = [row('S001', { status: 'CANCELED', voidedAt: '2026-02-01T00:00:00Z', voidedBy: 'admin', voidReason: 'test' })]
    renderBoard('/tms/shipments/view/active-shipments', shipments)

    // Make voided rows visible by selecting VOIDED.
    const voidedCheckbox = screen.getByRole('checkbox', { name: /Voided/i })
    fireEvent.click(voidedCheckbox)
    await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())

    fireEvent.pointerDown(screen.getByLabelText('Shipment actions'), { button: 0, pointerType: 'mouse' })
    fireEvent.click(await screen.findByRole('menuitem', { name: /Unvoid shipment/i }))

    await waitFor(() => expect(screen.getByRole('dialog', { name: /Unvoid shipment/i })).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /^Unvoid$/i }))
    await waitFor(() => expect(screen.getByText('A reason is required.')).toBeTruthy())
    expect(unvoidShipment).not.toHaveBeenCalled()

    fireEvent.change(screen.getByRole('textbox', { name: /Reason/i }), { target: { value: 'Customer corrected' } })
    unvoidShipment.mockResolvedValueOnce({})
    fireEvent.click(screen.getByRole('button', { name: /^Unvoid$/i }))

    await waitFor(() => expect(unvoidShipment).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'Customer corrected',
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
    })))
  })

  it('repoint refused with INVOICED: offers the credit path and sends a fresh idempotency key per credit path', async () => {
    getShipmentBundle.mockResolvedValue({ orders: [] })
    resolveRevTag.mockResolvedValue({})

    const shipments = [row('S001', { status: 'DELIVERED', customerId: 'cust-1' })]
    renderBoard('/tms/shipments/view/active-shipments', shipments)
    await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())

    const openRepoint = async () => {
      fireEvent.pointerDown(screen.getByLabelText('Shipment actions'), { button: 0, pointerType: 'mouse' })
      fireEvent.click(await screen.findByRole('menuitem', { name: /Re-point customer/i }))
      await waitFor(() => expect(screen.getByRole('dialog', { name: /Re-point customer/i })).toBeTruthy())
    }

    const fillAndSubmit = async () => {
      fireEvent.change(screen.getByRole('combobox', { name: /New customer/i }), { target: { value: 'cust-2' } })
      fireEvent.change(screen.getByRole('textbox', { name: /Reason/i }), { target: { value: 'Sold to different division' } })
      fireEvent.click(screen.getByRole('button', { name: /^Re-point$/i }))
    }

    // First credit path.
    await openRepoint()
    repointShipmentCustomer.mockRejectedValueOnce(new Error('INVOICED: This shipment has already been invoiced.'))
    await fillAndSubmit()

    await waitFor(() => expect(repointShipmentCustomer).toHaveBeenCalledWith(expect.objectContaining({
      shipmentId: 'S001',
      customerId: 'cust-2',
      reason: 'Sold to different division',
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
    })))

    await waitFor(() => expect(screen.getByText(/already been invoiced/i)).toBeTruthy())

    repointInvoicedCustomer.mockResolvedValueOnce({})
    fireEvent.click(await screen.findByRole('button', { name: /Credit original and rebill/i }))
    await waitFor(() => expect(repointInvoicedCustomer).toHaveBeenCalledTimes(1))
    const firstKey = repointInvoicedCustomer.mock.calls[0][0].idempotencyKey
    expect(firstKey).toEqual(expect.any(String))

    // A successful confirmation closes the dialog; the next one uses a new key.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Re-point customer/i })).toBeNull())

    // Second credit path.
    await openRepoint()
    repointShipmentCustomer.mockRejectedValueOnce(new Error('INVOICED: This shipment has already been invoiced.'))
    await fillAndSubmit()
    await waitFor(() => expect(screen.getByText(/already been invoiced/i)).toBeTruthy())

    repointInvoicedCustomer.mockResolvedValueOnce({})
    fireEvent.click(await screen.findByRole('button', { name: /Credit original and rebill/i }))
    await waitFor(() => expect(repointInvoicedCustomer).toHaveBeenCalledTimes(2))
    expect(repointInvoicedCustomer.mock.calls[1][0].idempotencyKey).not.toBe(firstKey)
  })

  it('Unvoid surfaces a stale-token refusal as a readable message', async () => {
    const shipments = [row('S001', { status: 'CANCELED', voidedAt: '2026-02-01T00:00:00.000Z', voidedBy: 'admin', voidReason: 'test' })]
    renderBoard('/tms/shipments/view/active-shipments', shipments)

    const voidedCheckbox = screen.getByRole('checkbox', { name: /Voided/i })
    fireEvent.click(voidedCheckbox)
    await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())

    fireEvent.pointerDown(screen.getByLabelText('Shipment actions'), { button: 0, pointerType: 'mouse' })
    fireEvent.click(await screen.findByRole('menuitem', { name: /Unvoid shipment/i }))

    await waitFor(() => expect(screen.getByRole('dialog', { name: /Unvoid shipment/i })).toBeTruthy())

    fireEvent.change(screen.getByRole('textbox', { name: /Reason/i }), { target: { value: 'Customer corrected' } })
    unvoidShipment.mockRejectedValueOnce(new Error('This shipment was changed by someone else. Reload and try again.'))
    fireEvent.click(screen.getByRole('button', { name: /^Unvoid$/i }))

    await waitFor(() => expect(screen.getByText('This shipment was changed by someone else. Reload and try again.')).toBeTruthy())
  })

  it('Re-point customer surfaces a stale-token refusal as a readable message', async () => {
    const shipments = [row('S001', { status: 'DELIVERED', customerId: 'cust-1' })]
    renderBoard('/tms/shipments/view/active-shipments', shipments)
    await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())

    fireEvent.pointerDown(screen.getByLabelText('Shipment actions'), { button: 0, pointerType: 'mouse' })
    fireEvent.click(await screen.findByRole('menuitem', { name: /Re-point customer/i }))

    await waitFor(() => expect(screen.getByRole('dialog', { name: /Re-point customer/i })).toBeTruthy())

    fireEvent.change(screen.getByRole('combobox', { name: /New customer/i }), { target: { value: 'cust-2' } })
    fireEvent.change(screen.getByRole('textbox', { name: /Reason/i }), { target: { value: 'Sold to different division' } })
    repointShipmentCustomer.mockRejectedValueOnce(new Error('This shipment was changed by someone else. Reload and try again.'))
    fireEvent.click(screen.getByRole('button', { name: /^Re-point$/i }))

    await waitFor(() => expect(screen.getByText('This shipment was changed by someone else. Reload and try again.')).toBeTruthy())
  })

  it('tones the next check call cell overdue or due', async () => {
    const now = new Date('2026-01-15T12:00:00.000Z')
    vi.setSystemTime(now)
    const overdue = deliveredRow('S001', { nextCheckCallAt: '2026-01-15T11:00:00.000Z', checkCallOpen: 'OPEN' })
    const due = deliveredRow('S002', { nextCheckCallAt: '2026-01-15T12:00:00.000Z', checkCallOpen: 'OPEN' })
    const future = deliveredRow('S003', { nextCheckCallAt: '2026-01-15T13:00:00.000Z', checkCallOpen: 'OPEN' })
    renderBoard('/tms/shipments/view/active-shipments', [overdue, due, future])
    await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())

    const overdueRow = screen.getByText('S001').closest('tr')!
    const dueRow = screen.getByText('S002').closest('tr')!
    const futureRow = screen.getByText('S003').closest('tr')!

    expect(overdueRow.querySelector('.tms-overdue')).toBeTruthy()
    expect(dueRow.querySelector('.tms-due')).toBeTruthy()
    expect(futureRow.querySelector('.tms-overdue')).toBeNull()
    expect(futureRow.querySelector('.tms-due')).toBeNull()

    vi.useRealTimers()
  })

  it('renders exception icons for incidents, open check calls and missing documents', async () => {
    const shipments = [
      deliveredRow('S001', { openIncidentCount: 2 }),
      deliveredRow('S002', { nextCheckCallAt: '2026-01-01T00:00:00.000Z', checkCallOpen: 'OPEN' }),
      deliveredRow('S003', { docsMissing: ['POD', 'Lumper Receipt'] }),
      deliveredRow('S004', { customerId: null, customerName: 'Unknown' }),
    ]
    renderBoard('/tms/shipments/view/active-shipments', shipments)
    await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())

    const row1 = screen.getByText('S001').closest('tr')!
    expect(within(row1).getByTitle('2 open incident(s)')).toBeTruthy()

    const row2 = screen.getByText('S002').closest('tr')!
    expect(within(row2).getByTitle('Overdue check call')).toBeTruthy()

    const row3 = screen.getByText('S003').closest('tr')!
    expect(within(row3).getByTitle('Missing documents: POD, Lumper Receipt')).toBeTruthy()

    const row4 = screen.getByText('S004').closest('tr')!
    expect(within(row4).getByTitle('Customer not linked')).toBeTruthy()
  })

  it('narrows rows when a tracking/paperwork flag is checked', async () => {
    const shipments = [
      deliveredRow('S001', { docsMissing: ['POD'] }),
      deliveredRow('S002', { docsMissing: [] }),
    ]
    renderBoard('/tms/shipments/view/active-shipments', shipments)
    await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())

    fireEvent.click(screen.getByRole('checkbox', { name: /Missing documents/i }))

    await waitFor(() => {
      expect(screen.getByText('S001')).toBeTruthy()
      expect(screen.queryByText('S002')).toBeNull()
    })
  })

  it('Cancel shipment calls setShipmentStatus with reason', async () => {
    const shipments = [row('S001', { status: 'OPEN' })]
    renderBoard('/tms/shipments/view/active-shipments', shipments)
    await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())

    setShipmentStatus.mockResolvedValueOnce({})
    fireEvent.pointerDown(screen.getByLabelText('Shipment actions'), { button: 0, pointerType: 'mouse' })
    fireEvent.click(await screen.findByRole('menuitem', { name: /Cancel/i }))

    await waitFor(() => expect(screen.getByRole('dialog', { name: /Cancel shipment/i })).toBeTruthy())
    fireEvent.change(screen.getByRole('textbox', { name: /Reason/i }), { target: { value: 'Customer called off' } })
    fireEvent.click(screen.getByRole('button', { name: /^Confirm$/i }))

    await waitFor(() => expect(setShipmentStatus).toHaveBeenCalledWith(expect.objectContaining({
      shipmentId: 'S001',
      status: 'CANCELED',
      reason: 'Customer called off',
    })))
  })

  it('Un-cancel shipment calls setShipmentStatus', async () => {
    const shipments = [row('S001', { status: 'CANCELED' })]
    renderBoard('/tms/shipments/view/all-shipments', shipments)
    await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())

    setShipmentStatus.mockResolvedValueOnce({})
    fireEvent.pointerDown(screen.getByLabelText('Shipment actions'), { button: 0, pointerType: 'mouse' })
    fireEvent.click(await screen.findByRole('menuitem', { name: /Un-cancel/i }))

    await waitFor(() => expect(setShipmentStatus).toHaveBeenCalledWith(expect.objectContaining({
      shipmentId: 'S001',
      status: 'UNCANCEL',
    })))
  })

  it('Put on hold and take off hold call setShipmentStatus', async () => {
    const shipments = [row('S001', { status: 'OPEN' })]
    renderBoard('/tms/shipments/view/active-shipments', shipments)
    await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())

    setShipmentStatus.mockResolvedValueOnce({})
    fireEvent.pointerDown(screen.getByLabelText('Shipment actions'), { button: 0, pointerType: 'mouse' })
    fireEvent.click(await screen.findByRole('menuitem', { name: /Put on hold/i }))

    await waitFor(() => expect(screen.getByRole('dialog', { name: /Put on hold/i })).toBeTruthy())
    fireEvent.change(screen.getByRole('textbox', { name: /Reason/i }), { target: { value: 'Waiting on docs' } })
    fireEvent.click(screen.getByRole('button', { name: /^Confirm$/i }))

    await waitFor(() => expect(setShipmentStatus).toHaveBeenCalledWith(expect.objectContaining({
      shipmentId: 'S001',
      status: 'ON_HOLD',
      reason: 'Waiting on docs',
    })))
  })

  it('Duplicate shipment calls duplicateShipment with copies', async () => {
    const shipments = [row('S001', { status: 'OPEN', pickupAppt: '2026-01-02T10:00:00.000Z', deliveryAppt: '2026-01-03T10:00:00.000Z' })]
    renderBoard('/tms/shipments/view/active-shipments', shipments)
    await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())

    duplicateShipment.mockResolvedValueOnce({})
    fireEvent.pointerDown(screen.getByLabelText('Shipment actions'), { button: 0, pointerType: 'mouse' })
    fireEvent.click(await screen.findByRole('menuitem', { name: /Duplicate/i }))

    await waitFor(() => expect(screen.getByRole('dialog', { name: /Duplicate shipment/i })).toBeTruthy())
    fireEvent.change(screen.getByRole('spinbutton', { name: /Copies/i }), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: /^Duplicate$/i }))

    await waitFor(() => expect(duplicateShipment).toHaveBeenCalledWith(expect.objectContaining({
      shipmentId: 'S001',
      copies: expect.arrayContaining([expect.objectContaining({ pickupAppt: expect.any(String) })]),
    })))
  })

  it('Void shipment triggers refresh after the void dialog succeeds', async () => {
    const shipments = [row('S001', { status: 'OPEN' })]
    renderBoard('/tms/shipments/view/active-shipments', shipments)
    await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())

    voidShipment.mockResolvedValueOnce({ id: 'S001', number: 'S001', status: 'VOIDED' })
    fireEvent.pointerDown(screen.getByLabelText('Shipment actions'), { button: 0, pointerType: 'mouse' })
    fireEvent.click(await screen.findByRole('menuitem', { name: /Void shipment/i }))

    await waitFor(() => expect(screen.getByRole('dialog', { name: /Void shipment S001/i })).toBeTruthy())
    fireEvent.change(screen.getByRole('textbox', { name: /Reason/i }), { target: { value: 'Customer no longer needs it' } })

    fireEvent.click(screen.getByRole('button', { name: /^Void shipment$/i }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })

  it('Accept tender calls tenderRespond', async () => {
    const shipments = [row('S001', { status: 'TENDER_PENDING' })]
    renderBoard('/tms/shipments/view/all-shipments', shipments)
    await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())

    tenderRespond.mockResolvedValueOnce({})
    fireEvent.pointerDown(screen.getByLabelText('Shipment actions'), { button: 0, pointerType: 'mouse' })
    fireEvent.click(await screen.findByRole('menuitem', { name: /Accept tender/i }))

    await waitFor(() => expect(tenderRespond).toHaveBeenCalledWith(expect.objectContaining({
      shipmentId: 'S001',
      decision: 'ACCEPT',
    })))
  })

  it('Reject tender calls tenderRespond with reason', async () => {
    const shipments = [row('S001', { status: 'TENDER_PENDING' })]
    renderBoard('/tms/shipments/view/all-shipments', shipments)
    await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())

    tenderRespond.mockResolvedValueOnce({})
    fireEvent.pointerDown(screen.getByLabelText('Shipment actions'), { button: 0, pointerType: 'mouse' })
    fireEvent.click(await screen.findByRole('menuitem', { name: /Reject tender/i }))

    await waitFor(() => expect(screen.getByRole('dialog', { name: /Reject tender/i })).toBeTruthy())
    fireEvent.change(screen.getByRole('textbox', { name: /Reason/i }), { target: { value: 'Rates too low' } })
    fireEvent.click(screen.getByRole('button', { name: /^Confirm$/i }))

    await waitFor(() => expect(tenderRespond).toHaveBeenCalledWith(expect.objectContaining({
      shipmentId: 'S001',
      decision: 'REJECT',
      reason: 'Rates too low',
    })))
  })

  it('Reset tender calls tenderRespond', async () => {
    const shipments = [row('S001', { status: 'TENDER_REJECTED' })]
    renderBoard('/tms/shipments/view/all-shipments', shipments)
    await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())

    tenderRespond.mockResolvedValueOnce({})
    fireEvent.pointerDown(screen.getByLabelText('Shipment actions'), { button: 0, pointerType: 'mouse' })
    fireEvent.click(await screen.findByRole('menuitem', { name: /Reset tender/i }))

    await waitFor(() => expect(tenderRespond).toHaveBeenCalledWith(expect.objectContaining({
      shipmentId: 'S001',
      decision: 'RESET',
    })))
  })

  it('hydrates saved board filters after views arrive asynchronously', async () => {
    const shipments = [row('S001', { status: 'OPEN' }), deliveredRow('S002')]
    setMockViews([], true)
    renderBoard('/tms/shipments/view/active-shipments', shipments)

    act(() => {
      setMockViews(views, false)
    })

    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: /Open\s+1/i })).toBeChecked()
      expect(screen.getByRole('checkbox', { name: /Covered/i })).toBeChecked()
      expect(screen.getByRole('checkbox', { name: /Dispatched/i })).toBeChecked()
      expect(screen.getByRole('checkbox', { name: /Arrived/i })).toBeChecked()
      expect(screen.getByRole('checkbox', { name: /Departed/i })).toBeChecked()
      expect(screen.getByRole('checkbox', { name: /Delivered\s+1/i })).toBeChecked()
      expect(screen.getByRole('checkbox', { name: /Hold/i })).not.toBeChecked()
      expect(screen.getByRole('checkbox', { name: /Reserved/i })).not.toBeChecked()
      expect(screen.getByRole('checkbox', { name: /Voided/i })).not.toBeChecked()
    })

    expect(screen.queryByText('Unsaved changes')).toBeNull()
  })

  it('shows Unsaved changes after a hydrated filter is edited', async () => {
    const shipments = [row('S001', { status: 'OPEN' })]
    setMockViews([], true)
    renderBoard('/tms/shipments/view/active-shipments', shipments)

    act(() => {
      setMockViews(views, false)
    })

    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: /Open\s+1/i })).toBeChecked()
    })

    expect(screen.queryByText(/Unsaved changes/)).toBeNull()

    fireEvent.click(screen.getByRole('checkbox', { name: /Open\s+1/i }))

    await waitFor(() => {
      expect(screen.getByText(/Unsaved changes · Active Shipments/i)).toBeTruthy()
    })
  })

  it('Revert restores the saved filter set and clears Unsaved changes', async () => {
    const shipments = [row('S001', { status: 'OPEN' }), deliveredRow('S002')]
    setMockViews([], true)
    renderBoard('/tms/shipments/view/active-shipments', shipments)

    act(() => {
      setMockViews(views, false)
    })

    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: /Open\s+1/i })).toBeChecked()
      expect(screen.getByRole('checkbox', { name: /Delivered\s+1/i })).toBeChecked()
    })

    fireEvent.click(screen.getByRole('checkbox', { name: /Open\s+1/i }))
    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: /Open\s+1/i })).not.toBeChecked()
      expect(screen.getByText(/Unsaved changes · Active Shipments/i)).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: /Revert/i }))

    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: /Open\s+1/i })).toBeChecked()
      expect(screen.getByRole('checkbox', { name: /Delivered\s+1/i })).toBeChecked()
      expect(screen.queryByText(/Unsaved changes/)).toBeNull()
    })
  })

  it('re-hydrates filters when switching to another view', async () => {
    const shipments = [row('S001', { status: 'OPEN' }), deliveredRow('S002')]
    renderBoard('/tms/shipments/view/active-shipments', shipments)

    const viewSelect = await waitFor(() => screen.getByRole('combobox', { name: /View/i }))
    await waitFor(() => expect(viewSelect).toHaveValue('active-shipments'))

    expect(screen.getByRole('checkbox', { name: /Open\s+1/i })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /Delivered\s+1/i })).toBeChecked()

    fireEvent.change(viewSelect, { target: { value: 'all-shipments' } })

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: /View/i })).toHaveValue('all-shipments')
      expect(screen.getByRole('checkbox', { name: /Open\s+1/i })).not.toBeChecked()
      expect(screen.getByRole('checkbox', { name: /Delivered\s+1/i })).not.toBeChecked()
      expect(screen.queryByText(/Unsaved changes/)).toBeNull()
    })

    fireEvent.change(screen.getByRole('combobox', { name: /View/i }), { target: { value: 'active-shipments' } })

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: /View/i })).toHaveValue('active-shipments')
      expect(screen.getByRole('checkbox', { name: /Open\s+1/i })).toBeChecked()
      expect(screen.getByRole('checkbox', { name: /Delivered\s+1/i })).toBeChecked()
      expect(screen.queryByText(/Unsaved changes/)).toBeNull()
    })
  })

  it('hydrates the saved column selection after a fresh load', async () => {
    setMockViews([], true)
    renderBoard('/tms/shipments/view/status-only', [row('S001')])

    act(() => {
      setMockViews([...views, statusOnlyView], false)
    })

    await waitFor(() => {
      const headers = screen.getAllByRole('columnheader')
      expect(headers.some((h) => h.textContent?.includes('Status'))).toBe(true)
      expect(headers.some((h) => h.textContent?.includes('PRO #'))).toBe(false)
    })
  })
})
