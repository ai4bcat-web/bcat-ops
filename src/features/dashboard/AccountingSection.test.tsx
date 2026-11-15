// @vitest-environment jsdom
/**
 * The dashboard's Accounting cards must read the same numbers as the Invoicing page's cards
 * (Ryne 2026-11-15). Both are rendered from one fixture and the cards' text compared.
 */
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ArWorklistRow } from '@/hooks/useArWorklist'
import type { InvoiceRecord, OrderRecord, ShipmentRecord } from '@/types/tms'
import { ageInvoices } from '@/lib/arAging'
import { ArPage } from '@/features/ar/ArPage'
import { ReceivablesCards, AccountingSection } from './AccountingSection'

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
vi.mock('@/features/finance/useNeedsReview', () => ({ useNeedsReview: () => ({ rows: [], error: null, refresh: vi.fn() }) }))
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

async function cardText(ui: React.ReactElement, testId: string): Promise<string> {
  const { unmount } = render(<MemoryRouter>{ui}</MemoryRouter>)
  await settle()
  const text = screen.getByTestId(testId).textContent ?? ''
  unmount()
  return text
}

describe('dashboard Accounting cards', () => {
  it('reads the same Receivables, division and Ready to invoice numbers as the Invoicing page', async () => {
    for (const id of ['ar-summary', 'ar-division-card', 'ar-tab-card']) {
      const page = await cardText(<ArPage />, id)
      const dash = await cardText(<ReceivablesCards />, id)
      expect(dash).toBe(page)
      expect(page).not.toBe('')
    }
  })

  it('shows Open AR across every division, sent invoices only', async () => {
    render(<MemoryRouter><ReceivablesCards /></MemoryRouter>)
    await settle()
    const summary = screen.getByTestId('ar-summary')
    expect(summary).toHaveTextContent('Open AR')
    expect(summary).toHaveTextContent('$3,400.00')
    expect(summary).toHaveTextContent('2 invoices')
  })

  it('shows nothing to someone without an accounting grant', async () => {
    access.pages = new Set()
    const { container } = render(<MemoryRouter><AccountingSection /></MemoryRouter>)
    await settle()
    expect(container).toBeEmptyDOMElement()
  })
})
