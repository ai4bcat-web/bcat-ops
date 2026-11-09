// @vitest-environment jsdom
/** The AR desk's job is to be believed. */
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { act, render, screen, fireEvent, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { ArWorklistRow } from '@/hooks/useArWorklist'
import type {
  ArPaymentRecord, InvoiceRecord, OrderRecord, ShipmentNoticeRecord, ShipmentRecord,
} from '@/types/tms'
import { ageInvoices } from '@/lib/arAging'
import { ArPage } from './ArPage'
import { InvoiceDetail } from './InvoiceDetail'
import * as apiClient from '@/lib/apiClient'

const worklistMock = vi.hoisted(() => vi.fn())
const openInvoicesMock = vi.hoisted(() => vi.fn())
const customerArMock = vi.hoisted(() => vi.fn())
const invoiceMock = vi.hoisted(() => vi.fn())
const authGroups = vi.hoisted(() => ({ current: [] as string[] }))
vi.mock('@/hooks/useAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useAuth')>()),
  useAuthUser: () => ({ userId: 'u', email: 'x@bcatcorp.com', groups: authGroups.current }),
}))

vi.mock('@/hooks/useArWorklist', () => ({ useArWorklist: worklistMock }))
vi.mock('@/hooks/useOpenInvoices', () => ({ useOpenInvoices: openInvoicesMock }))
vi.mock('@/hooks/useCustomerAr', () => ({ useCustomerAr: customerArMock }))
vi.mock('@/hooks/useInvoice', () => ({ useInvoice: invoiceMock }))
vi.mock('@/hooks/useDirectory', () => ({ useDirectory: () => ({ customers: [], locations: [] }) }))
vi.mock('@/hooks/useFactoringItems', () => ({
  useFactoringItems: () => ({ items: [], loading: false, error: null, refresh: vi.fn() }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))
vi.mock('@/lib/apiClient', () => ({
  graphqlErrorText: (e: unknown) => String(e),
  listInvoicesByMonth: vi.fn().mockResolvedValue([]),
  batchGenerateInvoices: vi.fn(),
  batchEmailInvoices: vi.fn(),
  voidInvoice: vi.fn(),
  reversePayment: vi.fn(),
  renderInvoicePdf: vi.fn(),
  markInvoiceSent: vi.fn(),
  getInvoicePdfUrl: vi.fn().mockResolvedValue('blob:pdf'),
  previewInvoice: vi.fn(),
  readyToInvoice: vi.fn(),
  // The invoice detail now carries a Commission card; it reads settings before it reads
  // anything else, and commissions are off here, so the card renders nothing.
  commissionModelsDeployed: () => true,
  getTmsSettings: vi.fn().mockResolvedValue({ id: 'default', commissionsEnabled: false }),
  listCommissionsByInvoice: vi.fn().mockResolvedValue([]),
  previewCommissions: vi.fn(),
  runCommissions: vi.fn(),
}))
// The dialogs are mount-to-open and fetch their own context; their behaviour has its own
// tests, and here they would only drag the finance Lambda into a test about the board.
vi.mock('./components/GenerateInvoiceDialog', () => ({ GenerateInvoiceDialog: () => null }))
vi.mock('./components/EmailInvoiceDialog', () => ({ EmailInvoiceDialog: () => null }))
vi.mock('./components/ReceivePaymentDialog', () => ({ ReceivePaymentDialog: () => null }))
vi.mock('./components/CreditMemoDialog', () => ({ CreditMemoDialog: () => null }))
vi.mock('./components/SendToFactorDialog', () => ({ SendToFactorDialog: () => null }))
vi.mock('./components/WriteOffDialog', () => ({ WriteOffDialog: () => null }))

const TODAY = '2026-10-28'

function order(patch: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: 'o1',
    shipmentId: 's1',
    customerId: 'c1',
    customerName: 'Acme Foods',
    mode: 'FTL',
    arStatus: 'UNBILLED',
    revenueCents: 250_000,
    createdBy: 'ryne@bcatcorp.com',
    updatedBy: 'ryne@bcatcorp.com',
    createdAt: '2026-10-01T12:00:00.000Z',
    updatedAt: '2026-10-20T12:00:00.000Z',
    ...patch,
  }
}

function shipment(patch: Partial<ShipmentRecord> = {}): ShipmentRecord {
  return {
    id: 's1',
    number: 'S-1001',
    status: 'DELIVERED',
    customerId: 'c1',
    customerName: 'Acme Foods',
    mode: 'FTL',
    source: 'MANUAL',
    deliveredAt: '2026-10-20T12:00:00.000Z',
    createdBy: 'ryne@bcatcorp.com',
    updatedBy: 'ryne@bcatcorp.com',
    createdAt: '2026-10-01T12:00:00.000Z',
    updatedAt: '2026-10-20T12:00:00.000Z',
    ...patch,
  }
}

function worklistRow(patch: Partial<ArWorklistRow> = {}): ArWorklistRow {
  return {
    order: order(),
    shipment: shipment(),
    orderId: 'o1',
    shipmentId: 's1',
    shipmentNumber: 'S-1001',
    customerId: 'c1',
    customerName: 'Acme Foods',
    billToId: null,
    deliveredAt: '2026-10-20T12:00:00.000Z',
    arStatusChangedAt: '2026-10-20T12:00:00.000Z',
    revenueCents: 250_000,
    docsRequired: ['POD'],
    docsMissing: [],
    docsReady: true,
    invoiceNumber: null,
    invoicedAt: null,
    arBalanceCents: null,
    reasons: [],
    ...patch,
  }
}

function invoice(patch: Partial<InvoiceRecord> = {}): InvoiceRecord {
  return {
    id: 'INV-000123',
    number: 'INV-000123',
    orderId: 'o1',
    shipmentId: 's1',
    shipmentNumber: 'S-1001',
    customerId: 'c1',
    customerName: 'Acme Foods',
    status: 'ISSUED',
    invoiceDate: '2026-09-20',
    issuedAt: '2026-09-20T12:00:00.000Z',
    issuedBy: 'ryne@bcatcorp.com',
    dueAt: '2026-10-20',
    termsDays: 30,
    invoiceMonth: '2026-09',
    lines: [],
    subtotalCents: 250_000,
    totalCents: 250_000,
    paidCents: 0,
    writtenOffCents: 0,
    balanceCents: 250_000,
    arOpen: 'OPEN',
    createdBy: 'ryne@bcatcorp.com',
    updatedBy: 'ryne@bcatcorp.com',
    version: 1,
    ...patch,
  }
}

function notice(patch: Partial<ShipmentNoticeRecord> = {}): ShipmentNoticeRecord {
  return {
    id: 'n1',
    shipmentId: 's1',
    kind: 'INVOICE',
    channel: 'EMAIL',
    to: 'ap@acmefoods.com',
    subject: 'Invoice INV-000123 · S-1001',
    body: 'Please find invoice INV-000123 attached.',
    status: 'NOT_SENT',
    error: 'SES refused: identity not verified',
    at: '2026-09-20T12:05:00.000Z',
    createdBy: 'ryne@bcatcorp.com',
    ...patch,
  }
}

const openSet = [invoice()]

/** Let the page's mocked fetches resolve inside act, so their state updates are not reported as stray. */
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

async function setup(rowsByTab: Partial<Record<string, ArWorklistRow[]>> = {}) {
  worklistMock.mockImplementation((tab: string) => ({
    rows: rowsByTab[tab] ?? [],
    loading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
  }))
  openInvoicesMock.mockReturnValue({
    invoices: openSet,
    aging: ageInvoices(openSet, TODAY),
    loading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
  })
  customerArMock.mockReturnValue({
    invoices: [],
    payments: [] as ArPaymentRecord[],
    openCents: 0,
    unappliedCents: 0,
    loading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
  })
  const view = render(<MemoryRouter><ArPage /></MemoryRouter>)
  await settle()
  return view
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(apiClient.previewInvoice as Mock).mockResolvedValue({ releaseGate: { ok: true, missing: [] } })
  ;(apiClient.readyToInvoice as Mock).mockResolvedValue({ bundle: {}, releaseGate: { ok: true, missing: [] } })
})

