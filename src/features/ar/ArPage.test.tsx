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
vi.mock('@/features/tms/useOwnershipDivisions', () => ({
  useOwnershipDivisions: () => ({ divisions: [{ code: 'BROKERAGE', name: 'BCAT Logistics' }], loading: false, error: null, refresh: vi.fn() }),
}))
vi.mock('@/lib/worklistShipments', () => ({ loadWorklistShipments: vi.fn().mockResolvedValue([]) }))
vi.mock('@/hooks/useFactoringItems', () => ({
  useFactoringItems: () => ({ items: [], loading: false, error: null, refresh: vi.fn() }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))
const factorReady = vi.hoisted(() => ({ current: {} as Record<string, { orderId: string; factorBilled: boolean; ready: boolean; missing: string[] }> }))
vi.mock('@/lib/otrClient', () => ({ assembleInvoice: vi.fn(), submitToOtr: vi.fn(), uploadOtrDocs: vi.fn() }))
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
  vi.clearAllMocks()
  ;(apiClient.previewInvoice as Mock).mockResolvedValue({ releaseGate: { ok: true, missing: [] } })
  ;(apiClient.readyToInvoice as Mock).mockResolvedValue({ bundle: {}, releaseGate: { ok: true, missing: [] } })
})

describe('the AR board', () => {
  it('offers the three statuses and the two ledger views, and each one renders', async () => {
    await setup({ UNBILLED: [worklistRow()] })
    expect(screen.queryByRole('tab', { name: /^Docs needed/ })).toBeNull()
    expect(screen.queryByRole('tab', { name: /^Ready for billing/ })).toBeNull()
    for (const label of ['Ready to invoice', 'Invoiced', 'Paid', 'Payments & credits', 'Aging']) {
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
    expect(card('Pending with OTR')).toBe('$0.00')
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
    openSet.splice(0, openSet.length, invoice())
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
    expect(screen.getByRole('tab', { name: /^Invoiced/ }).textContent).toContain('$0.00')
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
    expect(within(grid).queryAllByRole('link')).toHaveLength(0)
    // Sending, payments and void live in the invoice drawer, not on the row.
    expect(within(grid).queryByRole('button', { name: /^Send invoice/ })).toBeNull()
    expect(within(grid).queryByRole('combobox', { name: /More actions/ })).toBeNull()
    fireEvent.click(within(grid).getByRole('button', { name: 'Open invoice INV-000123' }))
    expect(await screen.findByRole('region', { name: 'Invoice actions' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Receive payment' })).toBeTruthy()
    expect(screen.getByTestId('ar-grid-ar-queue-invoiced')).toBeTruthy()
    openSet.splice(0, openSet.length, invoice())
  })

  it('keeps an auto-generated invoice that was never sent in Ready to invoice as a draft; ticking it offers Send 1 invoice', async () => {
    authGroups.current = ['page-invoicing']
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
    authGroups.current = []
  })
})

describe('Ready to invoice: lane, carrier and margin (internal)', () => {
  it('shows Cust Ref #, Origin, Destination, Carrier, both rates and a red Profit when it is a loss', async () => {
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
    expect(within(confirm).getByText('$2,500.00')).toBeTruthy()
    expect(within(confirm).getByText('OTR Capital, LLC')).toBeTruthy()
    // Nothing goes to OTR until Submit is pressed.
    expect(otr.submitToOtr).not.toHaveBeenCalled()
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
})
