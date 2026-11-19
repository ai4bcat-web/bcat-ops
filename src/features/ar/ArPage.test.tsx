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
const directoryCustomers = vi.hoisted(() => ({ current: [] as Array<Record<string, unknown>> }))
vi.mock('@/hooks/useAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useAuth')>()),
  useAuth: () => ({ isAdmin: false, isOwner: false, hasPageAccess: () => true }),
  useAuthUser: () => ({ userId: 'u', email: 'x@bcatcorp.com', groups: authGroups.current }),
}))

vi.mock('@/hooks/useArWorklist', () => ({ useArWorklist: worklistMock }))
vi.mock('@/hooks/useOpenInvoices', () => ({ useOpenInvoices: openInvoicesMock }))
vi.mock('@/hooks/useCustomerAr', () => ({ useCustomerAr: customerArMock }))
vi.mock('@/hooks/useInvoice', () => ({ useInvoice: invoiceMock }))
vi.mock('@/hooks/useDirectory', () => ({ useDirectory: () => ({ customers: directoryCustomers.current, locations: [], refresh: vi.fn() }) }))
vi.mock('@/features/tms/useOwnershipDivisions', () => ({
  useOwnershipDivisions: () => ({ divisions: [{ code: 'BROKERAGE', name: 'BCAT Logistics' }], loading: false, error: null, refresh: vi.fn() }),
}))
vi.mock('@/lib/worklistShipments', () => ({ loadWorklistShipments: vi.fn().mockResolvedValue([]) }))
vi.mock('@/hooks/useFactoringItems', () => ({
  useFactoringItems: () => ({ items: [], loading: false, error: null, refresh: vi.fn() }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))
const factorReady = vi.hoisted(() => ({ current: {} as Record<string, { orderId: string; factorBilled: boolean; ready: boolean; missing: string[] }> }))
vi.mock('@/lib/otrClient', () => ({
  assembleInvoice: vi.fn(), submitToOtr: vi.fn(), uploadOtrDocs: vi.fn(),
  previewOtrDocs: vi.fn(async () => ({ pro: 'S-1001', found: true, pod: { name: 'POD.pdf', url: 'https://s3.test/pod' }, rateCon: { name: 'RC.pdf', url: 'https://s3.test/rc' } })),
}))
vi.mock('@/lib/apiClient', () => ({
  graphqlErrorText: (e: unknown) => String(e),
  getInvoiceAttachmentPlans: vi.fn().mockResolvedValue([]),
  listInvoicesByMonth: vi.fn().mockResolvedValue([]),
  listUserProfiles: vi.fn().mockResolvedValue([{ id: 'rep-1', email: 'jenny@bcatcorp.com', name: 'Jenny Rep' }]),
  batchGenerateInvoices: vi.fn(),
  // Ready to factor: nothing is factor-billed unless a test says so.
  previewFactorReady: vi.fn(async ({ orderIds }: { orderIds: string[] }) => ({
    results: orderIds.map((orderId) => factorReady.current[orderId] ?? { orderId, factorBilled: false, ready: false, missing: [] }),
  })),
  sendToFactor: vi.fn(),
  batchEmailInvoices: vi.fn(),
  voidInvoice: vi.fn(),
  reversePayment: vi.fn(),
  renderInvoicePdf: vi.fn(),
  markInvoiceSent: vi.fn(),
  getInvoicePdfUrl: vi.fn().mockResolvedValue('blob:pdf'),
  getShipmentBundle: vi.fn().mockResolvedValue({ shipment: { id: 's1', version: 1 }, orders: [], loads: [], loadCarriers: [], charges: [], financials: [], documents: [] }),
  recalcCharges: vi.fn(),
  reviseInvoice: vi.fn(),
  prepareDocumentUpload: vi.fn(),
  putPresignedFile: vi.fn(),
  commitDocument: vi.fn(),
  previewInvoice: vi.fn(),
  previewInvoicePacket: vi.fn().mockResolvedValue({ invoiceId: 'x', name: 'Invoice.pdf', url: null, pages: [], separate: [], error: null }),
  readyToInvoice: vi.fn(),
  // The invoice detail now carries a Commission card; it reads settings before it reads
  // anything else, and commissions are off here, so the card renders nothing.
  commissionModelsDeployed: () => true,
  getTmsSettings: vi.fn().mockResolvedValue({ id: 'default', commissionsEnabled: false }),
  listCommissionsByInvoice: vi.fn().mockResolvedValue([]),
  previewCommissions: vi.fn(),
  runCommissions: vi.fn(),
}))
// Ready to invoice's lane / carrier / carrier pay come from the board rows for its shipments.
const boardRows = vi.hoisted(() => ({ current: [] as unknown[] }))
vi.mock('@/hooks/useShipments', () => ({ useShipments: () => ({ shipments: boardRows.current, loading: false, error: null, partial: false }) }))
// The dialogs are mount-to-open and fetch their own context; their behaviour has its own
// tests, and here they would only drag the finance Lambda into a test about the board.
// The documents card has its own tests; here only whether it opens, for which shipment, and whether it may change anything.
vi.mock('@/features/tms/loadReview/LoadReviewDocuments', () => ({
  LoadReviewDocuments: ({ shipmentId, readOnly }: { shipmentId: string; readOnly?: boolean }) => (
    <div data-testid="docs-card" data-shipment={shipmentId} data-readonly={String(!!readOnly)} />
  ),
}))
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

// Sent (marked sent): an unsent invoice is a draft in Ready to invoice, not a receivable.
const sentInvoice = () => invoice({ markedSentAt: '2026-09-20T12:00:00.000Z' })
const openSet = [sentInvoice()]

/** Let the page's mocked fetches resolve inside act, so their state updates are not reported as stray. */
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

async function setup(rowsByTab: Partial<Record<string, ArWorklistRow[]>> = {}, url = '/') {
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
  const view = render(<MemoryRouter initialEntries={[url]}><ArPage /></MemoryRouter>)
  await settle()
  return view
}

beforeEach(() => {
  // These tests read the cards; a viewer starts with them folded away (TmsHeadBand.test covers that).
  localStorage.setItem('ar.invoicing.cards', 'open')
  openSet.splice(0, openSet.length, sentInvoice())
  vi.clearAllMocks()
  ;(apiClient.previewInvoice as Mock).mockResolvedValue({ releaseGate: { ok: true, missing: [] } })
  ;(apiClient.readyToInvoice as Mock).mockResolvedValue({ bundle: {}, releaseGate: { ok: true, missing: [] } })
})

describe('the AR board', () => {
  it('offers Ready, Invoiced and Aging (no Paid tab), and each one renders', async () => {
    await setup({ UNBILLED: [worklistRow()] })
    expect(screen.queryByRole('tab', { name: /^Docs needed/ })).toBeNull()
    expect(screen.queryByRole('tab', { name: /^Ready for billing/ })).toBeNull()
    // Payments, credits and debits moved to their own Accounting page (Ryne 2026-11-15).
    expect(screen.queryByRole('tab', { name: /^Payments & credits/ })).toBeNull()
    // Paid moved to Payments Received too (Ryne 2026-11-16).
    expect(screen.queryByRole('tab', { name: /^Paid/ })).toBeNull()
    for (const label of ['Ready to Invoice', 'Invoiced', 'Aging']) {
      const tab = screen.getByRole('tab', { name: new RegExp(`^${label}`) })
      fireEvent.click(tab)
      await settle()
      expect(tab.getAttribute('aria-selected')).toBe('true')
    }
    // The summary cards sit beside the tabs on every tab.
    expect(screen.getByLabelText('Receivables totals')).toBeTruthy()
  })

  /**
   * The strip is what somebody reads before deciding who to chase. Every figure comes out
   * of `@/lib/arAging` — the page must not reach its own total, or the CSV and the screen
   * would disagree about what is owed.
   */
  it('shows the summary beside the tabs: pending with shippers and late money', async () => {
    await setup({ UNBILLED: [worklistRow()] })
    await settle()
    // One open, manually invoiced invoice of $2,500.00, past its 2026-10-20 due date.
    const strip = within(screen.getByLabelText('Receivables totals'))
    const card = (label: string) => strip.getByText(label).closest('.tms-list-row')?.querySelector('.tms-list-row-value')?.textContent
    expect(card('Pending with shippers')).toBe('$2,500.00')
    expect(strip.queryByText('Factored, open')).toBeNull()
    expect(card('Late')).toBe('$2,500.00')
    expect(strip.getAllByText('1 invoice').length).toBeGreaterThan(0)
  })

  /**
   * A row that is not billable has to say so where the decision is made. Hiding the
   * refusal behind the dialog means opening every row to find the two that are stuck.
   */
  it('does not try to invoice an order that is not ready, and says why', async () => {
    await setup({
      UNBILLED: [worklistRow({
        docsReady: false,
        docsMissing: ['POD'],
        reasons: ['The POD has not been accepted yet.'],
      })],
    })

    expect(screen.getByText('The POD has not been accepted yet.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Generate invoice for/ })).toBeNull()
    expect(apiClient.batchGenerateInvoices).not.toHaveBeenCalled()
    const select = screen.getByRole('checkbox', { name: 'Select S-1001' })
    expect((select as HTMLInputElement).disabled).toBe(true)
  })

  // Ryne 2026-11-14: no Generate button; a released order's invoice is made by itself (never sent).
  // Posting is an action on the Invoicing page: its grant opens it (Ryne 2026-11-12), the broad tms grant does not.
  it.each([
    ['tms-only', ['page-tms', 'page-loads'], false],
    ['page-invoicing', ['page-invoicing'], true],
    ['ADMIN', ['ADMIN'], true],
    ['page-billingRelease', ['page-billingRelease'], true],
  ])('Ready to invoice makes the missing invoice by itself for %s: called=%s', async (_label, groups, called) => {
    authGroups.current = groups
    ;(apiClient.batchGenerateInvoices as Mock).mockResolvedValue({ results: [{ orderId: 'o1', invoiceId: 'inv-1' }] })
    await setup({ UNBILLED: [worklistRow()] })
    await settle()
    expect(screen.queryByRole('button', { name: /Generate invoice for/ })).toBeNull()
    if (called) expect(apiClient.batchGenerateInvoices).toHaveBeenCalledWith({ orderIds: ['o1'] })
    else expect(apiClient.batchGenerateInvoices).not.toHaveBeenCalled()
    // Generating never sends.
    expect(apiClient.batchEmailInvoices).not.toHaveBeenCalled()
    const batch = screen.getByRole('button', { name: 'Batch generate invoices' }) as HTMLButtonElement
    expect(batch.title === '').toBe(called)
    authGroups.current = []
  })

  it('shows a refused invoice on its row with Retry, and Retry asks once more', async () => {
    authGroups.current = ['ADMIN']
    ;(apiClient.batchGenerateInvoices as Mock).mockResolvedValue({ results: [{ orderId: 'o1', error: 'The customer has no billing method' }] })
    await setup({ UNBILLED: [worklistRow()] })
    await settle()
    expect(apiClient.batchGenerateInvoices).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Invoice not made')).toBeTruthy()
    ;(apiClient.batchGenerateInvoices as Mock).mockResolvedValue({ results: [{ orderId: 'o1', invoiceId: 'inv-1' }] })
    fireEvent.click(screen.getByRole('button', { name: 'Retry the invoice for S-1001' }))
    await settle()
    expect(apiClient.batchGenerateInvoices).toHaveBeenCalledTimes(2)
    authGroups.current = []
  })

  it('never lists a released order whose shipment has not delivered', async () => {
    await setup({
      UNBILLED: [
        worklistRow(),
        worklistRow({
          orderId: 'o2', shipmentId: 's2', shipmentNumber: 'S-2002', deliveredAt: null,
          shipment: shipment({ id: 's2', number: 'S-2002', status: 'OPEN', deliveredAt: null }),
        }),
      ],
    })
    expect(screen.getByText('S-1001')).toBeTruthy()
    expect(screen.queryByText('S-2002')).toBeNull()
    expect(screen.getByTestId('ar-ready-note')).toHaveTextContent('Load Review')
  })

  it('shows rev division and sales rep, and groups with subtotals', async () => {
    await setup({
      UNBILLED: [
        worklistRow({ shipment: shipment({ revDivision: 'BROKERAGE', salesRepId: 'rep-1' } as Partial<ShipmentRecord>) }),
        worklistRow({
          orderId: 'o2', shipmentId: 's2', shipmentNumber: 'S-2002', customerName: 'Zeta Co', revenueCents: 10_000,
          shipment: shipment({ id: 's2', number: 'S-2002' }),
        }),
      ],
    })
    const grid = screen.getByRole('table', { name: 'Ready to invoice' })
    expect(within(grid).getByText('BCAT Logistics')).toBeTruthy()
    expect(within(grid).getByText('Jenny Rep')).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox', { name: 'Group by' }), { target: { value: 'customer' } })
    await settle()
    const heads = screen.getAllByTestId('ar-group-head').map((h) => h.textContent)
    expect(heads).toEqual(['Acme Foods1 shipment$2,500.00', 'Zeta Co1 shipment$100.00'])
    fireEvent.change(screen.getByRole('combobox', { name: 'Group by' }), { target: { value: 'none' } })
  })

  it('keeps a short-paid invoice on Invoiced with what is still open', async () => {
    openSet.splice(0, openSet.length, invoice({ status: 'PARTIAL', paidCents: 200_000, balanceCents: 50_000 }))
    await setup()
    fireEvent.click(screen.getByRole('tab', { name: /^Invoiced/ }))
    await settle()
    expect(screen.getByText('Partially paid · $500.00 open')).toBeTruthy()
    openSet.splice(0, openSet.length, sentInvoice())
  })
})

describe('owed by customer or division', () => {
  it('a customer in the URL narrows the totals and shows what they owe by due date', async () => {
    await setup({}, '/?customer=c1')
    const owed = within(screen.getByLabelText('Owed by Acme Foods'))
    const value = (label: string) => owed.getByText(label).closest('.tms-list-row')?.querySelector('.tms-list-row-value')?.textContent
    expect(value('Past due')).toBe('$2,500.00')
    expect(value('Not yet due')).toBe('$0.00')
    expect(screen.getByRole('button', { name: 'Customer: Acme Foods' })).toBeTruthy()
  })

  it('a customer with nothing open zeroes the totals and empties Invoiced', async () => {
    await setup({}, '/?customer=nobody')
    const strip = within(screen.getByLabelText('Receivables totals'))
    expect(strip.getByText('Pending with shippers').closest('.tms-list-row')?.querySelector('.tms-list-row-value')?.textContent).toBe('$0.00')
    fireEvent.click(screen.getByRole('tab', { name: /^Invoiced/ }))
    await settle()
    expect(screen.getByRole('tab', { name: /^Invoiced/ }).getAttribute('title')).toContain('$0.00 open')
  })

  it('Clear filters clears the customer filter too', async () => {
    await setup({}, '/?customer=c1')
    fireEvent.click(screen.getByRole('button', { name: /^Clear 1 filter/ }))
    await settle()
    expect(screen.queryByLabelText('Owed by Acme Foods')).toBeNull()
    expect(screen.getByRole('button', { name: 'Customer: All' })).toBeTruthy()
  })
})

describe('the AR dense grid', () => {
  const bodyRows = () => within(screen.getByRole('table', { name: 'Ready to invoice' })).getAllByRole('row').slice(1)

  it('draws the dense grid with its controls and sorts a money column by cents', async () => {
    await setup({
      UNBILLED: [
        worklistRow({ orderId: 'o1', shipmentNumber: 'S-1', revenueCents: 250_000 }),
        worklistRow({ orderId: 'o2', shipmentNumber: 'S-2', revenueCents: 9_900 }),
        worklistRow({ orderId: 'o3', shipmentNumber: 'S-3', revenueCents: 1_000_000 }),
      ],
    })
    expect(screen.getByRole('button', { name: /Columns/ })).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Row density' })).toBeTruthy()
    expect(screen.getByText('3 rows')).toBeTruthy()

    const pros = () => bodyRows().map((r) => within(r).getAllByRole('cell')[1].textContent)
    fireEvent.click(screen.getByTitle('Sort by Amount'))
    expect(pros()).toEqual(['S-2', 'S-1', 'S-3'])
    fireEvent.click(screen.getByTitle('Sort by Amount'))
    expect(pros()).toEqual(['S-3', 'S-1', 'S-2'])
    // Nothing on the invoices page leads to the shipment (Ryne, 2026-11-12).
    expect(document.querySelector('a[href*="/tms/shipments/"]')).toBeNull()
  })

  it('keeps the row tick box and Generate button working inside the grid', async () => {
    await setup({ UNBILLED: [worklistRow()] })
    const box = screen.getByRole('checkbox', { name: 'Select S-1001' }) as HTMLInputElement
    fireEvent.click(box)
    expect(box.checked).toBe(true)
    expect(screen.getByText(/1 selected/)).toBeTruthy()
  })

  it('gives each view its own grid; PRO and Invoice # open the invoice, never the shipment', async () => {
    // Only a SENT invoice is in Invoiced; an unsent one is a draft in Ready to invoice.
    openSet.splice(0, openSet.length, invoice({ sentAt: '2026-09-20T12:05:00.000Z', sentCount: 1 }))
    await setup({ UNBILLED: [worklistRow()] })
    fireEvent.click(screen.getByRole('tab', { name: /^Invoiced/ }))
    await settle()
    const grid = screen.getByRole('table', { name: 'Invoiced' })
    expect(within(grid).getByText('$2,500.00', { selector: 'span' })).toBeTruthy()
    // No payment entry on the AR tabs (Ryne 2026-11-16): no links on a row, no tick boxes, no Record payment.
    expect(within(grid).queryAllByRole('link')).toHaveLength(0)
    // The only tick boxes are the past-due reminder ones (Ryne 2026-11-17); nothing selects an invoice for payment.
    expect(within(grid).queryAllByRole('checkbox').filter((box) => !/past due reminder/.test(box.getAttribute('aria-label') ?? ''))).toHaveLength(0)
    expect(screen.queryByText(/Record payment/)).toBeNull()
    expect(screen.queryByTestId('ar-record-payment-batch')).toBeNull()
    expect(screen.getByTestId('payments-recorded-note').textContent).toBe('Payments are recorded in Payments Received.')
    // Sending, payments and void live in the invoice drawer, not on the row.
    expect(within(grid).queryByRole('button', { name: /^Send invoice/ })).toBeNull()
    expect(within(grid).queryByRole('combobox', { name: /More actions/ })).toBeNull()
    fireEvent.click(within(grid).getByRole('button', { name: 'Open invoice INV-000123' }))
    expect(await screen.findByRole('region', { name: 'Invoice actions' })).toBeTruthy()
    // Payments are recorded only on Payments Received: the drawer has no payment control, only a note.
    expect(screen.queryByRole('button', { name: 'Receive payment' })).toBeNull()
    expect(screen.queryByRole('link', { name: /Record payment/ })).toBeNull()
    expect(screen.getByTestId('ar-grid-ar-queue-invoiced')).toBeTruthy()
    openSet.splice(0, openSet.length, sentInvoice())
  })

  it('keeps an auto-generated invoice that was never sent in Ready to invoice as a draft; ticking it offers Send 1 invoice', async () => {
    authGroups.current = ['page-invoicing']
    openSet.splice(0, openSet.length, invoice())
    await setup({})
    await settle()
    const grid = screen.getByRole('table', { name: 'Ready to invoice' })
    expect(within(grid).getByText('Draft — not sent')).toBeTruthy()
    expect(within(grid).queryByRole('button', { name: 'Send invoice INV-000123' })).toBeNull()
    const send = screen.getByRole('button', { name: 'Review and send selected invoices' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    fireEvent.click(within(grid).getByRole('checkbox', { name: 'Select S-1001' }))
    expect(send.disabled).toBe(false)
    expect(send.textContent).toContain('Send 1 invoice')
    // PRO opens the invoice drawer, with the send action inside it.
    fireEvent.click(within(grid).getByRole('button', { name: 'Open invoice for PRO S-1001' }))
    expect(await screen.findByRole('button', { name: 'Send invoice' })).toBeTruthy()
    // Ryne 2026-11-14: it opens in the middle of the page (a centered dialog), and Esc closes it.
    const dialog = screen.getByRole('dialog')
    expect(dialog.className).toContain('tms-dialog-invoice')
    expect(dialog.className).not.toContain('tms-drawer')
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await settle()
    expect(screen.queryByRole('dialog')).toBeNull()
    authGroups.current = []
  })

  it('lists a factored draft in Ready to invoice while Billed is set to Manually invoiced (14902 / 14868 / 14916)', async () => {
    authGroups.current = ['page-invoicing']
    localStorage.setItem('tms:ar:billedBy', 'manual')
    openSet.splice(0, openSet.length, invoice({ factored: true }))
    await setup({})
    await settle()
    const grid = screen.getByRole('table', { name: 'Ready to invoice' })
    expect(within(grid).getByRole('checkbox', { name: 'Select S-1001' })).toBeTruthy()
    localStorage.removeItem('tms:ar:billedBy')
    authGroups.current = []
  })
})

describe('Ready to invoice: lane, carrier and margin (internal)', () => {
  it('shows Cust Ref #, Origin, Destination, Carrier, both rates and a red Profit when it is a loss', async () => {
    openSet.splice(0, openSet.length, invoice())
    boardRows.current = [{
      id: 's1', originCity: 'Dallas, TX', destinationCity: 'Joliet, IL', fromState: 'TX', toState: 'IL', carriers: [],
      carrierName: 'Ace Freight', costCents: 300_000, revenueCents: 250_000, customerReference: 'FR-113188-3',
    }]
    await setup({})
    await settle()
    const grid = screen.getByRole('table', { name: 'Ready to invoice' })
    for (const header of ['Cust Ref #', 'Origin', 'Destination', 'Carrier', 'Customer Rate', 'Carrier Rate', 'Profit']) {
      expect(within(grid).getByTitle(`Sort by ${header}`)).toBeTruthy()
    }
    expect(within(grid).getByText('FR-113188-3')).toBeTruthy()
    expect(within(grid).getByText('Dallas, TX')).toBeTruthy()
    expect(within(grid).getByText('Ace Freight')).toBeTruthy()
    const loss = within(grid).getByText('-$500.00')
    expect(loss.getAttribute('style')).toContain('--tms-badge-red')
    boardRows.current = []
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

describe('Ready to invoice: batch Factor', () => {
  it('shows Ready to factor, confirms count, total and factor, then sends each load through the OTR path', async () => {
    authGroups.current = ['page-invoicing']
    factorReady.current = { o1: { orderId: 'o1', factorBilled: true, ready: true, missing: [] } }
    ;(apiClient.getTmsSettings as Mock).mockResolvedValue({ id: 'default', commissionsEnabled: false, factorRemitTo: { name: 'OTR Capital, LLC' } })
    ;(apiClient.batchGenerateInvoices as Mock).mockResolvedValue({ results: [{ orderId: 'o1', invoiceId: 'inv-1' }] })
    ;(apiClient.sendToFactor as Mock).mockResolvedValue({ factoringItem: { id: 'S-1001' }, invoice: {}, reused: false })
    const otr = await import('@/lib/otrClient')
    ;(otr.submitToOtr as Mock).mockResolvedValue({ invoiceId: 555, brokerName: '', isDuplicate: false, uploaded: {}, documentErrors: [] })
    await setup({ UNBILLED: [worklistRow()] })
    await settle()
    expect(screen.getByText('✓ Ready to factor')).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select S-1001' }))
    fireEvent.click(screen.getByTestId('batch-factor'))
    const confirm = await screen.findByTestId('batch-factor-confirm')
    expect(within(confirm).getByText('1')).toBeTruthy()
    expect(within(confirm).getAllByText('$2,500.00').length).toBeGreaterThan(0)
    expect(within(confirm).getByText('OTR Capital, LLC')).toBeTruthy()
    // Nothing goes to OTR until Submit is pressed.
    expect(otr.submitToOtr).not.toHaveBeenCalled()
    expect(await screen.findByTitle('POD preview')).toBeTruthy()
    expect(screen.getByTitle('Customer rate confirmation preview')).toBeTruthy()
    fireEvent.click(screen.getByTestId('batch-factor-submit'))
    expect(await screen.findByTestId('batch-factor-results')).toBeTruthy()
    expect(apiClient.batchGenerateInvoices).toHaveBeenCalledWith({ orderIds: ['o1'] })
    expect(apiClient.sendToFactor).toHaveBeenCalledWith({ invoiceId: 'inv-1' })
    expect(otr.submitToOtr).toHaveBeenCalledWith('S-1001')
    expect(screen.getByText(/Submitted to OTR as invoice 555/)).toBeTruthy()
    factorReady.current = {}
    authGroups.current = []
  })

  it('a factored load that is not ready cannot be ticked, and says what is missing', async () => {
    factorReady.current = { o1: { orderId: 'o1', factorBilled: true, ready: false, missing: ['Consignee needs a ZIP code — OTR needs it to factor the load.'] } }
    await setup({ UNBILLED: [worklistRow()] })
    await settle()
    const box = screen.getByRole('checkbox', { name: 'Select S-1001' }) as HTMLInputElement
    expect(box.disabled).toBe(true)
    expect(screen.getAllByText(/Consignee needs a ZIP code/).length).toBeGreaterThan(0)
    expect((screen.getByTestId('batch-factor') as HTMLButtonElement).disabled).toBe(true)
    factorReady.current = {}
  })

  it('a disabled box has a visible Why? chip that opens the reason (Ryne 2026-11-16)', async () => {
    factorReady.current = { o1: { orderId: 'o1', factorBilled: true, ready: false, missing: ['Missing document: RATE_CON — Rate confirmation'] } }
    await setup({ UNBILLED: [worklistRow()] })
    await settle()
    fireEvent.click(screen.getByTestId('ar-why'))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/Missing document: RATE_CON/)).toBeTruthy()
    factorReady.current = {}
  })

  it('Ready to Invoice shows each customer\'s payment method and MC, and edits them in place (Ryne 2026-11-16)', async () => {
    authGroups.current = ['page-invoicing']
    directoryCustomers.current = [{ id: 'c1', name: 'Acme Foods', billingMethod: null, mcNumber: null, apEmail: 'ap@acme.test', paymentTermsDays: 30, updatedAt: '2026-11-16T10:00:00.000Z' }]
    await setup({ UNBILLED: [worklistRow()] })
    await settle()
    expect(screen.getByTestId('ar-edit-billing').textContent).toBe('Set')
    expect(screen.getByTestId('ar-edit-mc').textContent).toBe('Set')
    fireEvent.click(screen.getByTestId('ar-edit-mc'))
    const dialog = await screen.findByTestId('edit-customer-dialog')
    expect(within(dialog.closest('[role="dialog"]') as HTMLElement).getByText(/changes Acme Foods for all of its loads/)).toBeTruthy()
    expect(within(dialog.closest('[role="dialog"]') as HTMLElement).getByText(/Setting Factor does not send anything to OTR/)).toBeTruthy()
    directoryCustomers.current = []
    authGroups.current = []
  })

  it('the Why? dialog offers the customer editor when the blocker is the customer\'s MC', async () => {
    authGroups.current = ['page-invoicing']
    directoryCustomers.current = [{ id: 'c1', name: 'Acme Foods', billingMethod: 'FACTOR', mcNumber: null, apEmail: 'ap@acme.test', updatedAt: '2026-11-16T10:00:00.000Z' }]
    factorReady.current = { o1: { orderId: 'o1', factorBilled: true, ready: false, missing: ['Broker MC'] } }
    await setup({ UNBILLED: [worklistRow()] })
    await settle()
    fireEvent.click(screen.getByTestId('ar-why'))
    fireEvent.click(await screen.findByTestId('ar-why-edit-customer'))
    expect(await screen.findByTestId('edit-customer-dialog')).toBeTruthy()
    factorReady.current = {}
    directoryCustomers.current = []
    authGroups.current = []
  })
})

describe('Ready to invoice: replace or delete the POD and rate confirmation (Ryne 2026-11-17)', () => {
  const plan = (pod: 'ATTACHED' | 'MISSING') => [{ invoiceId: 'INV-000123', invoicePdf: 'ATTACHED', pod, rateCon: 'MISSING', count: 1, items: [], tooBig: false, carrierPayFlags: [] }]

  it('the POD chip on a draft opens the documents for that shipment, open for changes', async () => {
    authGroups.current = ['page-invoicing']
    ;(apiClient.getInvoiceAttachmentPlans as Mock).mockResolvedValue(plan('ATTACHED'))
    openSet.splice(0, openSet.length, invoice())
    await setup({})
    await settle()
    fireEvent.click(await screen.findByTestId('ar-docs-pod'))
    const card = await screen.findByTestId('docs-card')
    expect(card.getAttribute('data-shipment')).toBe('s1')
    expect(card.getAttribute('data-readonly')).toBe('false')
    expect(screen.queryByText(/Already sent or with OTR/)).toBeNull()
    ;(apiClient.getInvoiceAttachmentPlans as Mock).mockResolvedValue([])
    authGroups.current = []
  })

  it('the RC chip and the row\'s Documents button open the same card', async () => {
    authGroups.current = ['page-invoicing']
    ;(apiClient.getInvoiceAttachmentPlans as Mock).mockResolvedValue(plan('MISSING'))
    openSet.splice(0, openSet.length, invoice())
    await setup({})
    await settle()
    fireEvent.click(await screen.findByTestId('ar-docs-rc'))
    expect((await screen.findByTestId('docs-card')).getAttribute('data-shipment')).toBe('s1')
    ;(apiClient.getInvoiceAttachmentPlans as Mock).mockResolvedValue([])
    authGroups.current = []
  })

  it('an invoice that has already been sent shows its files and says why nothing is offered', async () => {
    authGroups.current = ['page-invoicing']
    ;(apiClient.getInvoiceAttachmentPlans as Mock).mockResolvedValue(plan('ATTACHED'))
    openSet.splice(0, openSet.length, invoice({ sentAt: '2026-11-16T12:00:00.000Z', sentTo: 'ap@acmefoods.com', sentCount: 1 }))
    await setup()
    fireEvent.click(screen.getByRole('tab', { name: /^Invoiced/ }))
    await settle()
    fireEvent.click(await screen.findByTestId('ar-docs-open'))
    expect((await screen.findByTestId('docs-card')).getAttribute('data-readonly')).toBe('true')
    expect(screen.getByText(/Already sent or with OTR/)).toBeTruthy()
    ;(apiClient.getInvoiceAttachmentPlans as Mock).mockResolvedValue([])
    authGroups.current = []
  })

  it('the Why? dialog offers the documents when the blocker is the POD or the rate confirmation', async () => {
    factorReady.current = { o1: { orderId: 'o1', factorBilled: true, ready: false, missing: ['Missing document: RATE_CON — Rate confirmation'] } }
    await setup({ UNBILLED: [worklistRow()] })
    await settle()
    fireEvent.click(screen.getByTestId('ar-why'))
    fireEvent.click(await screen.findByTestId('ar-why-docs'))
    expect(await screen.findByTestId('docs-card')).toBeTruthy()
    factorReady.current = {}
  })
})

describe('Ready to invoice: edit the amount before sending (Ryne 2026-11-18)', () => {
  const bundle = {
    shipment: { id: 's1', version: 3 }, orders: [{ id: 'o1' }], loads: [{ id: 'load-1' }], loadCarriers: [],
    charges: [{ id: 'c1', side: 'CUSTOMER', orderId: 'o1', loadId: 'load-1', loadCarrierId: null, code: 'LINEHAUL', label: 'Linehaul', calculatedBy: 'FLAT',
      rateCents: 250_000, amountCents: 250_000, count: 1, isRate: true, release: null, note: null, sortOrder: 0 }],
    financials: [{ id: 'load-1', frozenAt: null }], documents: [],
  }

  it('a draft row offers Edit amount; it opens the editor with the customer lines', async () => {
    authGroups.current = ['page-invoicing']
    ;(apiClient.getShipmentBundle as Mock).mockResolvedValue(bundle)
    openSet.splice(0, openSet.length, invoice())
    await setup({})
    await settle()
    const grid = screen.getByRole('table', { name: 'Ready to invoice' })
    fireEvent.click(within(grid).getByTestId('ar-edit-amount'))
    expect(await screen.findByText(/Edit invoice · INV-000123/)).toBeTruthy()
    expect(await screen.findByLabelText('Linehaul amount')).toBeTruthy()
    authGroups.current = []
  })

  it('saving marks the draft Edited in the list', async () => {
    authGroups.current = ['page-invoicing']
    ;(apiClient.getShipmentBundle as Mock).mockResolvedValue(bundle)
    ;(apiClient.recalcCharges as Mock).mockResolvedValue(bundle)
    ;(apiClient.reviseInvoice as Mock).mockResolvedValue({ invoice: invoice({ totalCents: 260_000 }), revision: 1 })
    openSet.splice(0, openSet.length, invoice())
    await setup({})
    await settle()
    const grid = screen.getByRole('table', { name: 'Ready to invoice' })
    fireEvent.click(within(grid).getByTestId('ar-edit-amount'))
    const amount = await screen.findByLabelText('Linehaul amount')
    fireEvent.change(amount, { target: { value: '2600' } })
    fireEvent.blur(amount)
    fireEvent.click(screen.getByRole('button', { name: 'Save amount' }))
    await settle()
    expect(apiClient.recalcCharges).toHaveBeenCalledWith(expect.objectContaining({ shipmentId: 's1', changeReason: 'Rate edited before sending' }))
    expect(within(screen.getByRole('table', { name: 'Ready to invoice' })).getByText('Edited')).toBeTruthy()
    authGroups.current = []
  })

  it('no Edit amount without the billing grant, and none once the invoice was sent', async () => {
    authGroups.current = []
    openSet.splice(0, openSet.length, invoice())
    await setup({})
    await settle()
    expect(screen.queryByTestId('ar-edit-amount')).toBeNull()
    authGroups.current = ['page-invoicing']
    openSet.splice(0, openSet.length, invoice({ sentAt: '2026-11-16T12:00:00.000Z', sentCount: 1 }))
    await setup({})
    await settle()
    expect(screen.queryByTestId('ar-edit-amount')).toBeNull()
    authGroups.current = []
  })

  it('the dialog also replaces the POD or rate confirmation, and the list reads the attachment chips again', async () => {
    authGroups.current = ['page-invoicing']
    const withDocs = { ...bundle, documents: [{ id: 'pod-1', shipmentId: 's1', type: 'POD', name: 'POD S-1001.pdf', status: 'ACTIVE', orderId: 'o1', uploadedBy: 'x', uploadedAt: '2026-11-18T12:00:00.000Z' }] }
    ;(apiClient.getShipmentBundle as Mock).mockResolvedValue(withDocs)
    ;(apiClient.getInvoiceAttachmentPlans as Mock).mockResolvedValue([{ invoiceId: 'INV-000123', invoicePdf: 'ATTACHED', pod: 'ATTACHED', rateCon: 'MISSING', count: 1, items: [], tooBig: false, carrierPayFlags: [] }])
    ;(apiClient.prepareDocumentUpload as Mock).mockResolvedValue({ uploadUrl: 'https://s3/put', s3Key: 'shipment-docs/s1/sdoc-new-new.pdf', documentId: 'sdoc-new' })
    ;(apiClient.putPresignedFile as Mock).mockResolvedValue(undefined)
    ;(apiClient.commitDocument as Mock).mockResolvedValue({})
    openSet.splice(0, openSet.length, invoice())
    await setup({})
    await settle()
    const callsBefore = (apiClient.getInvoiceAttachmentPlans as Mock).mock.calls.length
    fireEvent.click(within(screen.getByRole('table', { name: 'Ready to invoice' })).getByTestId('ar-edit-amount'))
    fireEvent.click(await screen.findByRole('button', { name: 'Replace POD S-1001.pdf' }))
    fireEvent.change(screen.getByLabelText('Document file'), { target: { files: [new File(['%PDF'], 'pod-new.pdf', { type: 'application/pdf' })] } })
    fireEvent.click(screen.getByRole('button', { name: /^Replace$/ }))
    await settle()
    expect(apiClient.commitDocument).toHaveBeenCalledWith(expect.objectContaining({ shipmentId: 's1', type: 'POD', replacesDocumentId: 'pod-1' }))
    expect((apiClient.getInvoiceAttachmentPlans as Mock).mock.calls.length).toBeGreaterThan(callsBefore)
    ;(apiClient.getInvoiceAttachmentPlans as Mock).mockResolvedValue([])
    authGroups.current = []
  })
})