describe('the AR board', () => {
  it('offers every view of the money, and each one renders', async () => {
    await setup({ UNBILLED: [worklistRow()], DOCS_NEEDED: [worklistRow({ docsMissing: ['POD'], docsReady: false })] })
    for (const label of ['Docs needed', 'Ready for billing', 'Unbilled', 'Unpaid', 'Paid', 'Payments & credits', 'Aging']) {
      const tab = screen.getByRole('tab', { name: new RegExp(`^${label}`) })
      fireEvent.click(tab)
      await settle()
      expect(tab.getAttribute('aria-selected')).toBe('true')
    }
    // The last click landed on Aging, whose body is the strip.
    expect(screen.getByLabelText('AR totals')).toBeTruthy()
  })

  /**
   * The strip is what somebody reads before deciding who to chase. Every figure comes out
   * of `@/lib/arAging` — the page must not reach its own total, or the CSV and the screen
   * would disagree about what is owed.
   */
  it('leads the aging view with the lib\'s own totals', async () => {
    await setup({ UNBILLED: [worklistRow()] })
    fireEvent.click(screen.getByRole('tab', { name: /^Aging/ }))
    await settle()

    // One open invoice of $2,500.00, eight days past a 2026-10-20 due date.
    const strip = within(screen.getByLabelText('AR totals'))
    expect(within(strip.getByText('Open AR').closest('.tms-kpi-card') as HTMLElement).getByText('$2,500.00')).toBeTruthy()
    expect(within(strip.getByText('Late').closest('.tms-kpi-card') as HTMLElement).getByText('$2,500.00')).toBeTruthy()
    // The delivered shipment nobody has billed, counted off the worklist rows.
    expect(within(strip.getByText('Delivered, not invoiced').closest('.tms-kpi-card') as HTMLElement).getByText('1 shipment')).toBeTruthy()
    // Nothing has been collected, so the lag is unmeasured — not zero.
    expect(within(strip.getByText('Avg days to pay').closest('.tms-kpi-card') as HTMLElement).getByText('—')).toBeTruthy()
  })

  /**
   * A row that is not billable has to say so where the decision is made. Hiding the
   * refusal behind the dialog means opening every row to find the two that are stuck.
   */
  it('refuses to generate an order that is not ready, and says why', async () => {
    await setup({
      UNBILLED: [worklistRow({
        docsReady: false,
        docsMissing: ['POD'],
        reasons: ['The POD has not been accepted yet.'],
      })],
    })

    expect(screen.getByText('The POD has not been accepted yet.')).toBeTruthy()
    const generate = screen.getByRole('button', { name: 'Generate invoice for S-1001' })
    expect((generate as HTMLButtonElement).disabled).toBe(true)
    const select = screen.getByRole('checkbox', { name: 'Select S-1001' })
    expect((select as HTMLInputElement).disabled).toBe(true)
  })

  it('badges pre-cutover shipments in Docs needed and filters to them', async () => {
    const old = worklistRow({
      orderId: 'o-old', shipmentId: 's-old', shipmentNumber: '8501', docsReady: false,
      order: order({ id: 'o-old', arStatus: 'DOCS_NEEDED' }),
      shipment: shipment({ id: 's-old', number: '8501', legacyImported: true, source: 'BACKFILL' } as Partial<ShipmentRecord>),
    })
    const fresh = worklistRow({
      orderId: 'o-new', shipmentId: 's-new', shipmentNumber: 'S-2002', docsReady: false,
      order: order({ id: 'o-new', arStatus: 'DOCS_NEEDED' }),
      shipment: shipment({ id: 's-new', number: 'S-2002' }),
    })
    await setup({ DOCS_NEEDED: [old, fresh] })
    fireEvent.click(screen.getByRole('tab', { name: /^Docs needed/ }))
    await settle()
    expect(screen.getAllByText('Review billing').length).toBe(1)
    expect(screen.getByText('S-2002')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Review billing \(1\)/ }))
    await settle()
    expect(screen.queryByText('S-2002')).toBeNull()
    expect(screen.getByText('8501')).toBeTruthy()
  })

  // "Only Jenny and Ryne post invoices": posting is the page-billingRelease grant alone, never a role.
  it.each([
    ['ADMIN', ['ADMIN', 'page-invoicing', 'page-tms'], true],
    ['page-billingRelease', ['page-billingRelease'], false],
  ])('Generate and Batch generate are %s-gated: disabled=%s', async (_label, groups, disabled) => {
    authGroups.current = groups
    await setup({ UNBILLED: [worklistRow()] })
    const generate = screen.getByRole('button', { name: 'Generate invoice for S-1001' }) as HTMLButtonElement
    const batch = screen.getByRole('button', { name: 'Batch generate invoices' }) as HTMLButtonElement
    expect(generate.disabled).toBe(disabled)
    expect(batch.title === '').toBe(!disabled)
    authGroups.current = []
  })

  it('shows the release gate verdict on the Ready for billing tab', async () => {
    ;(apiClient.previewInvoice as Mock).mockResolvedValue({
      releaseGate: {
        ok: false,
        missing: [{ code: 'CARRIER_CHARGES_UNSETTLED', message: 'Carrier charges not settled: Acme Trucking — record the carrier bill first' }],
      },
    })
    await setup({
      DOCS_NEEDED: [worklistRow({ arStatus: 'DOCS_NEEDED', docsReady: true, docsMissing: [] })],
    })
    fireEvent.click(screen.getByRole('tab', { name: /^Ready for billing/ }))
    expect(await screen.findByTestId('ready-gate-o1')).toHaveTextContent('Carrier charges not settled: Acme Trucking — record the carrier bill first')
  })

  it('opens a ready shipment in Load Review instead of releasing it from the AR page', async () => {
    await setup({
      DOCS_NEEDED: [worklistRow({ arStatus: 'DOCS_NEEDED', docsReady: true, docsMissing: [] })],
    })
    fireEvent.click(screen.getByRole('tab', { name: /^Ready for billing/ }))
    const link = await screen.findByRole('link', { name: 'Open S-1001 in Load Review' })
    expect(link.getAttribute('href')).toMatch(/^\/tms\/load-review\?shipment=/)
    expect(screen.queryByRole('button', { name: /Release to billing/ })).toBeNull()
    expect(apiClient.readyToInvoice).not.toHaveBeenCalled()
  })
})

describe('one invoice', () => {
  /**
   * SES is denied on dev, so this is every e-mail the page will ever show there. A green
   * "Sent" over a mail that never left is how an invoice silently goes uncollected.
   */
  it('reports an e-mail SES refused as not sent', () => {
    invoiceMock.mockReturnValue({
      invoice: invoice(),
      bundle: null,
      notices: [notice()],
      payments: [],
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    })

    render(
      <MemoryRouter initialEntries={['/ar/invoices/INV-000123']}>
        <Routes><Route path="/ar/invoices/:id" element={<InvoiceDetail />} /></Routes>
      </MemoryRouter>,
    )
    // The send history is the E-mail tab of the detail page.
    fireEvent.click(screen.getByRole('tab', { name: 'E-mail' }))

    expect(screen.getByText('Not sent')).toBeTruthy()
    expect(screen.queryByText('Sent')).toBeNull()
    expect(screen.getByText(/SES is off on dev/)).toBeTruthy()
    expect(screen.getByText(/identity not verified/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Copy e-mail body/ })).toBeTruthy()
  })
})
