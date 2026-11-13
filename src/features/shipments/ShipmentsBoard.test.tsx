// @vitest-environment jsdom
import { ShipmentTabsProvider } from './tabs/ShipmentTabsProvider'
import { ShipmentTabStrip } from './tabs/ShipmentTabStrip'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, fireEvent, waitFor, act, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import type { ShipmentColumnTemplateRecord } from '@/types/tms'
import { ShipmentsBoard } from './ShipmentsBoard'
import { ALJEX_COLUMN_KEYS } from '@/lib/shipmentViewDefs'
import type { ShipmentRow } from './shipmentViews'
import { chicagoYear } from '@/lib/date'
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
    createdAt: `${chicagoYear()}-01-01T12:00:00.000Z`,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  } as ShipmentRow
}

function deliveredRow(id: string, patch: Partial<ShipmentRow> = {}): ShipmentRow {
  return row(id, {
    status: 'DELIVERED',
    docsMissing: [],
    rateConOnFile: true, // a delivered shipment is only complete with a POD and an RC
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

vi.mock('@/hooks/useCarriers', () => ({
  useCarriers: () => ({ carriers: [], loading: false, error: null }),
}))
vi.mock('@/hooks/useDirectory', () => ({
  useDirectory: () => ({ customers, locations: [] }),
}))

const refresh = vi.fn()
let __shipments: ShipmentRow[] = []
const __views: unknown[] = []
const __searchIds = vi.fn(async (_term?: unknown, _limit?: unknown): Promise<{ ids: string[]; capped: boolean }> => ({ ids: [], capped: false }))
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
  countOpenIntakeLoads: async () => 0,
  listShipmentColumnTemplates,
  listShipmentsByNumber: async () => [],
  listShipmentIdsBySearch: (...args: unknown[]) => __searchIds(...args),
  saveShipmentView,
  archiveShipmentView,
  saveShipmentColumnTemplate,
  deleteShipmentColumnTemplate,
  setShipmentStatus,
  duplicateShipment,
  tenderRespond,
  setSalesRep,
  readyToInvoice,
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
      <ShipmentTabsProvider>
      <ShipmentTabStrip />
      <Routes>
        <Route path="/tms/shipments" element={<ShipmentsBoard />} />
        <Route path="/tms/shipments/intake" element={<div>intake page</div>} />
        <Route path="/tms/shipments/new" element={<div>shipment form page</div>} />
      </Routes>
      </ShipmentTabsProvider>
    </MemoryRouter>,
  )
}

/** Opens a column's header filter and ticks one option of its multi-select. */
function pickFacet(header: string, option: string) {
  const trigger = screen.getByRole('button', { name: `Filter ${header}` })
  if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('checkbox', { name: `${header}: ${option}` }))
}

/** The team default shows the full Aljex set: the built-in default is the short one, so tests of other columns opt in. */
function saveFullColumnLayout() {
  vi.mocked(listShipmentColumnTemplates).mockResolvedValue([
    teamTemplate(['proNumber', ...ALJEX_COLUMN_KEYS.filter((k) => k !== 'proNumber')]),
  ])
}

function teamTemplate(columns: string[], widths: Record<string, number> = {}, pinned: string[] = []): ShipmentColumnTemplateRecord {
  return {
    id: 'shipments-team-default', name: 'Shipments team default', columns, widths, pinned, ownerEmail: 'ryne@bcatcorp.com',
    shared: true, createdBy: 'ryne@bcatcorp.com', updatedBy: 'ryne@bcatcorp.com', version: 1, createdAt: '', updatedAt: '',
  }
}

