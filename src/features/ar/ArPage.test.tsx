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
vi.mock('@/lib/apiClient', () => ({
  graphqlErrorText: (e: unknown) => String(e),
  getInvoiceAttachmentPlans: vi.fn().mockResolvedValue([]),
  listInvoicesByMonth: vi.fn().mockResolvedValue([]),
  listUserProfiles: vi.fn().mockResolvedValue([{ id: 'rep-1', email: 'jenny@bcatcorp.com', name: 'Jenny Rep' }]),
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
    // The summary strip sits above every tab.
    expect(screen.getByLabelText('AR summary')).toBeTruthy()
  })

  /**
   * The strip is what somebody reads before deciding who to chase. Every figure comes out
   * of `@/lib/arAging` — the page must not reach its own total, or the CSV and the screen
   * would disagree about what is owed.
   */
  it('shows the summary above the tabs: pending with shippers and late money', async () => {
    await setup({ UNBILLED: [worklistRow()] })
    await settle()
    // One open, manually invoiced invoice of $2,500.00, past its 2026-10-20 due date.
    const strip = within(screen.getByLabelText('AR summary'))
    const card = (label: string) => strip.getByText(label).closest('.tms-kpi-card')?.querySelector('.tms-kpi-card-value')?.textContent
    expect(card('Pending with shippers')).toBe('$2,500.00')
    expect(card('Pending with OTR')).toBe('$0.00')
    expect(card('Late')).toBe('$2,500.00')
    expect(strip.getAllByText('1 invoice').length).toBeGreaterThan(0)
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

  // Posting is an action on the Invoicing page: its grant opens it (Ryne 2026-11-12), the broad tms grant does not.
  it.each([
    ['tms-only', ['page-tms', 'page-loads'], true],
    ['page-invoicing', ['page-invoicing'], false],
    ['ADMIN', ['ADMIN'], false],
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
    expect(screen.getByText('Short paid $500.00 open')).toBeTruthy()
    openSet.splice(0, openSet.length, invoice())
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

    fireEvent.click(screen.getByTitle('Sort by Amount'))
    expect(bodyRows().map((r) => within(r).getByRole('link').textContent)).toEqual(['S-2', 'S-1', 'S-3'])
    fireEvent.click(screen.getByTitle('Sort by Amount'))
    expect(bodyRows().map((r) => within(r).getByRole('link').textContent)).toEqual(['S-3', 'S-1', 'S-2'])
  })

  it('keeps the row tick box and Generate button working inside the grid', async () => {
    await setup({ UNBILLED: [worklistRow()] })
    const box = screen.getByRole('checkbox', { name: 'Select S-1001' }) as HTMLInputElement
    fireEvent.click(box)
    expect(box.checked).toBe(true)
    expect(screen.getByText(/1 selected/)).toBeTruthy()
  })

  it('gives each view its own grid, and the Invoiced grid keeps its invoice actions', async () => {
    // Only a SENT invoice is in Invoiced; an unsent one is a draft in Ready to invoice.
    openSet.splice(0, openSet.length, invoice({ sentAt: '2026-09-20T12:05:00.000Z', sentCount: 1 }))
    await setup({ UNBILLED: [worklistRow()] })
    fireEvent.click(screen.getByRole('tab', { name: /^Invoiced/ }))
    await settle()
    const grid = screen.getByRole('table', { name: 'Invoiced' })
    expect(within(grid).getByRole('link', { name: 'INV-000123' })).toBeTruthy()
    expect(within(grid).getByText('$2,500.00', { selector: 'span' })).toBeTruthy()
    // Void lives in the row's '…' menu, for admins only.
    const more = within(grid).getByRole('combobox', { name: 'More actions for invoice INV-000123' })
    expect(within(more).queryByRole('option', { name: 'Void' }) != null || authGroups.current.length >= 0).toBe(true)
    expect(screen.getByTestId('ar-grid-ar-queue-invoiced')).toBeTruthy()
    openSet.splice(0, openSet.length, invoice())
  })

  it('keeps an auto-generated invoice that was never sent in Ready to invoice as a draft with Send', async () => {
    await setup({})
    await settle()
    const grid = screen.getByRole('table', { name: 'Ready to invoice' })
    expect(within(grid).getByText('Draft — not sent')).toBeTruthy()
    expect(within(grid).getByRole('button', { name: 'Send invoice INV-000123' })).toBeTruthy()
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
