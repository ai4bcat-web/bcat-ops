// @vitest-environment jsdom
/** The collection queue must show missing paperwork without letting the UI bypass billing's gate. */
import '@testing-library/jest-dom/vitest'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { DocumentsWorkstation } from './DocumentsWorkstation'
import * as useBoardFiltersModule from '../board/useBoardFilters'
import type { UseBoardFiltersOptions } from '../board/useBoardFilters'
import * as useStaffModule from '@/hooks/useStaff'
import { evaluateReleaseGate, releaseGateError } from '@/lib/releaseGate'
import type { ShipmentBundle, ShipmentDocumentRecord, CustomerRecord } from '@/types/tms'
import type { ShipmentRow } from '../shipmentViews'

const api = vi.hoisted(() => ({
  getShipmentBundle: vi.fn(), getShipmentDocumentUrl: vi.fn(), getTmsSettings: vi.fn(),
  listShipmentMessages: vi.fn(), requestPod: vi.fn(), reviewShipmentPod: vi.fn(),
  readyToInvoice: vi.fn(), previewInvoice: vi.fn(),
  saveShipmentView: vi.fn(), archiveShipmentView: vi.fn(),
}))
vi.mock('@/lib/apiClient', () => api)
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    isAdmin: true,
    isOwner: false,
    user: { email: 'ops@test.com', userId: 'ops@test.com', groups: ['ADMIN'] },
  }),
}))
vi.mock('@/hooks/useDirectory', () => ({ useDirectory: () => ({ customers }) }))
vi.mock('@/hooks/useShipments', () => ({ useShipments: () => ({ shipments: rows, loading: false, error: null, refresh: vi.fn() }) }))
vi.mock('@/hooks/useStaff', () => ({ useStaff: () => ({ me: null, nameOf: () => 'Staff' }) }))
const views: never[] = []
vi.mock('@/features/tms/useShipmentViews', () => ({ useShipmentViews: () => ({ views, refresh: vi.fn() }) }))
vi.mock('@/hooks/useDocumentReviewQueue', () => ({ useDocumentReviewQueue: () => ({ pendingCount: 3 }) }))

let customers: CustomerRecord[]
let rows: ShipmentRow[]
let bundle: ShipmentBundle
function document(type: ShipmentDocumentRecord['type'], patch: Partial<ShipmentDocumentRecord> = {}): ShipmentDocumentRecord {
  return {
    id: type, shipmentId: 'S1', orderId: 'O1', loadId: 'L1', type, name: `${type}.pdf`,
    s3Key: `shipment-docs/S1/${type}.pdf`, contentType: 'application/pdf', sizeBytes: 2048,
    source: 'GENERATED', audience: 'ALL', status: 'ACTIVE', version: 1,
    uploadedBy: 'ops@test.com', uploadedAt: '2026-10-01T15:00:00Z', createdBy: 'ops@test.com', ...patch,
  }
}
function gate() {
  return evaluateReleaseGate({
    shipment: bundle.shipment, order: bundle.orders[0], documents: bundle.documents,
    legs: [{ kind: 'OWN_ASSET', status: 'ACTIVE' }], requiredDocTypes: [],
    requiredReferenceCodes: [], openIncidentCount: 0,
  })
}
function showPage() { render(<MemoryRouter><DocumentsWorkstation /></MemoryRouter>) }

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  customers = [{ id: 'C1', name: 'Acme', requiredDocsForInvoice: ['POD'] } as CustomerRecord]
  rows = [{ id: 'S1', number: 'PRO-100', status: 'DELIVERED', customerId: 'C1', customerName: 'Acme',
    docsMissing: ['POD'], deliveredAt: '2026-10-01T14:00:00Z', mode: 'FTL', source: 'MANUAL',
    createdAt: '', updatedAt: '', createdBy: '', updatedBy: '' }]
  bundle = {
    shipment: rows[0], orders: [{ id: 'O1', shipmentId: 'S1', arStatus: 'DOCS_NEEDED', references: [], updatedAt: 'order-version' }],
    loads: [{ id: 'L1', orderId: 'O1' }], loadCarriers: [], documents: [document('BOL')], charges: [], financials: [],
  } as unknown as ShipmentBundle
  api.getShipmentBundle.mockImplementation(async () => bundle)
  api.getTmsSettings.mockResolvedValue({ defaultRequiredDocs: ['TEMP_LOG'] })
  api.previewInvoice.mockImplementation(async () => ({ releaseGate: gate() }))
  api.getShipmentDocumentUrl.mockResolvedValue('https://example.test/BOL.pdf')
  api.listShipmentMessages.mockResolvedValue([])
  api.requestPod.mockResolvedValue({ messages: [] })
  api.reviewShipmentPod.mockResolvedValue({ verdict: 'PASS', reasons: [], attempt: 1, flaggedForHuman: false, readyForBilling: true })
  api.readyToInvoice.mockImplementation(async () => {
    const result = gate()
    if (!result.ok) throw releaseGateError(result.missing)
    bundle = { ...bundle, orders: [{ ...bundle.orders[0], readyToInvoiceAt: '2026-10-01T16:00:00Z', arStatus: 'UNBILLED' }] }
    return { bundle, releaseGate: result }
  })
})
afterEach(cleanup)

