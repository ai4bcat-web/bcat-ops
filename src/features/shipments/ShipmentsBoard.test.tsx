// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ShipmentsBoard } from './ShipmentsBoard'
import type { ShipmentRow } from './shipmentViews'
import type { Load } from '@/types'
import { useAppStore } from '@/store/useAppStore'

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
const __views: unknown[] = []
vi.mock('@/hooks/useShipments', async () => {
  const React = await import('react')
  return {
    // Holds its rows in state like the real hook: a refresh re-reads what the backend now says.
    useShipments: (view: unknown) => {
      __views.push(view)
      const [rows, setRows] = React.useState(__shipments)
      const refreshRows = React.useCallback(async () => { refresh(); setRows(__shipments) }, [])
      return { shipments: rows, loading: false, partial: false, error: null, refresh: refreshRows }
    },
  }
})

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

vi.mock('@/features/tms/useOwnershipDivisions', () => ({
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

vi.mock('./intake/useIntakeLoads', () => ({ useOpenIntakeCount: () => 0 }))

vi.mock('@/lib/apiClient', () => ({
  listShipmentColumnTemplates,
  listShipmentsByNumber: async () => [],
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
        <Route path="/tms/shipments/intake" element={<div>intake page</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

/** Opens a column's header filter and ticks one option of its multi-select. */
function pickFacet(header: string, option: string) {
  const trigger = screen.getByRole('button', { name: `Filter ${header}` })
  if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('checkbox', { name: `${header}: ${option}` }))
}

describe('ShipmentsBoard', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    __views.length = 0
    auth.isAdmin = true
    auth.isOwner = false
  })


  it('reads only the working set until the VOIDED facet or the All list asks for a month window', async () => {
    renderBoard('/tms/shipments', [row('S001', { status: 'OPEN' }), row('S002', { status: 'VOIDED' as ShipmentRow['status'], voidedAt: '2026-01-02T00:00:00Z' })])
    await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())
    const windows = () => __views.filter((v) => (v as { kind: string }).kind === 'window') as Array<{ months: string[]; includeVoided?: boolean }>
    expect(windows().every((w) => w.months.length === 0)).toBe(true)

    pickFacet('Status', 'Voided')
    await waitFor(() => expect(windows().some((w) => w.months.length > 0 && w.includeVoided === true)).toBe(true))
  })

  it('the All list asks for the period window without voided rows', async () => {
    renderBoard('/tms/shipments?list=all', [row('S001')])
    await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())
    const asked = (__views as Array<{ kind: string; months?: string[]; includeVoided?: boolean }>).filter((v) => v.kind === 'window' && v.months!.length > 0)
    expect(asked.length).toBeGreaterThan(0)
    expect(asked.every((w) => w.months!.length === 1 && !w.includeVoided)).toBe(true)
  })

  it('narrows rows by the Status header filter and keeps its option counts from the unfiltered list', async () => {
    const shipments = [
      row('S001', { status: 'OPEN' }),
      row('S002', { status: 'DELIVERED' }),
      row('S003', { status: 'DELIVERED' }),
    ]
    renderBoard('/tms/shipments', shipments)
    await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())

    // Ticking Open narrows to the open row; the option counts keep coming from the unfiltered list.
    fireEvent.click(screen.getByRole('button', { name: 'Filter Status' }))
    expect(screen.getByRole('checkbox', { name: 'Status: Open' })).not.toBeChecked()
    pickFacet('Status', 'Open')

    await waitFor(() => expect(screen.queryByText('S002')).toBeNull())
    expect(screen.queryByText('S003')).toBeNull()
    expect(screen.getByText('S001')).toBeTruthy()

    expect(screen.getByRole('checkbox', { name: 'Status: Delivered' }).closest('label')).toHaveTextContent('Delivered2')
    expect(screen.getByRole('checkbox', { name: 'Status: Open' })).toBeChecked()
  })

  it('Exclude inverts one header filter only', async () => {
    const shipments = [
      row('S001', { status: 'OPEN', customerName: 'Acme Freight' }),
      row('S002', { status: 'OPEN', customerName: 'Globex' }),
      row('S003', { status: 'DELIVERED', customerName: 'Acme Freight' }),
    ]
    renderBoard('/tms/shipments', shipments)
    await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())

    pickFacet('Customer', 'Acme Freight')
    await waitFor(() => expect(screen.queryByText('S002')).toBeNull())
    expect(screen.getByText('S001')).toBeTruthy()
    expect(screen.getByText('S003')).toBeTruthy()

    // Flip Exclude for the Customer filter only.
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Customer filter' })).getByRole('checkbox', { name: 'Exclude' }))
    await waitFor(() => {
      expect(screen.queryByText('S001')).toBeNull()
      expect(screen.queryByText('S003')).toBeNull()
    })
    expect(screen.getByText('S002')).toBeTruthy()
  })

  it('gives a row the tone its status implies and voided rows are struck through', async () => {
    const shipments = [deliveredRow('S001'), row('S002', { status: 'OPEN', voidedAt: '2026-02-01T00:00:00Z' })]
    renderBoard('/tms/shipments', shipments)
    await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())

    const deliveredRowEl = screen.getByText('S001').closest('tr')!
    expect(deliveredRowEl).toHaveAttribute('data-tone', 'delivered')

    // Show the voided row by asking the Status header for VOIDED.
    pickFacet('Status', 'Voided')
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
    renderBoard('/tms/shipments?list=all', shipments)
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

  it('lists 100 rows a page, mounts only the rows in view, and Get next 100 adds the rest', async () => {
    const shipments = Array.from({ length: 250 }, (_, i) => row(`S${String(i).padStart(3, '0')}`, { status: 'OPEN' }))
    renderBoard('/tms/shipments', shipments)
    await waitFor(() => expect(screen.getByText('S000')).toBeTruthy())

    expect(screen.getByText((_, node) => node?.textContent === 'Records shown 100 of 250')).toBeTruthy()
    // Virtualised: the page holds 100 rows but the DOM holds far fewer.
    const mounted = document.querySelectorAll('tbody tr:not(.tms-dg-spacer)').length
    expect(mounted).toBeGreaterThan(0)
    expect(mounted).toBeLessThan(60)

    fireEvent.click(screen.getByRole('button', { name: /Get next 100/i }))
    await waitFor(() => expect(screen.getByText((_, node) => node?.textContent === 'Records shown 200 of 250')).toBeTruthy())
  })

  it('Export to CSV writes the visible columns', async () => {
    const shipments = [deliveredRow('S001', { customerReference: 'PO-123', equipmentType: 'Van', revenueCents: 100_000 })]
    renderBoard('/tms/shipments', shipments)
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

    renderBoard('/tms/shipments', shipments)
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

  it('flags a live Ivan Cartage shipment with no driver, and only that', async () => {
    renderBoard('/tms/shipments', [
      row('S001', { assignmentType: 'OWN_ASSET', driverId: null }),
      row('S002', { assignmentType: 'OWN_ASSET', driverId: 'drv-1', driverName: 'Dana Driver' }),
      row('S003', { assignmentType: 'OWN_ASSET', driverId: null, voidedAt: '2026-02-01T00:00:00Z' }),
      row('S004', { assignmentType: 'CARRIER', carrierName: 'Swift' }),
    ])
    await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())
    expect(document.querySelectorAll('[title="Ivan Cartage load with no driver"]')).toHaveLength(1)
    expect(screen.getAllByText('Own fleet · no driver')).toHaveLength(1)
    expect(screen.getAllByText('Dana Driver').length).toBeGreaterThan(0)
  })

  it('Batch Task offers Assign driver per active non-broker driver and sends ASSIGN_DRIVER', async () => {
    useAppStore.setState({
      drivers: [
        { id: 'drv-1', name: 'Dana Driver', phone: '', active: true, type: 'driver', assignedTruckId: 'trk-1' },
        { id: 'drv-x', name: 'Off Driver', phone: '', active: false, type: 'driver' },
        { id: 'drv-b', name: 'BROKER COVERED', phone: '', active: true, type: 'broker' },
      ] as never,
      equipment: [{ id: 'trk-1', type: 'truck', unitNumber: '101' }] as never,
    })
    batchShipmentTask.mockResolvedValueOnce({
      results: [{ shipmentId: 'S001', number: 'S-a', ok: false, message: 'Delivered 2026-10-14: that pay week has closed.' }],
    })
    renderBoard('/tms/shipments', [row('S001', { assignmentType: 'OWN_ASSET', driverId: null })])
    await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())
    fireEvent.click(screen.getByRole('checkbox', { name: /Select all rows/i }))
    fireEvent.click(screen.getByRole('button', { name: /Batch task/i }))
    const dialog = await screen.findByRole('dialog', { name: /Batch task/i })

    expect(within(dialog).queryByText(/Off Driver/)).toBeNull()
    expect(within(dialog).queryByText(/BROKER COVERED/)).toBeNull()
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'driver:drv-1' } })
    expect(within(dialog).getByRole('option', { name: 'Assign driver (Ivan Cartage): Dana Driver' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Run$/i }))

    await waitFor(() => expect(batchShipmentTask).toHaveBeenCalledTimes(1))
    expect(batchShipmentTask).toHaveBeenCalledWith({
      task: 'ASSIGN_DRIVER',
      shipmentIds: ['S001'],
      params: { driverId: 'drv-1', truckId: 'trk-1', truckNumber: '101' },
    })
    await waitFor(() => expect(screen.getByText('Delivered 2026-10-14: that pay week has closed.')).toBeTruthy())
    useAppStore.setState({ drivers: [], equipment: [] })
  })

  it('Create shipment lists only loads without a shipment and calls the backfill wrapper', async () => {
    const loads = [
      { id: 'load-1', pickupNumber: 'L001', shipmentId: 'ship-1', originCity: 'Chicago', destinationCity: 'Dallas', pickupAppt: '2026-01-01T00:00:00Z' },
      { id: 'load-2', pickupNumber: 'L002', shipmentId: null, originCity: 'Denver', destinationCity: 'Boise', pickupAppt: '2026-01-02T00:00:00Z' },
    ]
    __loads = loads as unknown as Load[]

    renderBoard('/tms/shipments')
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
    renderBoard('/tms/shipments', shipments)

    // Make voided rows visible by selecting VOIDED.
    pickFacet('Status', 'Voided')
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
    renderBoard('/tms/shipments', shipments)
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
    renderBoard('/tms/shipments', shipments)

    pickFacet('Status', 'Voided')
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
    renderBoard('/tms/shipments', shipments)
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
    renderBoard('/tms/shipments', [overdue, due, future])
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
    renderBoard('/tms/shipments', shipments)
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

  it('narrows rows when a needs-attention toggle is pressed', async () => {
    const shipments = [
      deliveredRow('S001', { docsMissing: ['POD'] }),
      deliveredRow('S002', { docsMissing: [] }),
    ]
    renderBoard('/tms/shipments', shipments)
    await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Missing documents' }))

    await waitFor(() => {
      expect(screen.getByText('S001')).toBeTruthy()
      expect(screen.queryByText('S002')).toBeNull()
    })
  })

  it('Cancel shipment calls setShipmentStatus with reason', async () => {
    const shipments = [row('S001', { status: 'OPEN' })]
    renderBoard('/tms/shipments', shipments)
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
    renderBoard('/tms/shipments?list=all', shipments)
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
    renderBoard('/tms/shipments', shipments)
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
    renderBoard('/tms/shipments', shipments)
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
    renderBoard('/tms/shipments', shipments)
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
    renderBoard('/tms/shipments?list=all', shipments)
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
    renderBoard('/tms/shipments?list=all', shipments)
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
    renderBoard('/tms/shipments?list=all', shipments)
    await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())

    tenderRespond.mockResolvedValueOnce({})
    fireEvent.pointerDown(screen.getByLabelText('Shipment actions'), { button: 0, pointerType: 'mouse' })
    fireEvent.click(await screen.findByRole('menuitem', { name: /Reset tender/i }))

    await waitFor(() => expect(tenderRespond).toHaveBeenCalledWith(expect.objectContaining({
      shipmentId: 'S001',
      decision: 'RESET',
    })))
  })

  it('has no View selector, Save as view or queue link anywhere on the board', async () => {
    renderBoard('/tms/shipments', [row('S001')])
    await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())
    expect(screen.queryByRole('combobox', { name: /^View$/i })).toBeNull()
    expect(screen.queryByText(/Save as view/i)).toBeNull()
    expect(screen.queryByText(/My queue|Team queue/i)).toBeNull()
  })

  it('starts every list unfiltered and Clear filters returns there', async () => {
    renderBoard('/tms/shipments', [row('S001'), deliveredRow('S002')])
    await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())
    expect(screen.queryByRole('button', { name: /Clear \d+ filter/ })).toBeNull()
    pickFacet('Status', 'Open')
    await waitFor(() => expect(screen.queryByText('S002')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: /Clear 1 filter/i }))
    await waitFor(() => expect(screen.getByText('S002')).toBeTruthy())
  })

  it('drops filters when the list changes', async () => {
    renderBoard('/tms/shipments', [row('S001'), deliveredRow('S002'), deliveredRow('S003', { arStatus: 'PAID' })])
    await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())
    pickFacet('Status', 'Open')
    await waitFor(() => expect(screen.queryByText('S002')).toBeNull())
    fireEvent.click(screen.getByRole('tab', { name: /^All/ }))
    await waitFor(() => expect(screen.getByText('S003')).toBeTruthy())
    expect(screen.getByText('S002')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Clear \d+ filter/ })).toBeNull()
  })

  describe('dense grid', () => {
    const pros = () => [...document.querySelectorAll('tbody tr[data-tone]')].map((tr) => tr.querySelectorAll('td')[1]?.textContent)

    it('opens with the PRO as the sticky first column, no side panel and the summary collapsed', async () => {
      renderBoard('/tms/shipments', [row('S001')])
      await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())
      const first = document.querySelectorAll('thead th')[1]
      expect(first).toHaveTextContent('PRO #')
      expect(first).toHaveClass('tms-dg-sticky')
      expect(screen.queryByText('Statuses')).toBeNull()
      expect(screen.queryByRole('region', { name: 'Summary' })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: /Summary/ }))
      expect(screen.getByRole('region', { name: 'Summary' })).toHaveTextContent('Shipments')
    })

    it('sorts by any column on a header click, ascending then descending', async () => {
      renderBoard('/tms/shipments', [
        row('S001', { customerName: 'Beta' }),
        row('S002', { customerName: 'Gamma' }),
        row('S003', { customerName: 'Alpha' }),
      ])
      await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())
      const customerHeader = screen.getAllByRole('columnheader').find((th) => th.textContent === 'Customer') as HTMLElement
      const header = within(customerHeader).getByRole('button', { name: 'Customer' })
      fireEvent.click(header)
      expect(pros()).toEqual(['S003', 'S001', 'S002'])
      fireEvent.click(header)
      expect(pros()).toEqual(['S002', 'S001', 'S003'])
    })

    it('a header text filter narrows the rows as you type', async () => {
      renderBoard('/tms/shipments', [row('S001', { customerReference: 'PO-100' }), row('S002', { customerReference: 'PO-200' })])
      await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())
      fireEvent.click(screen.getByRole('button', { name: 'Filter Customer Reference Number' }))
      fireEvent.change(screen.getByRole('textbox', { name: 'Filter Customer Reference Number' }), { target: { value: 'PO-2' } })
      expect(pros()).toEqual(['S002'])
    })

    it('keeps the density and column order per user across a remount', async () => {
      const first = renderBoard('/tms/shipments', [row('S001')])
      await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())
      fireEvent.click(screen.getByRole('button', { name: 'Comfortable' }))
      const headers = () => [...document.querySelectorAll('thead th')].map((th) => th.textContent)
      const [, pro, second] = headers()
      fireEvent.dragStart(screen.getByRole('columnheader', { name: new RegExp(`^${second}`) }))
      fireEvent.drop(screen.getByRole('columnheader', { name: new RegExp(`^${pro}`) }))
      const reordered = headers()
      first.unmount()

      renderBoard('/tms/shipments', [row('S001')])
      await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())
      expect(screen.getByRole('button', { name: 'Comfortable' })).toHaveAttribute('aria-pressed', 'true')
      expect(headers()).toEqual(reordered)
    })
  })

  describe('Active and All lists', () => {
    const released = deliveredRow('S002', { arStatus: 'UNBILLED' })
    const canceled = row('S003', { status: 'CANCELED' })
    const unreleased = deliveredRow('S001', { arStatus: 'DOCS_NEEDED' })

    it('defaults to Active: unreleased rows only, Active tab selected', async () => {
      renderBoard('/tms/shipments', [unreleased, released, canceled])
      await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())
      expect(screen.queryByText('S002')).toBeNull()
      expect(screen.queryByText('S003')).toBeNull()
      expect(screen.getByRole('tab', { name: /^Active/ })).toHaveAttribute('aria-selected', 'true')
    })

    it('?list=all also shows released rows and selects the All tab', async () => {
      renderBoard('/tms/shipments?list=all', [unreleased, released])
      await waitFor(() => expect(screen.getByText('S002')).toBeTruthy())
      expect(screen.getByText('S001')).toBeTruthy()
      expect(screen.getByRole('tab', { name: /^All/ })).toHaveAttribute('aria-selected', 'true')
    })

    it('falls back to Active on an unknown ?list=', async () => {
      renderBoard('/tms/shipments?list=bogus', [unreleased, released])
      await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())
      expect(screen.queryByText('S002')).toBeNull()
      expect(screen.getByRole('tab', { name: /^Active/ })).toHaveAttribute('aria-selected', 'true')
    })

    it('releasing a row removes it from Active on refresh', async () => {
      vi.mocked(batchShipmentTask).mockResolvedValue({ results: [{ shipmentId: 'S001', number: 'S001', ok: true, message: null }] })
      renderBoard('/tms/shipments', [unreleased])
      await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())

      __shipments = [{ ...unreleased, readyToInvoiceAt: '2026-02-01T00:00:00Z' }]
      fireEvent.click(screen.getByRole('checkbox', { name: /Release S001/i }))
      fireEvent.click(screen.getByRole('button', { name: /Batch task/i }))
      const dialog = screen.getByRole('dialog', { name: /Batch task/i })
      fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'release' } })
      fireEvent.click(screen.getByRole('button', { name: /^Run$/i }))

      await waitFor(() => expect(batchShipmentTask).toHaveBeenCalledTimes(1))
      await waitFor(() => expect(document.querySelector('table')?.textContent).not.toContain('S001'))
    })
  })
})
