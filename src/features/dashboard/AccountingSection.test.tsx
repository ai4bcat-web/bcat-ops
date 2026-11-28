// @vitest-environment jsdom
/**
 * The dashboard's Accounting cards must read the same numbers as the Invoicing page's cards
 * (Ryne 2026-11-15). Both are rendered from one fixture and the cards' text compared.
 */
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import type { ArWorklistRow } from '@/hooks/useArWorklist'
import type { InvoiceRecord, OrderRecord, ShipmentRecord } from '@/types/tms'
import { ageInvoices } from '@/lib/arAging'
import { ArPage } from '@/features/ar/ArPage'
import { ReceivablesCard, AccountingSection } from './AccountingSection'

const worklistMock = vi.hoisted(() => vi.fn())
const openInvoicesMock = vi.hoisted(() => vi.fn())
const access = vi.hoisted(() => ({ pages: new Set<string>() }))
vi.mock('@/hooks/useAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useAuth')>()),
  useAuth: () => ({ hasPageAccess: (key: string) => access.pages.has(key), isAdmin: false }),
  useAuthUser: () => ({ userId: 'u', email: 'x@bcatcorp.com', groups: [] }),
}))
vi.mock('@/hooks/useArWorklist', () => ({ useArWorklist: worklistMock }))
vi.mock('@/hooks/useOpenInvoices', () => ({ useOpenInvoices: openInvoicesMock }))
vi.mock('@/hooks/useCustomerAr', () => ({ useCustomerAr: () => ({ rows: [], payments: [], loading: false, error: null, refresh: vi.fn() }) }))
vi.mock('@/hooks/useDirectory', () => ({ useDirectory: () => ({ customers: [], locations: [] }) }))
vi.mock('@/features/tms/useOwnershipDivisions', () => ({
  useOwnershipDivisions: () => ({ divisions: [{ code: 'BROKERAGE', name: 'BCAT Logistics' }, { code: 'ASSETS', name: 'Ivan Cartage' }], loading: false, error: null, refresh: vi.fn() }),
}))
vi.mock('@/lib/worklistShipments', () => ({ loadWorklistShipments: vi.fn().mockResolvedValue([]) }))
vi.mock('@/hooks/useFactoringItems', () => ({
  useFactoringItems: () => ({ items: [], loading: false, error: null, refresh: vi.fn() }),
}))
vi.mock('@/features/finance/useNeedsReview', () => ({ useNeedsReview: () => ({ rows: [], questions: [], error: null, refresh: vi.fn(), replaceQuestion: vi.fn() }), openReviewCount: () => 0 }))
vi.mock('@/features/ar/useDeliveredNotReady', () => ({ useDeliveredNotReady: () => 3 }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))
vi.mock('@/lib/otrClient', () => ({ assembleInvoice: vi.fn(), submitToOtr: vi.fn(), uploadOtrDocs: vi.fn() }))
vi.mock('@/lib/apiClient', () => ({
  graphqlErrorText: (e: unknown) => String(e),
  getInvoiceAttachmentPlans: vi.fn().mockResolvedValue([]),
  listInvoicesByMonth: vi.fn().mockResolvedValue([]),
  listUserProfiles: vi.fn().mockResolvedValue([]),
  previewFactorReady: vi.fn(async ({ orderIds }: { orderIds: string[] }) => ({
    results: orderIds.map((orderId) => ({ orderId, factorBilled: false, ready: false, missing: [] })),
  })),
  getTmsSettings: vi.fn().mockResolvedValue({ id: 'default' }),
  batchGenerateInvoices: vi.fn(),
  voidInvoice: vi.fn(),
  reversePayment: vi.fn(),
  // Ready to invoice reads the auto shipper details of its shipments; none of these carries any.
  listCarShippingByShipmentIds: vi.fn().mockResolvedValue(new Map()),
  createSquareInvoice: vi.fn(),
  sendSquareInvoice: vi.fn(),
  setLoadStatus: vi.fn(),
  getShipmentBundle: vi.fn(),
}))
vi.mock('@/hooks/useShipments', () => ({ useShipments: () => ({ shipments: [], loading: false, error: null, partial: false }) }))

function shipment(id: string, patch: Partial<ShipmentRecord> = {}): ShipmentRecord {
  return {
    id, number: id.toUpperCase(), status: 'DELIVERED', customerId: 'c1', customerName: 'Acme Foods', mode: 'FTL', source: 'MANUAL',
    deliveredAt: '2026-10-20T12:00:00.000Z', createdBy: 'r', updatedBy: 'r', createdAt: '2026-10-01T12:00:00.000Z', updatedAt: '2026-10-20T12:00:00.000Z',
    ...patch,
  }
}

function order(id: string, shipmentId: string, arStatus: OrderRecord['arStatus']): OrderRecord {
  return {
    id, shipmentId, customerId: 'c1', customerName: 'Acme Foods', mode: 'FTL', arStatus, revenueCents: 120_000,
    createdBy: 'r', updatedBy: 'r', createdAt: '2026-10-01T12:00:00.000Z', updatedAt: '2026-10-20T12:00:00.000Z',
  }
}

function row(orderId: string, s: ShipmentRecord, arStatus: OrderRecord['arStatus']): ArWorklistRow {
  return {
    order: order(orderId, s.id, arStatus), shipment: s, orderId, shipmentId: s.id, shipmentNumber: s.number, customerId: 'c1', customerName: 'Acme Foods',
    billToId: null, deliveredAt: s.deliveredAt ?? null, arStatusChangedAt: '2026-10-20T12:00:00.000Z', revenueCents: 120_000,
    docsRequired: ['POD'], docsMissing: [], docsReady: true, invoiceNumber: null, invoicedAt: null, arBalanceCents: null, reasons: [],
  }
}

