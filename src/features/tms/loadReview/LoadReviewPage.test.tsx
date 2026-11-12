// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type * as ApiClient from '@/lib/apiClient'
import { LoadReviewPage } from './LoadReviewPage'

const mocks = vi.hoisted(() => ({
  shipments: vi.fn(),
  hasPageAccess: vi.fn(),
  batch: vi.fn(),
  review: vi.fn(),
  ready: vi.fn(),
  audit: vi.fn(),
  refresh: vi.fn(),
  divisions: vi.fn(),
  bundle: vi.fn(),
  groups: vi.fn(),
  release: vi.fn(),
}))

// The real apiClient builds its Amplify client on import; stub the client so nothing needs Amplify.configure().
vi.mock('aws-amplify/data', () => ({ generateClient: () => ({ graphql: vi.fn(), models: {}, queries: {}, mutations: {} }) }))
vi.mock('@/hooks/useShipments', () => ({ useShipments: mocks.shipments }))
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ hasPageAccess: mocks.hasPageAccess }),
  useAuthUser: () => ({ userId: 'u', email: 'x@bcatcorp.com', groups: mocks.groups() }),
}))
vi.mock('@/features/tms/useOwnershipDivisions', () => ({ useOwnershipDivisions: () => ({ divisions: mocks.divisions() }) }))
vi.mock('@/components/RepPicker', () => ({ RepPicker: () => <div data-testid="rep-picker" /> }))
vi.mock('@/lib/apiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  batchShipmentTask: mocks.batch,
  reviewLoad: mocks.review,
  readyToInvoice: mocks.ready,
  releaseToBilling: mocks.release,
  listAuditLogsFor: mocks.audit,
  setSalesRep: vi.fn(),
  setRevTag: vi.fn(),
  getShipmentBundle: mocks.bundle,
}))

const DAY = 86_400_000
function shipment(id: string, over: Record<string, unknown> = {}) {
  return {
    id, number: id.toUpperCase(), status: 'DELIVERED', loadReviewPushedAt: '2026-11-03T00:00:00Z', customerId: 'c-1', customerName: 'Acme',
    deliveredAt: new Date(Date.now() - 2 * DAY).toISOString(), arStatus: 'DOCS_NEEDED',
    assignmentType: 'OWN_ASSET', docsRequired: ['POD'], docsMissing: [], salesRepId: 'rep-1', revDivision: 'DRY', reference: 'PO-1',
    orderRevenueCents: 120_000, costCents: 90_000, openIncidentCount: 0, orderIds: [`o-${id}`],
    stops: [{ type: 'PICKUP', city: 'Dallas, TX', appt: '2026-01-01T10:00' }, { type: 'DELIVERY', city: 'Austin, TX', appt: '2026-01-02T10:00' }],
    ...over,
  }
}

const GATE_OK = { ok: true, missing: [] }
const ROWS = [
  shipment('s-1', { deliveredAt: new Date(Date.now() - 5 * DAY).toISOString() }),
  shipment('s-2'),
  shipment('s-3', { docsMissing: ['POD'] }),
  shipment('s-4', { loadReviewPushedAt: null }), // delivered but never released to review
  shipment('s-5', { readyToInvoiceAt: new Date().toISOString(), arStatus: 'UNBILLED' }),
  shipment('s-6', { status: 'BOOKED', deliveredAt: null, loadReviewPushedAt: null }),
  shipment('s-7', { voidedAt: new Date().toISOString() }),
]

const DRY_DIVISION = { id: 'd-dry', code: 'DRY', name: 'Dry Van', brand: null, parentId: null, color: null, sortOrder: 0, active: true, owners: null, flows: null }

function renderPage(url = '/tms/load-review') {
  return render(<MemoryRouter initialEntries={[url]}><LoadReviewPage /></MemoryRouter>)
}
const checkbox = (n: string) => screen.queryByRole('checkbox', { name: `Select ${n}` }) as HTMLInputElement | null
const moveButton = () => screen.getByRole('button', { name: 'Move to billing' }) as HTMLButtonElement

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  mocks.divisions.mockReturnValue([DRY_DIVISION])
  mocks.refresh.mockResolvedValue(undefined)
  mocks.shipments.mockReturnValue({ shipments: ROWS, loading: false, error: null, refresh: mocks.refresh })
  mocks.hasPageAccess.mockImplementation((key: string) => key === 'loads' || key === 'loadReview')
  mocks.audit.mockResolvedValue([])
  mocks.groups.mockReturnValue(['page-billingRelease'])
  mocks.release.mockResolvedValue({ warnings: [] })
  mocks.review.mockResolvedValue({
    shipmentId: 's-1', orderId: 'o-s-1', orderUpdatedAt: 'u1', arStatus: 'DOCS_NEEDED', releaseGate: GATE_OK, extras: [],
    salesRepId: 'rep-1', revDivision: 'DRY', revSubdivision: null, legacyImported: false,
  })
})