describe('ShipmentsBoard', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    __views.length = 0
    vi.mocked(listShipmentColumnTemplates).mockResolvedValue([])
    auth.isAdmin = true
    auth.isOwner = false
  })


  it('reads only the working set until the Voided list or the All list asks for a month window', async () => {
    renderBoard('/tms/shipments', [row('S001', { status: 'OPEN' })])
    await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())
    const windows = () => __views.filter((v) => (v as { kind: string }).kind === 'window') as Array<{ months: string[]; includeVoided?: boolean }>
    expect(windows().every((w) => w.months.length === 0)).toBe(true)

    fireEvent.click(screen.getByRole('tab', { name: /Voided/ }))
    await waitFor(() => expect(windows().some((w) => w.months.length > 0 && w.includeVoided === true)).toBe(true))
  })

  it('the Voided list reads a period with voided rows included and lists only voided shipments', async () => {
    renderBoard('/tms/shipments?list=voided', [row('S001', { status: 'OPEN' }), row('S002', { status: 'OPEN', voidedAt: '2026-01-02T00:00:00Z' })])
    await waitFor(() => expect(screen.getByText('S002')).toBeTruthy())
    expect(screen.queryByText('S001')).toBeNull()
    const windows = __views.filter((v) => (v as { kind: string }).kind === 'window') as Array<{ months: string[]; includeVoided?: boolean }>
    expect(windows.some((w) => w.months.length > 0 && w.includeVoided === true)).toBe(true)
  })

  it('All and Active never list a voided shipment, even when the status facet is asked for it', async () => {
    renderBoard('/tms/shipments?list=all', [row('S001', { status: 'OPEN' }), row('S002', { status: 'OPEN', voidedAt: '2026-01-02T00:00:00Z' })])
    await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())
    expect(screen.queryByText('S002')).toBeNull()
  })

  it('the All list asks for the twelve months of the current year without voided rows', async () => {
    renderBoard('/tms/shipments?list=all', [row('S001')])
    await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())
    const asked = (__views as Array<{ kind: string; months?: string[]; includeVoided?: boolean }>).filter((v) => v.kind === 'window' && v.months!.length > 0)
    expect(asked.length).toBeGreaterThan(0)
    expect(asked.every((w) => w.months!.length === 12 && w.months![0] === `${chicagoYear()}-01` && !w.includeVoided)).toBe(true)
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
    cleanup()

    renderBoard('/tms/shipments?list=voided', shipments)
    await waitFor(() => expect(screen.getByText('S002')).toBeTruthy())

    const voidedRowEl = screen.getByText('S002').closest('tr')!
    expect(voidedRowEl).toHaveAttribute('data-tone', 'voided')
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
    saveFullColumnLayout()
    const shipments = [deliveredRow('S001', { customerReference: 'PO-123', equipmentType: 'Van', revenueCents: 100_000 })]
    renderBoard('/tms/shipments', shipments)
    await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /Export to CSV/i }))

    await waitFor(() => expect(saveBlob).toHaveBeenCalled())
    const blob = saveBlob.mock.calls[0][0] as Blob
    const csv = await blob.text()
    expect(csv).toContain('Status')
    expect(csv).toContain('PRO #')
    expect(csv).toContain('Customer Ref #')
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
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'status:ON_HOLD' } })
    fireEvent.click(screen.getByRole('button', { name: /^Run$/i }))

    await waitFor(() => expect(batchShipmentTask).toHaveBeenCalledTimes(1))
    expect(batchShipmentTask).toHaveBeenCalledWith(expect.objectContaining({
      task: 'SET_STATUS',
      shipmentIds: ['S001', 'S002'],
      params: { status: 'ON_HOLD', reason: 'Batch task' },
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
    saveFullColumnLayout()
    renderBoard('/tms/shipments', [
      row('S001', { assignmentType: 'OWN_ASSET', driverId: null }),
      row('S002', { assignmentType: 'OWN_ASSET', driverId: 'drv-1', driverName: 'Dana Driver' }),
      row('S003', { assignmentType: 'OWN_ASSET', driverId: null, voidedAt: '2026-02-01T00:00:00Z' }),
      row('S004', { assignmentType: 'CARRIER', carrierName: 'Swift' }),
    ])
    await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())
    expect(document.querySelectorAll('[title="Ivan Cartage load with no driver"]')).toHaveLength(1)
    expect(screen.getAllByText('Ivan Cartage · no driver')).toHaveLength(1)
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
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Batch task/i })) })
    const dialog = await screen.findByRole('dialog', { name: /Batch task/i })

    expect(within(dialog).queryByText(/Off Driver/)).toBeNull()
    expect(within(dialog).queryByText(/BROKER COVERED/)).toBeNull()
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'driver:drv-1' } })
    expect(within(dialog).getByRole('option', { name: 'Assign driver (Ivan Cartage): Dana Driver' })).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Run$/i })) })

    await waitFor(() => expect(batchShipmentTask).toHaveBeenCalledTimes(1))
    expect(batchShipmentTask).toHaveBeenCalledWith({
      task: 'ASSIGN_DRIVER',
      shipmentIds: ['S001'],
      params: { driverId: 'drv-1', truckId: 'trk-1', truckNumber: '101' },
    })
    await waitFor(() => expect(screen.getByText('Delivered 2026-10-14: that pay week has closed.')).toBeTruthy())
    // The board subscribes to the store; reset it inside act so the re-render is not un-acted.
    await act(async () => { useAppStore.setState({ drivers: [], equipment: [] }) })
  })

  it('Create shipment opens the new-shipment form, not the mint utility, and needs no admin rights', async () => {
    auth.isAdmin = false
    auth.isOwner = false
    renderBoard('/tms/shipments')
    fireEvent.click(await screen.findByRole('button', { name: 'Create shipment' }))
    expect(await screen.findByText('shipment form page')).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('the stats strip shows Brokerage gross profit and hides Assets until asset costs are attached', async () => {
    renderBoard('/tms/shipments', [
      row('S001', { status: 'DELIVERED', revDivision: 'BROKERAGE', revenueCents: 100_000, profitCents: 20_000 }),
      row('S002', { status: 'DELIVERED', revDivision: 'ASSETS', revSubdivision: 'LOCAL', revenueCents: 50_000, profitCents: 50_000 }),
    ])
    await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())
    const strip = screen.getByRole('region', { name: 'Summary' })
    expect(strip).toHaveTextContent('Brokerage')
    expect(strip).toHaveTextContent('$200.00 (20%)')
    expect(strip).not.toHaveTextContent('Assets $')
    expect(strip).not.toHaveTextContent('(100%)')
    expect(strip).not.toHaveTextContent('Other')
    expect(strip.querySelector('.tms-dg-kpi-split')?.getAttribute('title')).toContain('Assets is hidden until asset costs are attached')
  })

  it('revenue and gross profit count only delivered shipments, and the strip says so', async () => {
    renderBoard('/tms/shipments', [
      row('S001', { status: 'DELIVERED', revDivision: 'BROKERAGE', revenueCents: 100_000, profitCents: 20_000 }),
      row('S002', { status: 'OPEN', revDivision: 'BROKERAGE', revenueCents: 900_000, profitCents: 300_000 }),
      row('S003', { status: 'IN_TRANSIT', revDivision: 'ASSETS', revSubdivision: 'LOCAL', revenueCents: 50_000, profitCents: 10_000 }),
    ])
    await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())
    const strip = screen.getByRole('region', { name: 'Summary' })
    expect(strip).toHaveTextContent('Delivered revenue')
    expect(strip).toHaveTextContent('$1,000.00Delivered revenue')
    expect(strip).toHaveTextContent('Delivered gross profit')
    expect(strip).toHaveTextContent('$200.00 (20%)')
    expect(strip).not.toHaveTextContent('$3,000.00')
    expect(strip.querySelector('.tms-dg-kpi-split')?.getAttribute('title')).toContain('Counts only delivered shipments')
    expect(strip).toHaveTextContent('3Shipments')
  })

  it('flags live shipments past their delivery date and the strip count filters to them', async () => {
    const past = new Date(Date.now() - 3 * 86_400_000).toISOString()
    renderBoard('/tms/shipments', [
      row('S001', { status: 'IN_TRANSIT', deliveryAppt: past }),
      row('S002', { status: 'DELIVERED', deliveryAppt: past }),
      row('S003', { status: 'OPEN', deliveryAppt: new Date(Date.now() + 3 * 86_400_000).toISOString() }),
    ])
    await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())
    expect(screen.getAllByTestId('past-delivery-pill')).toHaveLength(1)
    const toggle = screen.getByRole('button', { name: /Past delivery date/ })
    expect(toggle).toHaveTextContent('1')
    fireEvent.click(toggle)
    await waitFor(() => expect(screen.queryByText('S003')).toBeNull())
    expect(screen.getByText('S001')).toBeTruthy()
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
  })

  it('shows the tracking chip beside the carrier name and keeps past delivery beside status', async () => {
    const past = new Date(Date.now() - 3 * 86_400_000).toISOString()
    renderBoard('/tms/shipments', [
      row('S001', { status: 'DISPATCHED', revDivision: 'BROKERAGE', assignmentType: 'CARRIER', carrierName: 'Swift', deliveryAppt: past }),
    ])
    await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())
    const chip = screen.getByTestId('tracking-not-set')
    expect(chip.closest('td')?.getAttribute('data-col')).toBe('carrier')
    expect(within(chip.closest('td') as HTMLElement).getByText('Swift')).toBeTruthy()
    expect(screen.getByTestId('past-delivery-pill').closest('td')?.getAttribute('data-col')).toBe('status')
  })

  it('has no Demo chip', async () => {
    renderBoard('/tms/shipments')
    await screen.findByRole('textbox', { name: 'Search shipments' })
    expect(screen.queryByText('Demo')).toBeNull()
  })

  it('Unvoid requires a reason', async () => {
    const shipments = [row('S001', { status: 'CANCELED', voidedAt: '2026-02-01T00:00:00Z', voidedBy: 'admin', voidReason: 'test' })]
    renderBoard('/tms/shipments?list=voided', shipments)
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
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Re-point$/i })) })
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
    const credit1 = await screen.findByRole('button', { name: /Credit original and rebill/i })
    await act(async () => { fireEvent.click(credit1) })
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
    const credit2 = await screen.findByRole('button', { name: /Credit original and rebill/i })
    await act(async () => { fireEvent.click(credit2) })
    await waitFor(() => expect(repointInvoicedCustomer).toHaveBeenCalledTimes(2))
    expect(repointInvoicedCustomer.mock.calls[1][0].idempotencyKey).not.toBe(firstKey)
  })

  it('Unvoid surfaces a stale-token refusal as a readable message', async () => {
    const shipments = [row('S001', { status: 'CANCELED', voidedAt: '2026-02-01T00:00:00.000Z', voidedBy: 'admin', voidReason: 'test' })]
    renderBoard('/tms/shipments?list=voided', shipments)
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
    saveFullColumnLayout()
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
    saveFullColumnLayout()
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
    const pros = () => {
      const at = [...document.querySelectorAll('thead th')].findIndex((th) => th.textContent === 'PRO #')
      return [...document.querySelectorAll('tbody tr[data-tone]')].map((tr) => tr.querySelectorAll('td')[at]?.textContent)
    }

    it('opens with Status, RC, POD, PRO # and Customer Ref # fixed on the left, no side panel and the stats strip always on', async () => {
      renderBoard('/tms/shipments', [row('S001')])
      await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())
      const heads = [...document.querySelectorAll('thead th')].slice(1, 6)
      expect(heads.map((h) => h.textContent)).toEqual(['Status', 'RC', 'POD', 'PRO #', 'Customer Ref #'])
      expect(heads[0]).toHaveClass('tms-dg-sticky')
      expect(screen.queryByText('Statuses')).toBeNull()
      expect(screen.getByRole('region', { name: 'Summary' })).toHaveTextContent('Shipments')
      expect(screen.queryByRole('button', { name: /Summary/ })).toBeNull()
      expect(screen.getByRole('button', { name: 'Create shipment' })).toBeTruthy()
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
      saveFullColumnLayout()
      renderBoard('/tms/shipments', [row('S001', { customerReference: 'PO-100' }), row('S002', { customerReference: 'PO-200' })])
      await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())
      fireEvent.click(screen.getByRole('button', { name: 'Filter Customer Ref #' }))
      fireEvent.change(screen.getByRole('textbox', { name: 'Filter Customer Ref #' }), { target: { value: 'PO-2' } })
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

    it('lists a released delivered shipment as Released on All, and keeps Delivered for an unreleased one', async () => {
      renderBoard('/tms/shipments?list=all', [unreleased, released])
      await waitFor(() => expect(screen.getByText('S002')).toBeTruthy())
      expect(within(screen.getByText('S002').closest('tr')!).getByText(/^RELEASED/)).toBeTruthy()
      expect(within(screen.getByText('S001').closest('tr')!).getByText(/^DELIVERED/)).toBeTruthy()
    })

    it('All defaults to this year, lists every year found, and All years shows the rest', async () => {
      const year = chicagoYear()
      const old = deliveredRow('S900', { arStatus: 'UNBILLED', createdAt: `${year - 2}-03-01T12:00:00.000Z`, pickupMonth: `${year - 2}-03` })
      const current = deliveredRow('S901', { arStatus: 'UNBILLED', pickupMonth: `${year}-02` })
      renderBoard('/tms/shipments?list=all', [old, current])
      await waitFor(() => expect(screen.getByText('S901')).toBeTruthy())
      expect(screen.queryByText('S900')).toBeNull()
      const select = screen.getByRole('combobox', { name: 'Year' }) as HTMLSelectElement
      expect([...select.options].map((o) => o.text)).toEqual(['All years', String(year), String(year - 2)])
      expect(select.value).toBe(String(year))

      fireEvent.change(select, { target: { value: 'all' } })
      await waitFor(() => expect(screen.getByText('S900')).toBeTruthy())
      expect(screen.getByText('S901')).toBeTruthy()
      expect((__views as Array<{ kind: string }>).some((v) => v.kind === 'all')).toBe(true)

      fireEvent.change(select, { target: { value: String(year - 2) } })
      await waitFor(() => expect(screen.queryByText('S901')).toBeNull())
      expect(screen.getByText('S900')).toBeTruthy()
      expect([...select.options].map((o) => o.text)).toContain(String(year))
    })

    it('a search typed on Active also finds released shipments, says so, and clearing it returns to plain Active', async () => {
      renderBoard('/tms/shipments', [unreleased, released, canceled])
      await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())
      expect(screen.queryByTestId('search-all-note')).toBeNull()
      const box = screen.getByRole('textbox', { name: 'Search shipments' })
      fireEvent.change(box, { target: { value: 'S002' } })
      await waitFor(() => expect(screen.getByText('S002')).toBeTruthy())
      expect(screen.queryByText('S001')).toBeNull()
      expect(screen.getByTestId('search-all-note').textContent).toBe('Searching all shipments (all years, incl. voided): 1 match, 1 not in Active')
      fireEvent.change(box, { target: { value: '' } })
      await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())
      expect(screen.queryByText('S002')).toBeNull()
      expect(screen.queryByTestId('search-all-note')).toBeNull()
    })

    it('a search typed on Active asks for the All list data, and a global-search link (?q=) does the same', async () => {
      renderBoard('/tms/shipments?q=S002', [unreleased, released])
      await waitFor(() => expect(screen.getByText('S002')).toBeTruthy())
      const asked = (__views as Array<{ kind: string; months?: string[]; includeVoided?: boolean }>).filter((v) => v.kind === 'window' && v.months!.length > 0)
      expect(asked.some((w) => w.months!.length === 12 && !w.includeVoided)).toBe(true)
    })

    it('a search on Active lists a voided shipment only when the all-years search found it, marked VOIDED', async () => {
      const voided = row('S004', { status: 'OPEN', voidedAt: '2026-01-02T00:00:00Z' })
      __searchIds.mockResolvedValueOnce({ ids: [], capped: false })
      renderBoard('/tms/shipments?q=S00', [unreleased, voided])
      await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())
      await waitFor(() => expect(__searchIds).toHaveBeenCalledWith('S00', 300))
      expect(screen.queryByText('S004')).toBeNull()
    })

    it('shows the voided shipment the all-years search returns, and says the first 300 are shown when capped', async () => {
      const voided = row('S004', { status: 'OPEN', voidedAt: '2026-01-02T00:00:00Z' })
      __searchIds.mockResolvedValueOnce({ ids: ['S004'], capped: true })
      renderBoard('/tms/shipments?q=S00', [unreleased, voided])
      await waitFor(() => expect(screen.getByText('S004')).toBeTruthy())
      expect(within(screen.getByText('S004').closest('tr')!).getByText(/VOIDED/)).toBeTruthy()
      expect(screen.getByTestId('search-all-note').textContent).toMatch(/incl\. voided/)
      expect(screen.getByTestId('search-all-note').textContent).toMatch(/first 300 — refine your search/)
    })

    it('does not run the all-years scan for a one- or two-character search, and asks once per term', async () => {
      renderBoard('/tms/shipments', [unreleased])
      await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())
      const box = screen.getByRole('textbox', { name: 'Search shipments' })
      fireEvent.change(box, { target: { value: 'S0' } })
      await new Promise((r) => setTimeout(r, 700))
      expect(__searchIds).not.toHaveBeenCalled()
      fireEvent.change(box, { target: { value: 'S001' } })
      await waitFor(() => expect(__searchIds).toHaveBeenCalledTimes(1))
      fireEvent.change(box, { target: { value: '' } })
      fireEvent.change(box, { target: { value: 'S001' } })
      await new Promise((r) => setTimeout(r, 700))
      expect(__searchIds).toHaveBeenCalledTimes(1)
    })

    it('falls back to Active on an unknown ?list=', async () => {
      renderBoard('/tms/shipments?list=bogus', [unreleased, released])
      await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())
      expect(screen.queryByText('S002')).toBeNull()
      expect(screen.getByRole('tab', { name: /^Active/ })).toHaveAttribute('aria-selected', 'true')
    })
  })
  describe('Step AP: chips and Push to Load Review', () => {
    const complete = { reference: 'PO-1', salesRepId: 'rep-1', revDivision: 'ASSETS', docsRequired: ['POD'], docsMissing: [] as string[] }
    it('refuses the 10th selected row with a message and keeps nine', async () => {
      const rows = Array.from({ length: 10 }, (_, i) => deliveredRow(`S${String(i + 1).padStart(3, '0')}`, complete))
      renderBoard('/tms/shipments', rows)
      await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())
      for (const r of rows) fireEvent.click(screen.getByRole('checkbox', { name: `Select row ${r.id}` }))
      expect(screen.getByTestId('batch-cap-message').textContent).toMatch(/at most 9/)
      expect(screen.getByText('9 selected (max 9)')).toBeTruthy()
    })

    it('offers Push to Load Review and no Release on the board', async () => {
      renderBoard('/tms/shipments', [deliveredRow('S001', complete)])
      await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())
      fireEvent.click(screen.getByRole('checkbox', { name: 'Select row S001' }))
      expect(screen.getByRole('button', { name: 'Push to Load Review' })).toBeTruthy()
      expect(screen.queryByRole('button', { name: /^Release/ })).toBeNull()
      expect(screen.queryByRole('checkbox', { name: /^Release / })).toBeNull()
    })

    it('blocks failing rows with per-row reasons, sends only the rest, and reports partial success', async () => {
      batchShipmentTask.mockClear()
      batchShipmentTask.mockResolvedValueOnce({ results: [{ shipmentId: 'S001', number: 'S001', ok: true, message: null }] })
      renderBoard('/tms/shipments', [
        deliveredRow('S001', complete),
        deliveredRow('S002', { ...complete, salesRepId: null, reference: null }),
      ])
      await waitFor(() => expect(screen.getByText('S001')).toBeTruthy())
      fireEvent.click(screen.getByRole('checkbox', { name: 'Select all rows' }))
      fireEvent.click(screen.getByRole('button', { name: 'Push to Load Review' }))
      await waitFor(() => expect(screen.getByTestId('batch-result-S002')).toBeTruthy())
      expect(batchShipmentTask).toHaveBeenCalledWith({ task: 'PUSH_TO_LOAD_REVIEW', shipmentIds: ['S001'], params: {} })
      expect(screen.getByTestId('batch-result-S001')).toHaveAttribute('data-ok', 'true')
      const failed = screen.getByTestId('batch-result-S002')
      expect(failed).toHaveAttribute('data-ok', 'false')
      expect(failed.textContent).toContain('Missing sales rep')
      expect(failed.textContent).toContain('Missing reference #')
      expect(screen.getByTestId('batch-results').textContent).toContain('1 of 2 done, 1 not done')
    })
  })
})

