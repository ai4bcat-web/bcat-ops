// @vitest-environment jsdom
/**
 * The AR card is the one place on a shipment that says where the money is, so these
 * tests pin the four things a reader relies on: the lit rung matches the order's rung,
 * a status that is not on the ladder does not draw one, an issued invoice shows its
 * number, balance and due date, and Generate is offered at exactly one rung. Releasing to
 * billing is not on this card: it pushes to Load Review (imported history excepted).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ArCard } from './ArCard'
import type { ArStatus, InvoiceRecord, OrderRecord, ShipmentBundle, ShipmentRecord } from '@/types/tms'

const getInvoice = vi.hoisted(() => vi.fn())
const readyToInvoice = vi.hoisted(() => vi.fn())
const pushToLoadReview = vi.hoisted(() => vi.fn())

vi.mock('@/lib/apiClient', () => ({
  getInvoice,
  getInvoicePdfUrl: vi.fn(async () => 'https://example.com/invoice.pdf'),
  readyToInvoice,
  pushToLoadReview,
  saveOrderForm: vi.fn(),
  voidInvoice: vi.fn(),
}))
// The dialogs are mounted, never opened here; each has its own tests and each would
// drag a finance read into a render test about the card.
vi.mock('@/features/ar/components/GenerateInvoiceDialog', () => ({ GenerateInvoiceDialog: () => null }))
vi.mock('@/features/ar/components/EmailInvoiceDialog', () => ({ EmailInvoiceDialog: () => null }))
vi.mock('@/features/ar/components/ReceivePaymentDialog', () => ({ ReceivePaymentDialog: () => null }))
vi.mock('@/features/ar/components/SendToFactorDialog', () => ({ SendToFactorDialog: () => null }))
vi.mock('@/features/ar/components/ReasonDialog', () => ({ ReasonDialog: () => null }))

const WHEN = '2026-04-03T12:00:00.000Z'

function bundle(order: Partial<OrderRecord>): ShipmentBundle {
  const shipment: ShipmentRecord = {
    id: 'shp-1', number: 'S000001', status: 'DELIVERED', customerId: 'cust-1', customerName: 'Acme Freight',
    mode: 'FTL', source: 'MANUAL',
    createdBy: 'a@b.c', updatedBy: 'a@b.c', createdAt: WHEN, updatedAt: WHEN,
  }
  const row: OrderRecord = {
    id: 'ord-1', shipmentId: 'shp-1', customerId: 'cust-1', mode: 'FTL',
    arStatus: 'DOCS_NEEDED', references: [], freight: [],
    createdBy: 'a@b.c', updatedBy: 'a@b.c', createdAt: WHEN, updatedAt: WHEN,
    ...order,
  }
  return { shipment, orders: [row], loads: [], loadCarriers: [], charges: [], financials: [], documents: [] }
}

function invoice(over: Partial<InvoiceRecord> = {}): InvoiceRecord {
  return {
    id: 'INV-000012', number: 'INV-000012', orderId: 'ord-1', shipmentId: 'shp-1', customerId: 'cust-1',
    status: 'ISSUED', invoiceDate: '2026-04-01', issuedAt: WHEN, issuedBy: 'a@b.c', dueAt: '2026-05-01',
    termsDays: 30, invoiceMonth: '2026-04', subtotalCents: 200000, totalCents: 200000, paidCents: 0,
    writtenOffCents: 0, balanceCents: 200000, arOpen: 'OPEN',
    createdBy: 'a@b.c', updatedBy: 'a@b.c', version: 1, createdAt: WHEN, updatedAt: WHEN,
    ...over,
  }
}

function renderCard(order: Partial<OrderRecord>, shipment: Partial<ShipmentRecord> = {}) {
  const base = bundle(order)
  render(
    <MemoryRouter>
      <ArCard bundle={{ ...base, shipment: { ...base.shipment, ...shipment } }} onReload={vi.fn(async () => {})} />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  getInvoice.mockResolvedValue(null)
})

describe('ArCard', () => {
  it.each<[ArStatus, string]>([
    ['DOCS_NEEDED', 'ar-rung-DOCS_NEEDED'],
    ['UNBILLED', 'ar-rung-UNBILLED'],
    ['UNPAID', 'ar-rung-UNPAID'],
    ['PAID', 'ar-rung-PAID'],
  ])('lights the %s rung and no other', (arStatus, litId) => {
    renderCard({ arStatus })
    const lit = screen.getAllByTestId(/^ar-rung-/).filter((el) => el.getAttribute('aria-current') === 'step')
    expect(lit.map((el) => el.getAttribute('data-testid'))).toEqual([litId])
  })

  it('renders LEGACY as a flat chip with no ladder at all', () => {
    renderCard({ arStatus: 'LEGACY' })
    expect(screen.queryByTestId('ar-ladder')).toBeNull()
    expect(screen.getByTestId('ar-flat').textContent).toContain('Legacy')
  })

  it('shows the number, balance and due date once the order is invoiced', async () => {
    getInvoice.mockResolvedValue(invoice({ balanceCents: 150000, paidCents: 50000, status: 'PARTIAL' }))
    renderCard({ arStatus: 'UNPAID', invoiceId: 'INV-000012', invoiceNumber: 'INV-000012' })

    await waitFor(() => expect(screen.getByText('$1,500.00')).toBeTruthy())
    expect(screen.getByRole('link', { name: 'INV-000012' }).getAttribute('href')).toBe('/tms/invoicing/invoices/INV-000012')
    expect(screen.getByText('$2,000.00')).toBeTruthy()
    expect(screen.getByText('2026-05-01')).toBeTruthy()
  })

  it('never claims an e-mail the invoice row does not record', async () => {
    getInvoice.mockResolvedValue(invoice())
    renderCard({ arStatus: 'UNPAID', invoiceId: 'INV-000012' })
    await waitFor(() => expect(screen.getByTestId('ar-email-status').textContent).toContain('Not e-mailed yet'))
  })

  it('offers Generate invoice at the Unbilled rung', () => {
    renderCard({ arStatus: 'UNBILLED' })
    expect(screen.getByRole('button', { name: 'Generate invoice' })).toBeTruthy()
  })

  it.each<ArStatus>(['DOCS_NEEDED', 'UNPAID', 'PAID', 'LEGACY', 'INVOICE_NOT_NEEDED'])(
    'does not offer Generate invoice at %s',
    (arStatus) => {
      renderCard({ arStatus })
      expect(screen.queryByRole('button', { name: 'Generate invoice' })).toBeNull()
    },
  )

  it('drops Generate once an invoice exists, even while the order still reads Unbilled', async () => {
    getInvoice.mockResolvedValue(invoice())
    renderCard({ arStatus: 'UNBILLED', invoiceId: 'INV-000012' })
    await waitFor(() => expect(screen.getByTestId('ar-email-status')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Generate invoice' })).toBeNull()
  })

  it('offers no Ready to invoice: a load with paperwork outstanding is pushed to Load Review', () => {
    renderCard({ arStatus: 'DOCS_NEEDED' })
    expect(screen.queryByRole('button', { name: 'Ready to invoice' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Push to Load Review' })).toBeTruthy()
  })

  it('shows the per-row reasons when the push is refused and never calls READY_TO_INVOICE', async () => {
    pushToLoadReview.mockResolvedValue({
      results: [{ shipmentId: 'shp-1', number: 'S000001', ok: false, message: 'Missing sales rep', reasons: ['Missing sales rep', 'Missing document: POD'] }],
    })
    renderCard({ arStatus: 'DOCS_NEEDED' })
    fireEvent.click(screen.getByRole('button', { name: 'Push to Load Review' }))
    const reasons = await screen.findByTestId('push-to-load-review-reasons')
    expect(reasons.textContent).toContain('Missing sales rep')
    expect(reasons.textContent).toContain('Missing document: POD')
    expect(pushToLoadReview).toHaveBeenCalledWith(['shp-1'])
    expect(readyToInvoice).not.toHaveBeenCalled()
  })

  it('links to the load in Load Review once the push lands', async () => {
    pushToLoadReview.mockResolvedValue({ results: [{ shipmentId: 'shp-1', number: 'S000001', ok: true, message: null }] })
    renderCard({ arStatus: 'DOCS_NEEDED' })
    fireEvent.click(screen.getByRole('button', { name: 'Push to Load Review' }))
    const link = await screen.findByRole('link', { name: 'Open in Load Review' })
    expect(link.getAttribute('href')).toBe('/tms/load-review?shipment=shp-1')
  })

  it('keeps Ready to invoice only for imported Aljex history, which has no review', () => {
    renderCard({ arStatus: 'DOCS_NEEDED' }, { legacyImported: true })
    expect(screen.getByRole('button', { name: 'Ready to invoice' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Push to Load Review' })).toBeNull()
  })
})