describe('LoadReviewPage inactive revenue division', () => {
  it('an inactive division blocks the row from Looks ready, with its reason, and the drawer refuses Move', async () => {
    mocks.divisions.mockReturnValue([{ ...DRY_DIVISION, active: false }])
    renderPage('/tms/load-review?tab=all')
    // Any row can be ticked for a batch edit; the reason it is not ready stays on the tick as a hover.
    expect(checkbox('S-1')!.disabled).toBe(false)
    expect(checkbox('S-1')!.title).toBe('Revenue division is inactive')
    cleanup()
    renderPage('/tms/load-review?shipment=s-1')
    expect(await screen.findByText('Revenue division is inactive')).toBeTruthy()
    expect(moveButton().disabled).toBe(true)
  })

  it('an active division record matching the row keeps it ready', () => {
    renderPage('/tms/load-review?tab=all')
    expect(checkbox('S-1')!.disabled).toBe(false)
  })
})

describe('LoadReviewPage', () => {
  it('clicking a column heading sorts the rows A to Z, then Z to A', () => {
    try { window.localStorage.clear() } catch { /* ignore */ }
    renderPage('/tms/load-review?tab=all')
    const order = () => ['S-1', 'S-2', 'S-3'].map((n) => ({ n, el: screen.getByRole('button', { name: n }) }))
      .sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)).map((x) => x.n)
    fireEvent.click(screen.getByTitle('Sort by Shipment'))
    expect(order()).toEqual(['S-1', 'S-2', 'S-3'])
    fireEvent.click(screen.getByTitle('Sort by Shipment'))
    expect(order()).toEqual(['S-3', 'S-2', 'S-1'])
  })

  it('shows each load status, and says so when a Delivered load has no delivered time recorded', async () => {
    mocks.shipments.mockReturnValue({ shipments: [...ROWS, shipment('s-8', { deliveredAt: null, stops: [] })], loading: false, error: null, refresh: mocks.refresh })
    renderPage('/tms/load-review?tab=all')
    expect(screen.getAllByText('DELIVERED').length).toBeGreaterThan(0)
    expect(screen.getByText('Delivered (no time recorded)')).toBeTruthy()
    cleanup()
    renderPage('/tms/load-review?shipment=s-8')
    expect(await screen.findByText(/Delivered \(no time recorded\)/)).toBeTruthy()
    expect(screen.getAllByText('DELIVERED').length).toBeGreaterThan(0)
  })

  it('lists only rows in the queue and offers a checkbox on every row (batch edit), release only for Looks-ready ones', () => {
    renderPage('/tms/load-review?tab=all')
    for (const n of ['S-1', 'S-2', 'S-3']) expect(screen.getByRole('button', { name: n })).toBeTruthy()
    for (const n of ['S-4', 'S-5', 'S-6', 'S-7']) expect(screen.queryByRole('button', { name: n })).toBeNull()
    expect(checkbox('S-1')!.disabled).toBe(false)
    expect(checkbox('S-2')!.disabled).toBe(false)
    expect(checkbox('S-3')!.disabled).toBe(false)
    expect(checkbox('S-3')!.title).toBe('Missing document: POD')
  })

  it('select-all picks only the eligible rows and the batch sends exactly those ids with the review marker', async () => {
    mocks.batch.mockResolvedValue({ results: [] })
    renderPage('/tms/load-review?tab=all')
    fireEvent.click(screen.getByRole('button', { name: /Select all looks ready/ }))
    expect(checkbox('S-1')!.checked).toBe(true)
    expect(checkbox('S-3')!.checked).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Move 2 to billing' }))
    expect(screen.getByText('These 2 shipments go to accounting. The server re-checks each one.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm move to billing' }))
    await waitFor(() => expect(mocks.batch).toHaveBeenCalledTimes(1))
    const call = mocks.batch.mock.calls[0][0]
    expect(call.task).toBe('RELEASE_TO_BILLING')
    expect([...call.shipmentIds].sort()).toEqual(['s-1', 's-2'])
    expect(call.params).toEqual({ review: { source: 'LOAD_REVIEW' } })
  })

  it('releases at most nine at a time: select-all stops at nine and the tenth tick is refused with a message', async () => {
    const many = Array.from({ length: 10 }, (_, i) => shipment(`m-${i + 1}`))
    mocks.shipments.mockReturnValue({ shipments: many, loading: false, error: null, refresh: mocks.refresh })
    mocks.batch.mockResolvedValue({ results: [] })
    renderPage('/tms/load-review?tab=ready')
    fireEvent.click(screen.getByRole('button', { name: /Select all looks ready/ }))
    expect(screen.getByRole('button', { name: 'Move 9 to billing' })).toBeTruthy()
    expect(screen.getByText(/at most 9/)).toBeTruthy()
    const unticked = many.map((r) => checkbox(r.number)!).find((box) => !box.checked)!
    fireEvent.click(unticked)
    expect(unticked.checked).toBe(false)
    expect(screen.getByRole('button', { name: 'Move 9 to billing' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Move 9 to billing' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm move to billing' }))
    await waitFor(() => expect(mocks.batch).toHaveBeenCalledTimes(1))
    expect(mocks.batch.mock.calls[0][0].shipmentIds).toHaveLength(9)
  })

  it('a refused row keeps the server message and stays in the queue; moved rows are reported', async () => {
    mocks.batch.mockResolvedValue({ results: [
      { shipmentId: 's-1', number: 'S-1', ok: false, message: 'Not ready for accounting: Missing sales rep' },
      { shipmentId: 's-2', number: 'S-2', ok: true },
    ] })
    renderPage('/tms/load-review?tab=ready')
    fireEvent.click(screen.getByRole('button', { name: /Select all looks ready/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Move 2 to billing' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm move to billing' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('S-1: Not ready for accounting: Missing sales rep'))
    expect(screen.getByRole('status').textContent).toContain('S-2: Moved to billing')
    expect(screen.getByText('Last attempt: Not ready for accounting: Missing sales rep')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'S-1' })).toBeTruthy()
    expect(mocks.refresh).toHaveBeenCalled()
    expect(checkbox('S-1')!.checked).toBe(false)
  })

  it('a whole-batch failure is shown and nothing is marked moved', async () => {
    mocks.batch.mockRejectedValue(new Error('Forbidden'))
    renderPage('/tms/load-review?tab=ready')
    fireEvent.click(screen.getByRole('button', { name: /Select all looks ready/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Move 2 to billing' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm move to billing' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Forbidden'))
    expect(screen.queryByText(/Moved to billing/)).toBeNull()
  })

  it('?shipment= opens the drawer, which asks the server and enables Move to billing when the gate is ok', async () => {
    mocks.review.mockResolvedValue({ ...(await mocks.review()), orderId: 'o-s-1', orderUpdatedAt: 'u1' })
    mocks.review.mockClear()
    renderPage('/tms/load-review?shipment=s-1')
    expect(mocks.review).toHaveBeenCalledWith({ shipmentId: 's-1' })
    expect(moveButton().disabled).toBe(true) // not until the server answers
    await waitFor(() => expect(moveButton().disabled).toBe(false))
    expect(screen.getByText('Ready')).toBeTruthy()
    fireEvent.click(moveButton())
    await waitFor(() => expect(mocks.ready).toHaveBeenCalledWith({ orderId: 'o-s-1', expectedUpdatedAt: 'u1', review: { source: 'LOAD_REVIEW' } }))
    await waitFor(() => expect(mocks.release).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'o-s-1' })))
  })

  it('Move to billing is disabled with the grant message for an admin who does not hold the billing grant', async () => {
    mocks.hasPageAccess.mockReturnValue(true) // ADMIN: every page, but not the per-user grant
    mocks.groups.mockReturnValue(['ADMIN'])
    renderPage('/tms/load-review?tab=ready&shipment=s-1')
    await waitFor(() => expect(screen.getByText('Ready')).toBeTruthy())
    expect(moveButton().disabled).toBe(true)
    expect(screen.getAllByText(/Release to billing \/ Send invoice/).length).toBeGreaterThan(0)
    fireEvent.click(moveButton())
    expect(mocks.ready).not.toHaveBeenCalled()
    expect(mocks.release).not.toHaveBeenCalled()
  })

  it('a batch release invoices every order of each shipment the server accepted, and reports a release refusal on that row', async () => {
    mocks.batch.mockResolvedValue({ results: [
      { shipmentId: 's-1', number: 'S-1', ok: true },
      { shipmentId: 's-2', number: 'S-2', ok: true },
    ] })
    mocks.release.mockImplementation(async ({ orderId }: { orderId: string }) => {
      if (orderId === 'o-s-2') throw new Error('BILLING_METHOD_UNSET: Acme has no billing method.')
      return { warnings: [] }
    })
    renderPage('/tms/load-review?tab=ready')
    fireEvent.click(screen.getByRole('button', { name: /Select all looks ready/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Move 2 to billing' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm move to billing' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('S-2: Moved to accounting, not invoiced: BILLING_METHOD_UNSET'))
    expect(screen.getByRole('status').textContent).toContain('S-1: Moved to billing')
    expect(mocks.release).toHaveBeenCalledTimes(2)
  })

  it('the authoritative gate overrides a cached "Looks ready": server reasons show verbatim and Move stays disabled', async () => {
    // S-2 looks ready from cached fields; the server knows the PO is missing.
    mocks.review.mockResolvedValue({
      shipmentId: 's-2', orderId: 'o-s-2', orderUpdatedAt: 'u2', arStatus: 'DOCS_NEEDED',
      releaseGate: { ok: false, missing: [{ code: 'REFERENCE_MISSING', detail: 'PO number', message: 'Missing reference: PO number' }] },
      extras: [], salesRepId: 'rep-1', revDivision: 'DRY', revSubdivision: null, legacyImported: false,
    })
    renderPage('/tms/load-review?tab=ready&shipment=s-2')
    expect(await screen.findByText('Missing reference: PO number')).toBeTruthy()
    expect(moveButton().disabled).toBe(true)
    expect(screen.getByText('1 to fix')).toBeTruthy()
  })

  it('server extras (missing rep) refuse Move even when the gate is ok', async () => {
    mocks.review.mockResolvedValue({
      shipmentId: 's-2', orderId: 'o-s-2', orderUpdatedAt: 'u2', arStatus: 'DOCS_NEEDED', releaseGate: GATE_OK,
      extras: [{ code: 'SALES_REP_MISSING', message: 'Missing sales rep', check: 'salesRep', action: { kind: 'SET_SALES_REP' } }],
      salesRepId: null, revDivision: 'DRY', revSubdivision: null, legacyImported: false,
    })
    renderPage('/tms/load-review?shipment=s-2')
    expect(await screen.findByText('Missing sales rep')).toBeTruthy()
    expect(moveButton().disabled).toBe(true)
  })

  it('an already-released order is never movable again', async () => {
    mocks.review.mockResolvedValue({
      shipmentId: 's-1', orderId: 'o-s-1', orderUpdatedAt: 'u1', arStatus: 'UNBILLED', releaseGate: GATE_OK, extras: [],
      salesRepId: 'rep-1', revDivision: 'DRY', revSubdivision: null, legacyImported: false,
    })
    renderPage('/tms/load-review?shipment=s-1')
    expect(await screen.findByText('Already released')).toBeTruthy()
    expect(moveButton().disabled).toBe(true)
  })

  it('a server refusal on Move is parsed into reasons, kept on the row as Last attempt, and the drawer stays open', async () => {
    mocks.ready.mockRejectedValue(new Error('Not ready for accounting: Missing document: POD'))
    renderPage('/tms/load-review?tab=ready&shipment=s-1')
    await waitFor(() => expect(moveButton().disabled).toBe(false))
    fireEvent.click(moveButton())
    await waitFor(() => expect(screen.getAllByText('Missing document: POD').length).toBeGreaterThan(0))
    expect(screen.getByText('Last attempt: Not ready for accounting: Missing document: POD')).toBeTruthy()
    expect(moveButton().disabled).toBe(true)
  })

  it('without the Shipments grant the drawer shows no shipment links, only the explanation', async () => {
    mocks.hasPageAccess.mockImplementation((key: string) => key === 'loadReview')
    mocks.review.mockResolvedValue({
      shipmentId: 's-3', orderId: 'o-s-3', orderUpdatedAt: 'u3', arStatus: 'DOCS_NEEDED',
      releaseGate: { ok: false, missing: [{ code: 'DOC_MISSING', detail: 'POD', message: 'Missing document: POD' }] },
      extras: [], salesRepId: 'rep-1', revDivision: 'DRY', revSubdivision: null, legacyImported: false,
    })
    renderPage('/tms/load-review?shipment=s-3')
    await screen.findByText('Missing document: POD')
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).queryAllByRole('link')).toHaveLength(0)
    expect(within(dialog).getAllByTitle('Needs the Shipments grant').length).toBeGreaterThan(0)
  })

  it('with the Shipments grant the same drawer links to the shipment tab and the review inbox', async () => {
    mocks.review.mockResolvedValue({
      shipmentId: 's-3', orderId: 'o-s-3', orderUpdatedAt: 'u3', arStatus: 'DOCS_NEEDED',
      releaseGate: { ok: false, missing: [{ code: 'DOC_MISSING', detail: 'POD', message: 'Missing document: POD' }] },
      extras: [], salesRepId: 'rep-1', revDivision: 'DRY', revSubdivision: null, legacyImported: false,
    })
    renderPage('/tms/load-review?shipment=s-3')
    await screen.findByText('Missing document: POD')
    const hrefs = within(screen.getByRole('dialog')).getAllByRole('link').map((a) => a.getAttribute('href'))
    expect(hrefs).toContain('/tms/shipments/s-3?tab=documents')
    expect(hrefs).toContain('/tms/tracking?assignee=all&focus=docs')
  })

  it('with two carriers the drawer shows both bills side by side and Move stays blocked with the sentences that name the carrier', async () => {
    mocks.shipments.mockReturnValue({
      shipments: [shipment('s-m', { assignmentType: 'CARRIER', carrierName: 'Swift', carrierCount: 2, carriers: [{ name: 'Swift', apStatus: 'IN_REVIEW', costCents: 60_000 }, { name: 'Heartland', apStatus: 'AWAITING_INVOICE', costCents: 20_000 }] })],
      loading: false, error: null, refresh: mocks.refresh,
    })
    const lc = (id: string, name: string, sequence: number, over: Record<string, unknown> = {}) => ({ id, loadId: 'load-1', kind: 'CARRIER', status: 'ACTIVE', carrierName: name, sequence, rateConStatus: 'SIGNED', invoiceId: null, ...over })
    mocks.bundle.mockResolvedValue({
      loads: [{ id: 'load-1' }],
      loadCarriers: [lc('lc-a', 'Swift', 1, { invoiceId: 'cb:lc-a:1' }), lc('lc-b', 'Heartland', 2, { rateConStatus: 'SENT' })],
      charges: [
        { id: 'c1', side: 'CUSTOMER', code: 'LINEHAUL', amountCents: 100_000, loadCarrierId: null, isRate: true },
        { id: 'c2', side: 'CARRIER', code: 'LINEHAUL', amountCents: 60_000, loadCarrierId: 'lc-a', isRate: true },
        { id: 'c3', side: 'CARRIER', code: 'LINEHAUL', amountCents: 20_000, loadCarrierId: 'lc-b', isRate: true },
      ],
    })
    mocks.review.mockResolvedValue({
      shipmentId: 's-m', orderId: 'o-s-m', orderUpdatedAt: 'u1', arStatus: 'DOCS_NEEDED',
      releaseGate: { ok: false, missing: [
        { code: 'CARRIER_CHARGES_UNSETTLED', detail: 'Heartland', message: 'Carrier bill not recorded: Heartland' },
        { code: 'DOC_MISSING', detail: 'RATE_CON', message: 'Missing document: RATE_CON (unsigned: Heartland)' },
      ] },
      extras: [], salesRepId: 'rep-1', revDivision: 'DRY', revSubdivision: null, legacyImported: false,
    })
    renderPage('/tms/load-review?shipment=s-m')
    expect(await screen.findByText('Carrier bill not recorded: Heartland')).toBeTruthy()
    expect(screen.getByText('Missing document: RATE_CON (unsigned: Heartland)')).toBeTruthy()
    expect(await screen.findByTestId('carrier-bill-lc-a')).toBeTruthy()
    expect(screen.getByTestId('carrier-bill-lc-b').textContent).toContain('Bill not recorded')
    expect(screen.getByText(/2 carriers/)).toBeTruthy()
    expect(moveButton().disabled).toBe(true)
  })

  it('a server failure on open is shown in the drawer and Move stays disabled', async () => {
    mocks.review.mockRejectedValue(new Error('Forbidden: needs page-loadReview'))
    renderPage('/tms/load-review?shipment=s-1')
    expect(await screen.findByText('Forbidden: needs page-loadReview')).toBeTruthy()
    expect(moveButton().disabled).toBe(true)
  })

  it('?shipment= for a load outside the working set is fetched by id and opens the drawer', async () => {
    const outside = shipment('s-out', { readyToInvoiceAt: new Date().toISOString(), arStatus: 'UNBILLED' })
    mocks.shipments.mockImplementation((view: { kind: string; ids?: string[] }) => ({
      shipments: view.kind === 'ids' ? (view.ids ?? []).map((id) => (id === 's-out' ? outside : null)).filter(Boolean) : ROWS,
      loading: false, error: null, refresh: mocks.refresh,
    }))
    renderPage('/tms/load-review?shipment=s-out')
    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect(mocks.review).toHaveBeenCalledWith({ shipmentId: 's-out' })
    expect(mocks.shipments).not.toHaveBeenCalledWith({ kind: 'ids', ids: ['s-1'] })
  })
})