describe('ShipmentsBoard team column layout', () => {
  const headers = () => screen.getAllByRole('columnheader').map((h) => h.textContent ?? '')

  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    __views.length = 0
    vi.mocked(listShipmentColumnTemplates).mockResolvedValue([])
    auth.isAdmin = true
    auth.isOwner = false
  })

  it('shows the saved team default to everyone, ignoring a personal layout in localStorage', async () => {
    auth.isAdmin = false
    localStorage.setItem('tms:grid:shipments-left:ryne@bcatcorp.com:v1', JSON.stringify({ columns: ['proNumber', 'destinationCity'] }))
    vi.mocked(listShipmentColumnTemplates).mockResolvedValue([teamTemplate(['proNumber', 'originCity'])])
    renderBoard('/tms/shipments', [row('S001')])
    await waitFor(() => expect(headers().join('|')).toContain('Origin'))
    expect(headers().join('|')).not.toContain('Destination')
  })

  it('falls back to the built-in default columns when no team default exists', async () => {
    renderBoard('/tms/shipments', [row('S001')])
    await screen.findByText('S001')
    expect(headers().join('|')).toContain('Destination')
    expect(headers().join('|')).toContain('Customer Ref #')
  })

  it('the frozen columns and their order come from the layout: pinned columns lead the grid and are sticky', async () => {
    vi.mocked(listShipmentColumnTemplates).mockResolvedValue([teamTemplate(['proNumber', 'status', 'customerName', 'originCity'], {}, ['customerName', 'originCity'])])
    renderBoard('/tms/shipments', [row('S001')])
    await screen.findByText('S001')
    const heads = [...document.querySelectorAll('thead th')].slice(1, 5)
    expect(heads.map((h) => h.textContent)).toEqual(['Customer', 'Origin', 'PRO #', 'Status'])
    expect(heads[0]).toHaveClass('tms-dg-sticky')
    expect(heads[1]).toHaveClass('tms-dg-sticky')
    expect(heads[2]).not.toHaveClass('tms-dg-sticky')
  })

  it('a non-admin gets no layout editing at all', async () => {
    auth.isAdmin = false
    renderBoard('/tms/shipments', [row('S001')])
    await screen.findByText('S001')
    expect(screen.queryByRole('button', { name: /Edit layout/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Columns$/ })).toBeNull()
    expect(screen.queryByLabelText('Column template')).toBeNull()
  })

  it('an admin edits the layout and saves it as the team default', async () => {
    vi.mocked(saveShipmentColumnTemplate).mockResolvedValue({})
    vi.mocked(listShipmentColumnTemplates).mockResolvedValue([teamTemplate(['proNumber', 'originCity'])])
    renderBoard('/tms/shipments', [row('S001')])
    await screen.findByText('S001')
    fireEvent.click(screen.getByRole('button', { name: /Edit layout/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Columns$/ }))
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Destination' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save as team default' }))
    await waitFor(() => expect(saveShipmentColumnTemplate).toHaveBeenCalledTimes(1))
    expect(vi.mocked(saveShipmentColumnTemplate).mock.calls[0][0]).toMatchObject({
      id: 'shipments-team-default',
      shared: true,
      columns: ['proNumber', 'originCity', 'destinationCity'],
    })
  })

  it('saves the column widths with the team default, and the saved widths are what the board shows', async () => {
    vi.mocked(saveShipmentColumnTemplate).mockResolvedValue({})
    vi.mocked(listShipmentColumnTemplates).mockResolvedValue([teamTemplate(['proNumber', 'originCity'])])
    renderBoard('/tms/shipments', [row('S001')])
    await screen.findByText('S001')
    fireEvent.click(screen.getByRole('button', { name: /Edit layout/ }))
    fireEvent.click(screen.getByRole('button', { name: /Fit widths/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Save as team default' }))
    await waitFor(() => expect(saveShipmentColumnTemplate).toHaveBeenCalledTimes(1))
    const saved = vi.mocked(saveShipmentColumnTemplate).mock.calls[0][0] as { widths: Record<string, number> }
    expect(Object.keys(saved.widths).sort()).toEqual(['originCity', 'proNumber'])
  })

  it('a width saved in the team default is applied exactly, even narrower than the text', async () => {
    vi.mocked(listShipmentColumnTemplates).mockResolvedValue([teamTemplate(['proNumber', 'originCity'], { originCity: 321, proNumber: 77 })])
    renderBoard('/tms/shipments', [row('S001')])
    await screen.findByText('S001')
    const widths = [...document.querySelectorAll('colgroup col')].map((c) => parseInt((c as HTMLElement).style.width, 10))
    expect(widths).toContain(321)
    expect(widths).toContain(77)
  })

  it('an admin pins a column in Edit layout > Columns, and the pin is saved with the team default', async () => {
    vi.mocked(saveShipmentColumnTemplate).mockResolvedValue({})
    vi.mocked(listShipmentColumnTemplates).mockResolvedValue([teamTemplate(['proNumber', 'status', 'originCity'], {}, ['proNumber'])])
    renderBoard('/tms/shipments', [row('S001')])
    await screen.findByText('S001')
    fireEvent.click(screen.getByRole('button', { name: /Edit layout/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Columns$/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Pin Origin' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save as team default' }))
    await waitFor(() => expect(saveShipmentColumnTemplate).toHaveBeenCalledTimes(1))
    const saved = vi.mocked(saveShipmentColumnTemplate).mock.calls[0][0] as { pinned: string[]; columns: string[] }
    expect(saved.pinned).toEqual(['proNumber', 'originCity'])
    expect(saved.columns.slice(0, 2)).toEqual(['proNumber', 'originCity'])
  })

  it('after Apply the layout shows Not saved yet until it is saved as the team default', async () => {
    vi.mocked(saveShipmentColumnTemplate).mockResolvedValue({})
    vi.mocked(listShipmentColumnTemplates).mockResolvedValue([teamTemplate(['proNumber', 'originCity'])])
    renderBoard('/tms/shipments', [row('S001')])
    await screen.findByText('S001')
    fireEvent.click(screen.getByRole('button', { name: /Edit layout/ }))
    expect(screen.queryByTestId('layout-unsaved')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Columns$/ }))
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Destination' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(screen.getByTestId('layout-unsaved')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save as team default' }))
    await waitFor(() => expect(saveShipmentColumnTemplate).toHaveBeenCalledTimes(1))
  })

  it('Cancel drops the unsaved layout edit', async () => {
    renderBoard('/tms/shipments', [row('S001')])
    await screen.findByText('S001')
    fireEvent.click(screen.getByRole('button', { name: /Edit layout/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Columns$/ }))
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Destination' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(headers().join('|')).not.toContain('Destination')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(headers().join('|')).toContain('Destination')
    expect(saveShipmentColumnTemplate).not.toHaveBeenCalled()
  })
})