describe('DocumentsWorkstation board filter viewer', () => {
  it('passes the signed-in viewer to useBoardFilters', async () => {
    const calls: UseBoardFiltersOptions[] = []
    const actual = useBoardFiltersModule.useBoardFilters
    const spy = vi.spyOn(useBoardFiltersModule, 'useBoardFilters').mockImplementation((options: UseBoardFiltersOptions) => {
      calls.push(options)
      return actual(options)
    })

    const me = { id: 'ops@test.com', email: 'ops@test.com', teamKeys: ['docs'] }
    const team = { key: 'docs', name: 'Docs', memberIds: ['ops@test.com', 'renee@test.com'] }
    vi.spyOn(useStaffModule, 'useStaff').mockReturnValue({
      staff: [me],
      byId: { 'ops@test.com': me },
      loading: false,
      error: null,
      refresh: vi.fn(),
      nameOf: (id: string | null) => (id ? String(id).split('@')[0] : '—'),
      me,
    })
    api.getTmsSettings.mockResolvedValue({ teams: [team] })

    showPage()
    await waitFor(() => {
      expect(calls.at(-1)?.viewer?.userId).toBe('ops@test.com')
      expect(calls.at(-1)?.viewer?.teamRepIds).toContain('renee@test.com')
    })

    spy.mockRestore()
  })
})