function invoice(id: string, shipmentId: string, patch: Partial<InvoiceRecord> = {}): InvoiceRecord {
  return {
    id, number: id, orderId: `o-${shipmentId}`, shipmentId, shipmentNumber: shipmentId.toUpperCase(), customerId: 'c1', customerName: 'Acme Foods',
    status: 'ISSUED', invoiceDate: '2026-09-20', issuedAt: '2026-09-20T12:00:00.000Z', issuedBy: 'r', dueAt: '2026-10-20', termsDays: 30,
    invoiceMonth: '2026-09', lines: [], subtotalCents: 250_000, totalCents: 250_000, paidCents: 0, writtenOffCents: 0, balanceCents: 250_000,
    arOpen: 'OPEN', markedSentAt: '2026-09-20T12:00:00.000Z', createdBy: 'r', updatedBy: 'r', version: 1,
    ...patch,
  }
}

const brokerage = shipment('s1', { revDivision: 'BROKERAGE' } as Partial<ShipmentRecord>)
const assets = shipment('s2', { revDivision: 'ASSETS' } as Partial<ShipmentRecord>)
const released = shipment('s3', { revDivision: 'BROKERAGE' } as Partial<ShipmentRecord>)
const openSet = [
  invoice('INV-1', 's1'),
  invoice('INV-2', 's2', { balanceCents: 90_000, totalCents: 150_000, paidCents: 60_000, status: 'PARTIAL', dueAt: '2030-01-01' }),
]

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

beforeEach(() => {
  localStorage.setItem('ar.invoicing.cards', 'open')
  // The dashboard counts every billing; the page is compared on the same view.
  localStorage.setItem('tms:ar:billedBy', 'all')
  access.pages = new Set(['invoicing', 'carrierPay'])
  worklistMock.mockImplementation((tab: string) => ({
    rows: tab === 'UNBILLED' ? [row('o3', released, 'UNBILLED')] : [row('o-s1', brokerage, 'UNPAID'), row('o-s2', assets, 'UNPAID')],
    loading: false, error: null, refresh: vi.fn().mockResolvedValue(undefined),
  }))
  openInvoicesMock.mockReturnValue({ invoices: openSet, aging: ageInvoices(openSet, '2026-10-28'), loading: false, error: null, refresh: vi.fn().mockResolvedValue(undefined) })
})

/** The page's Receivables card row value (e.g. "$3,400.00") as whole dollars ("$3,400"), the dashboard's format. */
const dollars = (pageValue: string) => pageValue.replace(/\.\d\d$/, '')

async function pageRows(): Promise<Record<string, string>> {
  const { unmount } = render(<MemoryRouter><ArPage /></MemoryRouter>)
  await settle()
  const out: Record<string, string> = {}
  for (const li of screen.getByTestId('ar-summary').querySelectorAll('li')) {
    const label = li.querySelector('.tms-list-row-label')?.firstChild?.textContent?.trim() ?? ''
    out[label] = `${li.querySelector('.tms-list-row-value')?.textContent ?? ''} · ${li.querySelector('.tms-list-row-sub-text')?.textContent ?? ''}`
  }
  const ready = screen.getByTestId('ar-tab-card').querySelector('li')
  out['Ready to invoice'] = `${ready?.querySelector('.tms-list-row-value')?.textContent ?? ''} · ${ready?.querySelector('.tms-list-row-sub-text')?.textContent ?? ''}`
  unmount()
  return out
}

describe('dashboard Accounts receivable card', () => {
  it('reads the same figures as the Invoicing page', async () => {
    const page = await pageRows()
    render(<MemoryRouter><ReceivablesCard /></MemoryRouter>)
    await settle()
    const card = screen.getByTestId('dashboard-ar-card')
    const [openValue, openSub] = page['Open AR'].split(' · ')
    expect(card).toHaveTextContent(dollars(openValue))
    expect(card).toHaveTextContent(`open · ${openSub}`)
    const row = (key: string) => screen.getByTestId(`summary-row-${key}`).textContent ?? ''
    for (const [key, label] of [['shippers', 'Pending with shippers'], ['late', 'Late'], ['collected', 'Collected this month'], ['ready', 'Ready to invoice']] as const) {
      const [value, sub] = page[label].split(' · ')
      expect(row(key)).toContain(dollars(value))
      expect(row(key)).toContain(sub.split(' ')[0])
    }
    expect(page['Open AR']).toContain('$3,400.00')
  })

  it('Collected this month opens Payments Received (there is no AR Paid tab)', async () => {
    const Where = () => { const l = useLocation(); return <p data-testid="where">{l.pathname + l.search}</p> }
    render(<MemoryRouter initialEntries={['/']}><Routes><Route path="/" element={<ReceivablesCard />} /><Route path="*" element={<Where />} /></Routes></MemoryRouter>)
    await settle()
    const row = screen.getByTestId('summary-row-collected')
    fireEvent.click(row.querySelector('button, a') ?? row)
    await settle()
    expect(screen.getByTestId('where').textContent).toBe('/tms/payments-received?period=month')
  })

  it('shows Factoring inside the card with the shared OTR buckets', async () => {
    render(<MemoryRouter><ReceivablesCard /></MemoryRouter>)
    await settle()
    for (const label of ['Waiting on OTR approval', 'Approved by OTR, not marked paid', 'Not sent to OTR yet', 'Manually invoiced', 'OTR rejected']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
  })

  it('shows nothing to someone without an accounting grant', async () => {
    access.pages = new Set()
    const { container } = render(<MemoryRouter><AccountingSection /></MemoryRouter>)
    await settle()
    expect(container).toBeEmptyDOMElement()
  })
})
