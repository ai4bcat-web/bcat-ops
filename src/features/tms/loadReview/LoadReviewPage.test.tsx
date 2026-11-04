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
}))

vi.mock('@/hooks/useShipments', () => ({ useShipments: mocks.shipments }))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ hasPageAccess: mocks.hasPageAccess }) }))
vi.mock('@/features/tms/useOwnershipDivisions', () => ({ useOwnershipDivisions: () => ({ divisions: mocks.divisions() }) }))
vi.mock('@/components/RepPicker', () => ({ RepPicker: () => <div data-testid="rep-picker" /> }))
vi.mock('@/lib/apiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  batchShipmentTask: mocks.batch,
  reviewLoad: mocks.review,
  readyToInvoice: mocks.ready,
  listAuditLogsFor: mocks.audit,
  setSalesRep: vi.fn(),
  setRevTag: vi.fn(),
}))

const DAY = 86_400_000
function shipment(id: string, over: Record<string, unknown> = {}) {
  return {
    id, number: id.toUpperCase(), status: 'DELIVERED', customerId: 'c-1', customerName: 'Acme',
    deliveredAt: new Date(Date.now() - 2 * DAY).toISOString(), arStatus: 'DOCS_NEEDED',
    assignmentType: 'OWN_ASSET', docsRequired: ['POD'], docsMissing: [], salesRepId: 'rep-1', revDivision: 'DRY',
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
  shipment('s-4', { legacyImported: true }),
  shipment('s-5', { readyToInvoiceAt: new Date().toISOString(), arStatus: 'UNBILLED' }),
  shipment('s-6', { status: 'BOOKED', deliveredAt: null }),
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
  mocks.review.mockResolvedValue({
    shipmentId: 's-1', orderId: 'o-s-1', orderUpdatedAt: 'u1', arStatus: 'DOCS_NEEDED', releaseGate: GATE_OK, extras: [],
    salesRepId: 'rep-1', revDivision: 'DRY', revSubdivision: null, legacyImported: false,
  })
})

describe('LoadReviewPage inactive revenue division', () => {
  it('an inactive division blocks the row from Looks ready, with its reason, and the drawer refuses Move', async () => {
    mocks.divisions.mockReturnValue([{ ...DRY_DIVISION, active: false }])
    renderPage('/tms/load-review?tab=all')
    expect(checkbox('S-1')!.disabled).toBe(true)
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
  it('lists only rows in the queue and offers a checkbox only on Looks-ready rows', () => {
    renderPage('/tms/load-review?tab=all')
    for (const n of ['S-1', 'S-2', 'S-3']) expect(screen.getByRole('button', { name: n })).toBeTruthy()
    for (const n of ['S-4', 'S-5', 'S-6', 'S-7']) expect(screen.queryByRole('button', { name: n })).toBeNull()
    expect(checkbox('S-1')!.disabled).toBe(false)
    expect(checkbox('S-2')!.disabled).toBe(false)
    expect(checkbox('S-3')!.disabled).toBe(true)
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
    expect(hrefs).toContain('/tms/documents/review')
  })

  it('a server failure on open is shown in the drawer and Move stays disabled', async () => {
    mocks.review.mockRejectedValue(new Error('Forbidden: needs page-loadReview'))
    renderPage('/tms/load-review?shipment=s-1')
    expect(await screen.findByText('Forbidden: needs page-loadReview')).toBeTruthy()
    expect(moveButton().disabled).toBe(true)
  })
})