describe('DocumentsWorkstation', () => {
  it('shows an outline POD and reports the gate refusal when release is attempted', async () => {
    showPage()
    const row = screen.getByTestId('doc-row-S1')
    expect(await within(row).findByTestId('chip-POD')).toHaveAttribute('data-present', 'false')
    expect(within(row).getByTestId('chip-POD')).toHaveClass('border-dashed')
    expect(within(row).getByTestId('chip-BOL')).toHaveAttribute('data-present', 'true')
    fireEvent.click(row)
    fireEvent.click(await screen.findByRole('button', { name: 'Release to billing' }))
    const refusal = await screen.findByTestId('release-refusal')
    expect(refusal).toHaveTextContent(gate().missing[0].message)
    expect(api.readyToInvoice).toHaveBeenCalledWith({ orderId: 'O1', expectedUpdatedAt: 'order-version' })
    expect(screen.getByRole('link', { name: /Carrier-upload review/ })).toHaveAttribute('href', '/tms/documents/review')
  })

  it('shows complete paperwork as solid chips and releases through the action', async () => {
    rows[0] = { ...rows[0], docsMissing: [] }
    bundle.documents.push(document('POD', { source: 'CARRIER_PORTAL', reviewStatus: 'ACCEPTED' }))
    showPage()
    expect(screen.queryByTestId('doc-row-S1')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Missing documents' }))
    const row = await screen.findByTestId('doc-row-S1')
    expect(await within(row).findByTestId('chip-POD')).toHaveAttribute('data-present', 'true')
    expect(within(row).getByTestId('chip-BOL')).toHaveAttribute('data-present', 'true')
    fireEvent.click(row)
    fireEvent.click(await screen.findByRole('button', { name: 'Release to billing' }))
    expect(await screen.findByTestId('doc-released')).toHaveTextContent('Already released')
    expect(screen.queryByTestId('release-refusal')).not.toBeInTheDocument()
  })

  it('uses the customer list rather than org defaults and adds a carrier rate confirmation', async () => {
    customers[0] = { ...customers[0], requiredDocsForInvoice: ['WEIGHT_TICKET'] }
    bundle.loadCarriers = [{ id: 'LC1', loadId: 'L1', status: 'ACTIVE', rateConStatus: 'SIGNED' }] as ShipmentBundle['loadCarriers']
    showPage()
    const row = screen.getByTestId('doc-row-S1')
    expect(await within(row).findByTestId('chip-WEIGHT_TICKET')).toHaveAttribute('data-present', 'false')
    expect(within(row).getByTestId('chip-BOL')).toHaveAttribute('data-present', 'true')
    expect(within(row).getByTestId('chip-POD')).toHaveAttribute('data-present', 'false')
    expect(within(row).getByTestId('chip-RATE_CON')).toHaveAttribute('data-present', 'true')
    expect(within(row).queryByTestId('chip-TEMP_LOG')).not.toBeInTheDocument()
  })

  it('keeps a pending carrier upload missing and opens a filed document using its signed URL', async () => {
    bundle.documents.push(document('POD', { source: 'CARRIER_PORTAL', reviewStatus: 'PENDING' }))
    showPage()
    const row = screen.getByTestId('doc-row-S1')
    expect(await within(row).findByTestId('chip-POD')).toHaveAttribute('data-present', 'false')
    fireEvent.click(row)
    const list = await screen.findByTestId('doc-file-list')
    expect(list).toHaveTextContent('waiting on review')
    fireEvent.click(within(list).getAllByRole('button', { name: 'View' })[0])
    await waitFor(() => expect(api.getShipmentDocumentUrl).toHaveBeenCalledWith('shipment-docs/S1/BOL.pdf'))
    expect(await screen.findByTitle('BOL · BOL.pdf')).toHaveAttribute('src', 'https://example.test/BOL.pdf')
  })
  it('does not count complete documents as ready when the server finds another billing blocker', async () => {
    bundle.documents.push(document('POD'))
    api.previewInvoice.mockResolvedValue({ releaseGate: { ok: false, missing: [{ code: 'OPEN_EXCEPTIONS', message: 'Open exception' }] } })
    showPage()
    expect(await within(screen.getByTestId('doc-row-S1')).findByTestId('chip-POD')).toHaveAttribute('data-present', 'true')
    expect(screen.getByTestId('doc-counts')).toHaveTextContent('0 ready to release')
  })

  it('attributes a present POD to the active assignment, not a newer bounced carrier file', async () => {
    bundle.loadCarriers = [{ id: 'active', loadId: 'L1', status: 'ACTIVE' }, { id: 'bounced', loadId: 'L1', status: 'BOUNCED' }] as ShipmentBundle['loadCarriers']
    bundle.documents.push(
      document('POD', { id: 'good', loadCarrierId: 'active', source: 'UPLOAD' }),
      document('POD', { id: 'old-carrier', loadCarrierId: 'bounced', source: 'CARRIER_PORTAL', reviewStatus: 'ACCEPTED', uploadedAt: '2026-10-02T15:00:00Z' }),
    )
    showPage()
    const chip = await within(screen.getByTestId('doc-row-S1')).findByTestId('chip-POD')
    expect(chip).toHaveAttribute('data-present', 'true')
    expect(chip).toHaveTextContent('uploaded by staff')
    expect(chip).not.toHaveTextContent('sent by the carrier')
  })

  it('flags a shipment that needs a person after repeated POD refusals', async () => {
    bundle.shipment = { ...bundle.shipment, podFlaggedAt: '2026-10-01T17:00:00Z', podFlagReason: 'POD rejected twice — hand to a dispatcher' }
    showPage()
    fireEvent.click(screen.getByTestId('doc-row-S1'))
    const banner = await screen.findByTestId('pod-needs-person')
    expect(banner).toHaveTextContent('Needs a person')
    expect(banner).toHaveTextContent('POD rejected twice — hand to a dispatcher')
  })

  it('shows when a POD was requested and can request another', async () => {
    api.listShipmentMessages.mockResolvedValue([
      { id: 'm1', shipmentId: 'S1', threadKey: 't1', direction: 'OUT', channel: 'EMAIL', kind: 'POD_REQUEST', status: 'SENT', at: '2026-10-01T15:30:00Z', createdBy: 'ops@test.com', createdAt: '2026-10-01T15:30:00Z', updatedAt: '2026-10-01T15:30:00Z' },
    ])
    api.requestPod.mockResolvedValue({ messages: [] })
    showPage()
    fireEvent.click(screen.getByTestId('doc-row-S1'))
    const requestLine = await screen.findByTestId('pod-request-sent')
    expect(requestLine).toHaveTextContent('Requested')
    expect(requestLine).toHaveTextContent('via email')
    fireEvent.click(screen.getByRole('button', { name: 'Request POD' }))
    await waitFor(() => expect(api.requestPod).toHaveBeenCalledWith({ shipmentId: 'S1' }))
  })

  it('shows a rejected POD with the reason the app gave', async () => {
    bundle.documents.push(document('POD', { reviewStatus: 'REJECTED', reviewNote: 'Illegible photo — cannot read the BOL number' }))
    showPage()
    fireEvent.click(screen.getByTestId('doc-row-S1'))
    expect(await screen.findByTestId('pod-reject-reason-POD')).toHaveTextContent('Illegible photo — cannot read the BOL number')
  })

  it('shows the document source so a dispatcher knows it arrived by e-mail', async () => {
    bundle.documents.push(document('POD', { source: 'CARRIER_PORTAL' }))
    showPage()
    fireEvent.click(screen.getByTestId('doc-row-S1'))
    expect(await screen.findByTestId('pod-doc-source-POD')).toHaveTextContent('sent by the carrier')
  })

  it('reviews a POD and shows the attempt count and page-count verdict', async () => {
    api.reviewShipmentPod.mockResolvedValue({
      verdict: 'FAIL',
      reasons: ['Expected 3 pages, found 2'],
      attempt: 2,
      flaggedForHuman: false,
      readyForBilling: false,
    })
    bundle.documents.push(document('POD', { id: 'POD' }))
    showPage()
    fireEvent.click(screen.getByTestId('doc-row-S1'))
    fireEvent.click(await screen.findByRole('button', { name: 'Review POD POD.pdf' }))
    const outcome = await screen.findByTestId('pod-outcome-POD')
    expect(outcome).toHaveTextContent('Attempt 2')
    expect(outcome).toHaveTextContent('Expected 3 pages, found 2')
    expect(api.reviewShipmentPod).toHaveBeenCalledWith({ shipmentId: 'S1', documentId: 'POD' })
  })
})
