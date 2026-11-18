// @vitest-environment jsdom
/**
 * The AP desk's job is to be believed about money going out.
 *
 * Four of these five assertions are about honesty rather than layout: a bill whose amount
 * disagrees with its lines wears that variance where the approve button is; an approved
 * bill says how late it already is; the strip's figures are `@/lib/arAging`'s, not a
 * second arithmetic written in the page; and an assignment nobody has billed offers the
 * one action that can move it. The fifth pins the seven tabs, because the page is the only
 * route to five of them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within, act, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ApWorklistRow } from '@/hooks/useApWorklist'
import type { CarrierBillRecord, LoadCarrierRecord, ShipmentRecord } from '@/types/tms'
import { ageOpenItems } from '@/lib/arAging'
import { chicagoDateStr } from '@/lib/date'
import { listCarrierPaymentInfo } from '@/lib/apiClient'
import { ApPage } from './ApPage'
import { deleteBill } from '@/lib/apiClient'

const worklistMock = vi.hoisted(() => vi.fn())
const authState = vi.hoisted(() => ({ isAdmin: false }))
const openBillsMock = vi.hoisted(() => vi.fn())
const carrierApMock = vi.hoisted(() => vi.fn())
const needsReviewRows = vi.hoisted(() => ({ rows: [] as unknown[] }))
const needsReviewRefresh = vi.hoisted(() => vi.fn())
const downloadCsvMock = vi.hoisted(() => vi.fn())
const legsMock = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/useApWorklist', () => ({ useApWorklist: worklistMock }))
vi.mock('@/hooks/useOpenBills', () => ({ useOpenBills: openBillsMock }))
vi.mock('@/hooks/useCarrierAp', () => ({ useCarrierAp: carrierApMock }))
vi.mock('@/features/finance/useNeedsReview', () => ({
  useNeedsReview: () => ({ rows: needsReviewRows.rows, questions: [], error: null, refresh: needsReviewRefresh, replaceQuestion: vi.fn() }),
  openReviewCount: () => 0,
}))
vi.mock('@/features/finance/MarkReviewedDialog', () => ({
  MarkReviewedDialog: ({ flag, onCleared }: { flag: { id: string }; onCleared: () => void }) => (
    <button type="button" onClick={onCleared}>confirm clear for {flag.id}</button>
  ),
}))
// Every bill in these tests is on a delivered load (the Payables rule); PO and delivery are fixed.
vi.mock('./useBillFacts', () => ({
  useBillFacts: () => ({
    facts: { get: () => ({ shipmentNumber: 'S-1001', customerRef: 'PO-77', deliveredAt: '2026-10-20T12:00:00.000Z', delivered: true, customerName: 'Acme Foods' }) },
    loading: false,
  }),
}))
vi.mock('@/hooks/useCarriers', () => ({
  useCarriers: () => ({ carriers: [], loading: false, error: null, refresh: vi.fn(), replace: vi.fn() }),
}))
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ isAdmin: authState.isAdmin, isOwner: false, hasPageAccess: () => true }),
}))
vi.mock('@/lib/directoryCsv', async (original) => ({ ...(await original<typeof import('@/lib/directoryCsv')>()), downloadCsv: downloadCsvMock }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() } }))
// The AP inbox has its own tests; here it would only drag its router into a test about the board.
vi.mock('./inbox/useApInbox', () => ({
  useApInboxStatus: () => ({ status: null, error: null, refresh: vi.fn().mockResolvedValue(undefined), syncing: false, progress: null, syncNow: vi.fn() }),
  useApInboxItems: () => ({ items: [], loading: false, error: null, refresh: vi.fn().mockResolvedValue(undefined) }),
}))
vi.mock('@/lib/apiClient', () => ({
  graphqlErrorText: (e: unknown) => String(e),
  getTmsSettings: vi.fn().mockResolvedValue({ apRequireSignedRateCon: true }),
  listBillsByMonth: vi.fn().mockResolvedValue([]),
  listLoadCarriersByLoads: legsMock,
  listOwnershipDivisions: vi.fn().mockResolvedValue([]),
  voidBill: vi.fn(),
  deleteBill: vi.fn(),
  unapproveBill: vi.fn(),
  reverseApPayment: vi.fn(),
  listCarrierPaymentInfo: vi.fn().mockResolvedValue([]),
  getFactorRemitEmails: vi.fn().mockResolvedValue({}),
  selectBillsForPayment: vi.fn(),
  unselectBills: vi.fn(),
}))
// The dialogs fetch their own context and have their own tests; here they would only drag
// the finance Lambda into a test about the board.
vi.mock('./components/RecordBillDialog', () => ({ RecordBillDialog: () => null }))
vi.mock('./components/ApproveBillDialog', () => ({ ApproveBillDialog: ({ bill }: { bill: { id: string } }) => <p>approve dialog for {bill.id}</p> }))
vi.mock('./components/UpdateCarrierChargesDialog', () => ({ UpdateCarrierChargesDialog: () => null }))
vi.mock('./components/PayCarrierDialog', () => ({ PayCarrierDialog: () => null }))
vi.mock('./components/PayToDialog', () => ({ PayToDialog: ({ carrierName }: { carrierName: string }) => <p>pay-to editor for {carrierName}</p> }))
vi.mock('./components/ApCreditDialog', () => ({ ApCreditDialog: () => null }))
vi.mock('./components/SendRemittanceDialog', () => ({ SendRemittanceDialog: () => null }))
vi.mock('./components/SetBillDatesDialog', () => ({ SetBillDatesDialog: ({ bill }: { bill: { id: string } }) => <p>dates dialog for {bill.id}</p> }))

/** Dates are relative to the day the suite runs, so no clock makes this flaky. */
const TODAY = chicagoDateStr(new Date())
// Subtract calendar days from the Chicago date string: a fixed 24 h per day is off by one across a DST change.
const daysAgo = (days: number) => {
  const [y, m, d] = TODAY.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10)
}

function assignment(patch: Partial<LoadCarrierRecord> = {}): LoadCarrierRecord {
  return {
    id: 'lc1',
    loadId: 'l1',
    shipmentId: 's1',
    kind: 'CARRIER',
    status: 'ACTIVE',
    carrierId: 'car1',
    carrierName: 'Blue Line Trucking',
    costCents: 150_000,
    rateConStatus: 'SIGNED',
    docsMissing: [],
    apStatus: 'AWAITING_INVOICE',
    apStatusChangedAt: '2026-10-20T12:00:00.000Z',
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

function worklistRow(patch: Partial<ApWorklistRow> = {}): ApWorklistRow {
  return {
    assignment: assignment(),
    shipment: shipment(),
    loadCarrierId: 'lc1',
    loadId: 'l1',
    shipmentId: 's1',
    shipmentNumber: 'S-1001',
    carrierId: 'car1',
    carrierName: 'Blue Line Trucking',
    billId: null,
    deliveredAt: '2026-10-20T12:00:00.000Z',
    apStatusChangedAt: '2026-10-20T12:00:00.000Z',
    costCents: 150_000,
    apBalanceCents: null,
    docsMissing: [],
    docsReady: true,
    rateConSigned: true,
    reasons: [],
    ...patch,
  }
}

function bill(patch: Partial<CarrierBillRecord> = {}): CarrierBillRecord {
  return {
    id: 'cb:lc1:1',
    loadCarrierId: 'lc1',
    loadId: 'l1',
    shipmentId: 's1',
    shipmentNumber: 'S-1001',
    carrierId: 'car1',
    carrierName: 'Blue Line Trucking',
    payeeKind: 'CARRIER',
    remitTo: { name: 'Blue Line Trucking', method: 'ACH' },
    status: 'TO_BE_PAID',
    billNumber: 'BL-7788',
    billDate: daysAgo(40),
    billMonth: daysAgo(40).slice(0, 7),
    recordedAt: '2026-10-21T12:00:00.000Z',
    recordedBy: 'ryne@bcatcorp.com',
    dueAt: daysAgo(10),
    termsDays: 30,
    grossCents: 150_000,
    quickPayFeeCents: 0,
    netCents: 150_000,
    billedCents: 150_000,
    varianceCents: 0,
    paidCents: 0,
    creditedCents: 0,
    balanceCents: 150_000,
    apOpen: 'OPEN',
    createdBy: 'ryne@bcatcorp.com',
    updatedBy: 'ryne@bcatcorp.com',
    version: 1,
    ...patch,
  }
}

async function setup(options: { rowsByTab?: Partial<Record<string, ApWorklistRow[]>>; bills?: CarrierBillRecord[]; url?: string } = {}) {
  const bills = options.bills ?? [bill()]
  worklistMock.mockImplementation((tab: string) => ({
    rows: options.rowsByTab?.[tab] ?? [],
    loading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
  }))
  openBillsMock.mockReturnValue({
    bills,
    aging: ageOpenItems(
      bills.map((b) => ({ partyId: b.carrierId, partyName: b.carrierName ?? '', dueAt: b.dueAt, balanceCents: b.balanceCents })),
      TODAY,
    ),
    approvedCents: bills.reduce((sum, b) => (b.status === 'TO_BE_PAID' ? sum + b.balanceCents : sum), 0),
    loading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
  })
  carrierApMock.mockReturnValue({
    bills: [],
    payments: [],
    openCents: 0,
    unappliedCents: 0,
    loading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
  })
  let view!: ReturnType<typeof render>
  await act(async () => { view = render(<MemoryRouter initialEntries={[options.url ?? '/']}><ApPage /></MemoryRouter>) })
  return view
}

beforeEach(() => {
  vi.clearAllMocks()
  legsMock.mockResolvedValue(new Map())
  // These tests read the cards; a viewer starts with them folded away (TmsHeadBand.test covers that).
  localStorage.setItem('ap.payables.cards', 'open')
})

describe('the AP board', () => {
  it('offers every view of the money, and each one renders', async () => {
    await setup({ rowsByTab: { AWAITING_INVOICE: [worklistRow()] } })
    for (const label of ['Expected', 'Aging(?! by carrier)', 'Selected', 'Cash requirements', 'Paid', 'Payments & credits', 'Aging by carrier', 'AP inbox']) {
      const tab = screen.getByRole('tab', { name: new RegExp(`^${label}`) })
      fireEvent.click(tab)
      expect(tab.getAttribute('aria-selected')).toBe('true')
    }
    // The last click landed on the AP inbox, whose empty queue says so; the aging report's body is the strip.
    expect(screen.getByText(/Invoice e-mails the AP inbox finds/)).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: /^Aging by carrier/ }))
    expect(screen.getByLabelText('AP totals')).toBeTruthy()
  })

  /**
   * Aging is the short list Ryne asked for (Pro #, carrier, pay to, dates, amount and two links). A bill still in review
   * says so on its amount, and "Move to Selected" does not skip approval: it opens the approval dialog first.
   */
  it('marks a bill still in review on the Aging tab, and Move to Selected goes through approval', async () => {
    await setup({
      rowsByTab: { IN_REVIEW: [worklistRow()] },
      bills: [bill({ status: 'IN_REVIEW', billedCents: 175_000, varianceCents: 25_000, billNumber: 'IR-9' })],
    })
    fireEvent.click(screen.getByRole('tab', { name: /^Aging(?! by carrier)/ }))

    expect(screen.getByText('In review')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Move bill IR-9 to Selected' }))
    expect(screen.getByText(/approve dialog for/)).toBeTruthy()
  })

  /**
   * Moving a load to billing creates the bill before the carrier's invoice exists, so its dates are placeholders. The
   * review queue has to say so and offer the one thing that fixes it, or somebody approves on a made-up due date.
   */
  it('flags a bill created by Move to billing as needing its invoice date and due date, and offers to set them', async () => {
    await setup({
      rowsByTab: { IN_REVIEW: [worklistRow()] },
      bills: [bill({ status: 'IN_REVIEW', datesPending: true, billNumber: null })],
    })
    fireEvent.click(screen.getByRole('tab', { name: /^Expected/ }))

    expect(screen.getAllByText('Needs invoice date').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: /^Add invoice date for bill/ }))
    expect(screen.getByText(/dates dialog for/)).toBeTruthy()
  })

  /** The pay run is worked oldest first, so how late a bill already is has to be on it. */
  it('offers Return to Expected and Move to Selected on an approved bill', async () => {
    await setup()
    fireEvent.click(screen.getByRole('tab', { name: /^Aging(?! by carrier)/ }))

    expect(screen.getByRole('button', { name: 'Move bill BL-7788 to Selected' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Return bill BL-7788 to Expected' })).toBeTruthy()
  })

  describe('Delete bill', () => {
    it('offers Delete on an Expected bill, an Aging bill and a Selected bill', async () => {
      await setup({
        rowsByTab: { IN_REVIEW: [worklistRow()] },
        bills: [
          bill({ id: 'cb:1', status: 'IN_REVIEW', datesPending: true, billNumber: 'IR-9' }),
          bill({ id: 'cb:2', status: 'TO_BE_PAID', billNumber: 'TB-1' }),
          bill({ id: 'cb:3', status: 'TO_BE_PAID', billNumber: 'SEL-3', selectedForPayment: true }),
        ],
      })
      fireEvent.click(screen.getByRole('tab', { name: /^Expected/ }))
      expect(screen.getByRole('button', { name: 'Delete bill IR-9' })).toBeTruthy()
      fireEvent.click(screen.getByRole('tab', { name: /^Aging(?! by carrier)/ }))
      expect(screen.getByRole('button', { name: 'Delete bill TB-1' })).toBeTruthy()
      fireEvent.click(screen.getByRole('tab', { name: /^Selected/ }))
      expect(screen.getByRole('button', { name: 'Delete bill SEL-3' })).toBeTruthy()
    })

    it('needs a reason, sends it with the code, and refreshes after the bill is gone', async () => {
      vi.mocked(deleteBill).mockResolvedValue({ bill: bill({ status: 'VOID' }) })
      await setup()
      fireEvent.click(screen.getByRole('tab', { name: /^Aging(?! by carrier)/ }))
      fireEvent.click(screen.getByRole('button', { name: 'Delete bill BL-7788' }))

      const confirm = screen.getByRole('button', { name: 'Delete bill' }) as HTMLButtonElement
      expect(confirm.disabled).toBe(true)
      fireEvent.change(screen.getByLabelText('Why it is being deleted'), { target: { value: 'DUPLICATE' } })
      expect(confirm.disabled).toBe(false)
      await act(async () => { fireEvent.click(confirm) })
      expect(deleteBill).toHaveBeenCalledWith({ billId: 'cb:lc1:1', reasonCode: 'DUPLICATE' })
    })

    it('asks for details when the reason is Other', async () => {
      vi.mocked(deleteBill).mockResolvedValue({ bill: bill({ status: 'VOID' }) })
      await setup()
      fireEvent.click(screen.getByRole('tab', { name: /^Aging(?! by carrier)/ }))
      fireEvent.click(screen.getByRole('button', { name: 'Delete bill BL-7788' }))
      fireEvent.change(screen.getByLabelText('Why it is being deleted'), { target: { value: 'OTHER' } })
      const confirm = screen.getByRole('button', { name: 'Delete bill' }) as HTMLButtonElement
      expect(confirm.disabled).toBe(true)
      fireEvent.change(screen.getByLabelText('Details'), { target: { value: 'Carrier never moved it' } })
      await act(async () => { fireEvent.click(confirm) })
      expect(deleteBill).toHaveBeenCalledWith({ billId: 'cb:lc1:1', reasonCode: 'OTHER', reason: 'Carrier never moved it' })
    })
  })

  /**
   * The strip is what somebody reads before deciding what to fund. Every figure comes out
   * of `@/lib/arAging` — the page must not reach its own total, or the CSV and the screen
   * would disagree about what we owe.
   */
  it('leads the aging view with the lib\'s own totals', async () => {
    await setup({ rowsByTab: { AWAITING_INVOICE: [worklistRow()] } })
    fireEvent.click(screen.getByRole('tab', { name: /^Aging by carrier/ }))

    const strip = within(screen.getByLabelText('AP totals'))
    // One open bill of $1,500.00, ten days past due.
    expect(within(strip.getByText('Open AP').closest('.tms-kpi-card') as HTMLElement).getByText('$1,500.00')).toBeTruthy()
    expect(within(strip.getByText('Late').closest('.tms-kpi-card') as HTMLElement).getByText('$1,500.00')).toBeTruthy()
    // The delivered assignment no carrier has invoiced, counted off the worklist rows.
    expect(within(strip.getByText('Awaiting invoice').closest('.tms-kpi-card') as HTMLElement).getByText('1 assignment')).toBeTruthy()
    // Nothing has been settled this month, so the lag is unmeasured — not zero.
    expect(within(strip.getByText('Avg days to pay').closest('.tms-kpi-card') as HTMLElement).getByText('—')).toBeTruthy()
  })

  /**
   * Payables is the bills Move to billing created (Ryne 2026-11-12): a carrier leg with no bill yet is
   * still Load review's work, so the board no longer has an Awaiting invoice tab.
   */
  it('has no Awaiting invoice tab and opens on Expected', async () => {
    await setup({ rowsByTab: { AWAITING_INVOICE: [worklistRow()] } })
    expect(screen.queryByRole('tab', { name: /^Awaiting invoice/ })).toBeNull()
    expect(screen.getByRole('tab', { name: /^Expected/ }).getAttribute('aria-selected')).toBe('true')
    expect(screen.queryByRole('button', { name: /^Record bill/ })).toBeNull()
    // The totals strip sits above the tabs on every tab.
    expect(screen.getByRole('region', { name: 'Open payables' })).toBeTruthy()
    expect(screen.getByText('Due next 7 days')).toBeTruthy()
  })

  /** Ryne 2026-11-16: the Payable section has no Needs review tab; its flags ride on the bill rows instead. */
  it('has no Needs review tab, and a Cash requirements tab whose lines add up to the open AP total', async () => {
    const a = bill({ id: 'cb:lc1:1', billNumber: 'BL-1', dueAt: daysAgo(10), balanceCents: 150_000 })
    const b = bill({
      id: 'cb:lc2:1', loadCarrierId: 'lc2', carrierId: 'car2', carrierName: 'Red Line Freight',
      billNumber: 'RL-1', dueAt: '2999-01-01', balanceCents: 80_000, grossCents: 80_000, netCents: 80_000, billedCents: 80_000,
    })
    await setup({ bills: [a, b] })
    expect(screen.queryByRole('tab', { name: /^Needs review/ })).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: /^Cash requirements/ }))
    const table = within(screen.getByRole('table', { name: 'Cash requirements by Friday' }))
    // The 10-days-late bill is on the Past due line, the far-future one under Later, and the total is the open AP.
    expect(table.getByText(/^Past due/).closest('tr')?.textContent).toContain('$1,500.00')
    expect(table.getByText(/^Later/).closest('tr')?.textContent).toContain('$800.00')
    expect(table.getByText('Total open AP').closest('tr')?.textContent).toContain('$2,300.00')
    expect(screen.getByText(/How this is counted/)).toBeTruthy()
  })

  it('puts Mark reviewed on a flagged Expected bill only, and refreshes the flags after it is cleared', async () => {
    needsReviewRows.rows = [{ id: 's1', number: '14433', financeReviewAt: '2026-11-13T20:00:00Z', financeReviewReason: 'Rate differs', financeReviewApNote: null }]
    needsReviewRefresh.mockClear()
    try {
      await setup({ bills: [bill({ status: 'IN_REVIEW', datesPending: true, billNumber: 'BL-9' })] })
      fireEvent.click(screen.getByRole('button', { name: 'Mark bill BL-9 reviewed' }))
      fireEvent.click(screen.getByRole('button', { name: 'confirm clear for s1' }))
      expect(needsReviewRefresh).toHaveBeenCalled()
    } finally { needsReviewRows.rows = [] }
  })

  it('offers no Mark reviewed on an unflagged Expected bill', async () => {
    needsReviewRows.rows = []
    await setup({ bills: [bill({ status: 'IN_REVIEW', datesPending: true, billNumber: 'BL-9' })] })
    expect(screen.queryByRole('button', { name: /reviewed$/ })).toBeNull()
  })

  /** Ryne 2026-11-18: who the load was for and how late the bill is, on the lists the pay run is worked from. */
  describe('Customer and Days past due columns', () => {
    const headers = (name: RegExp) => within(screen.getByRole('table', { name })).getAllByRole('columnheader').map((h) => h.textContent ?? '')

    it('puts both on Expected, with the customer filled and no day count on a bill still waiting for its invoice date', async () => {
      await setup({ bills: [
        bill({ id: 'cb:lc2:1', loadCarrierId: 'lc2', status: 'IN_REVIEW', datesPending: true, billNumber: null, dueAt: daysAgo(40) }),
      ] })
      const hs = headers(/^AP expected/)
      expect(hs.some((h) => /CUSTOMER/.test(h))).toBe(true)
      expect(hs.some((h) => /DAYS PAST DUE/.test(h))).toBe(true)
      const table = within(screen.getByRole('table', { name: /^AP expected/ }))
      expect(table.getByText('Acme Foods')).toBeTruthy()
      expect(table.queryByText(/days late$/)).toBeNull()
    })

    it('puts both on Aging, and the day count matches the Aging chip words: 1 day late is singular', async () => {
      await setup({ bills: [
        bill({ id: 'cb:lc1:1', billNumber: 'BL-1', dueAt: daysAgo(75) }),
        bill({ id: 'cb:lc2:1', loadCarrierId: 'lc2', billNumber: 'BL-2', dueAt: daysAgo(1) }),
        bill({ id: 'cb:lc3:1', loadCarrierId: 'lc3', billNumber: 'BL-3', dueAt: daysAgo(-5) }),
      ] })
      fireEvent.click(screen.getByRole('tab', { name: /^Aging(?! by carrier)/ }))
      const hs = headers(/^AP aging/)
      expect(hs.some((h) => /CUSTOMER/.test(h))).toBe(true)
      expect(hs.some((h) => /DAYS PAST DUE/.test(h))).toBe(true)
      expect(hs.some((h) => /^AGE$/.test(h.trim()))).toBe(false) // one column, not an Age beside Days past due
      const table = within(screen.getByRole('table', { name: /^AP aging/ }))
      expect(table.getByText('75 days late')).toBeTruthy()
      expect(table.getByText('1 day late')).toBeTruthy()
      expect(table.getByText('Due in 5 days')).toBeTruthy() // not yet due: muted text, not a red pill
    })

    it('puts both on Selected', async () => {
      await setup({ bills: [bill({ billNumber: 'BL-1', dueAt: daysAgo(61), selectedForPayment: true })] })
      fireEvent.click(screen.getByRole('tab', { name: /^Selected/ }))
      const hs = headers(/^AP selected/)
      expect(hs.some((h) => /CUSTOMER/.test(h))).toBe(true)
      expect(hs.some((h) => /DAYS PAST DUE/.test(h))).toBe(true)
      expect(hs.some((h) => /^AGE$/.test(h.trim()))).toBe(false)
      expect(within(screen.getByRole('table', { name: /^AP selected/ })).getAllByText('61 days late')).toHaveLength(1) // one pill per bill
    })

    it('names the PO column CUST REF # and fills it with the shipment\'s customer reference', async () => {
      await setup({ bills: [bill({ billNumber: 'BL-1', dueAt: daysAgo(61), selectedForPayment: true })] })
      fireEvent.click(screen.getByRole('tab', { name: /^Selected/ }))
      const hs = headers(/^AP selected/)
      expect(hs.some((h) => /CUST REF #/.test(h))).toBe(true)
      expect(hs.some((h) => /^PO #$/.test(h.trim()))).toBe(false)
      expect(within(screen.getByRole('table', { name: /^AP selected/ })).getByText('PO-77')).toBeTruthy()
      // The search box finds a bill by it.
      fireEvent.change(screen.getByTestId('ap-search'), { target: { value: 'po-77' } })
      expect(within(screen.getByRole('table', { name: /^AP selected/ })).getByText('PO-77')).toBeTruthy()
      fireEvent.change(screen.getByTestId('ap-search'), { target: { value: 'no-such-ref' } })
      expect(within(screen.getByRole('table', { name: /^AP selected/ })).queryByText('PO-77')).toBeNull()
    })

    it('sorts Days past due descending with the most overdue first', async () => {
      await setup({ bills: [
        bill({ id: 'cb:lc1:1', billNumber: 'BL-1', dueAt: daysAgo(5) }),
        bill({ id: 'cb:lc2:1', loadCarrierId: 'lc2', billNumber: 'BL-2', dueAt: daysAgo(66) }),
        bill({ id: 'cb:lc3:1', loadCarrierId: 'lc3', billNumber: 'BL-3', dueAt: daysAgo(30) }),
      ] })
      fireEvent.click(screen.getByRole('tab', { name: /^Aging(?! by carrier)/ }))
      const table = screen.getByRole('table', { name: /^AP aging/ })
      const header = within(table).getByRole('columnheader', { name: /DAYS PAST DUE/ })
      fireEvent.click(within(header).getAllByRole('button')[0]) // asc
      fireEvent.click(within(header).getAllByRole('button')[0]) // desc
      expect(within(table).getAllByText(/^\d+ days late$/).map((n) => n.textContent)).toEqual(['66 days late', '30 days late', '5 days late'])
    })
  })

  it('draws Aging by carrier like the receivables aging: a row per carrier whose twisty opens its bills', async () => {
    const a = bill({ id: 'cb:lc1:1', billNumber: 'BL-1', dueAt: daysAgo(10), balanceCents: 150_000 })
    await setup({ bills: [a] })
    fireEvent.click(screen.getByRole('tab', { name: /^Aging by carrier/ }))
    const row = screen.getByTestId('ap-aging-carrier-row')
    expect(row.textContent).toContain('Blue Line Trucking')
    expect(row.textContent).toContain('$1,500.00')
    expect(screen.queryByTestId('ap-aging-bill-row')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Expand Blue Line Trucking' }))
    expect(screen.getAllByTestId('ap-aging-bill-row')).toHaveLength(1)
    expect(screen.getByTestId('ap-aging-total-row').textContent).toContain('$1,500.00')
  })

  it('numbers the bills of a load that pays two carriers 14598-1 and 14598-2, and leaves a one-carrier load plain', async () => {
    const a = bill({ id: 'cb:lc1:1', billNumber: 'BL-1', dueAt: daysAgo(10) })
    const b = bill({
      id: 'cb:lc2:1', loadCarrierId: 'lc2', carrierId: 'car2', carrierName: 'Red Line Freight',
      billNumber: 'RL-1', dueAt: daysAgo(45), balanceCents: 80_000, grossCents: 80_000, netCents: 80_000, billedCents: 80_000,
    })
    const alone = bill({ id: 'cb:lc9:1', loadCarrierId: 'lc9', loadId: 'l9', shipmentId: 's9', carrierId: 'car9', carrierName: 'Solo Haul', billNumber: 'SH-1' })
    // The second carrier was added second, whatever order the rows arrive in.
    legsMock.mockImplementation(async () => new Map([[
      'l1',
      [assignment({ id: 'lc2', sequence: 2, carrierId: 'car2' }), assignment({ id: 'lc1', sequence: 1 })],
    ]]))
    await setup({ bills: [a, b, alone] })
    fireEvent.click(screen.getByRole('tab', { name: /^Aging(?! by carrier)/ }))
    await waitFor(() => expect(screen.getByRole('link', { name: 'Open PRO S-1001-1' })).toBeTruthy())
    expect(screen.getByRole('link', { name: 'Open PRO S-1001-2' })).toBeTruthy()
    // The load with one carrier keeps its plain PRO.
    expect(screen.getByRole('link', { name: 'Open PRO S-1001' })).toBeTruthy()
    // Only the loads already seen with two carriers are read.
    expect(legsMock).toHaveBeenCalledWith(['l1'])
    // Search finds the leg: the base PRO matches both bills of the load, -2 only the second.
    fireEvent.change(screen.getByTestId('ap-search'), { target: { value: 'S-1001-2' } })
    expect(screen.queryByRole('link', { name: 'Open PRO S-1001-1' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Open PRO S-1001-2' })).toBeTruthy()
  })

  it('pays, ages and shows each carrier bill of one load on its own row', async () => {
    const a = bill({ id: 'cb:lc1:1', billNumber: 'BL-1', dueAt: daysAgo(10), balanceCents: 150_000 })
    const b = bill({
      id: 'cb:lc2:1', loadCarrierId: 'lc2', carrierId: 'car2', carrierName: 'Red Line Freight',
      billNumber: 'RL-1', dueAt: daysAgo(45), balanceCents: 80_000, grossCents: 80_000, netCents: 80_000, billedCents: 80_000,
    })
    await setup({ bills: [a, b] })
    fireEvent.click(screen.getByRole('tab', { name: /^Aging(?! by carrier)/ }))
    expect(screen.getByRole('button', { name: 'Move bill BL-1 to Selected' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Move bill RL-1 to Selected' })).toBeTruthy()
    expect(screen.getAllByText('Shared PRO · 2 carriers')).toHaveLength(2)

    // Aging report: two carriers, two buckets, the shipment is counted once per bill and not twice.
    fireEvent.click(screen.getByRole('tab', { name: /^Aging by carrier/ }))
    const strip = within(screen.getByLabelText('AP totals'))
    expect(within(strip.getByText('Open AP').closest('.tms-kpi-card') as HTMLElement).getByText('$2,300.00')).toBeTruthy()
    expect(screen.getAllByText('Blue Line Trucking').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Red Line Freight').length).toBeGreaterThan(0)
  })

  it('filters by carrier from the URL and shows what that carrier is owed by due date', async () => {
    const a = bill({ id: 'cb:lc1:1', billNumber: 'BL-1', dueAt: daysAgo(10), balanceCents: 150_000 })
    const b = bill({
      id: 'cb:lc2:1', loadCarrierId: 'lc2', carrierId: 'car2', carrierName: 'Red Line Freight',
      billNumber: 'RL-1', dueAt: daysAgo(45), balanceCents: 80_000, grossCents: 80_000, netCents: 80_000, billedCents: 80_000,
    })
    await setup({ bills: [a, b], url: '/?carrier=car2' })
    const owed = within(screen.getByLabelText('Owed by Red Line Freight'))
    expect(owed.getByText('Past due').closest('.tms-list-row')?.querySelector('.tms-list-row-value')?.textContent).toBe('$800.00')
    fireEvent.click(screen.getByRole('tab', { name: /^Aging(?! by carrier)/ }))
    expect(screen.getByRole('button', { name: 'Move bill RL-1 to Selected' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Move bill BL-1 to Selected' })).toBeNull()
  })

  describe('the dense grid', () => {
    const two = () => {
      const a = bill({ id: 'cb:lc1:1', billNumber: 'BL-1', balanceCents: 150_000 })
      const b = bill({
        id: 'cb:lc2:1', loadCarrierId: 'lc2', carrierId: 'car2', carrierName: 'Red Line Freight',
        billNumber: 'RL-1', balanceCents: 80_000, grossCents: 80_000, netCents: 80_000, billedCents: 80_000,
      })
      return [a, b]
    }
    const order = () => within(screen.getByRole('table', { name: /^AP aging/ })).getAllByRole('row')
      .map((r) => r.textContent ?? '').filter((t) => /Blue Line|Red Line/.test(t)).map((t) => (t.includes('Red Line') ? 'RL-1' : 'BL-1'))

    it('draws every view as the shared dense table with the Columns, density and summary controls', async () => {
      await setup({ bills: two() })
      fireEvent.click(screen.getByRole('tab', { name: /^Aging(?! by carrier)/ }))
      expect(screen.getByRole('table', { name: /^AP aging/ })).toBeTruthy()
      expect(screen.getByRole('button', { name: /Columns/ })).toBeTruthy()
      expect(screen.getByRole('button', { name: /Summary/ })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Filter CARRIER' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy()
      expect(screen.getByTestId('ap-count').textContent).toBe('2 items')
    })

    it('sorts a money column by its cents when the header is clicked', async () => {
      await setup({ bills: two() })
      fireEvent.click(screen.getByRole('tab', { name: /^Aging(?! by carrier)/ }))
      const header = within(screen.getByRole('table', { name: /^AP aging/ })).getByRole('columnheader', { name: /AMOUNT/ })
      fireEvent.click(within(header).getAllByRole('button')[0])
      expect(order()).toEqual(['RL-1', 'BL-1'])
      fireEvent.click(within(header).getAllByRole('button')[0])
      expect(order()).toEqual(['BL-1', 'RL-1'])
    })

    it('puts ticked approved bills on the pay run from the Aging tab, any number of carriers', async () => {
      await setup({ bills: two() })
      fireEvent.click(screen.getByRole('tab', { name: /^Aging(?! by carrier)/ }))
      expect((screen.getByRole('button', { name: 'Move to Selected' }) as HTMLButtonElement).disabled).toBe(true)
      fireEvent.click(screen.getByLabelText('Select bill BL-1'))
      expect(screen.getByText('1 selected ($1,500.00)')).toBeTruthy()
      fireEvent.click(screen.getByLabelText('Select bill RL-1'))
      expect(screen.getByText('2 selected ($2,300.00)')).toBeTruthy()
      expect((screen.getByRole('button', { name: 'Move to Selected' }) as HTMLButtonElement).disabled).toBe(false)
    })

    describe('select all', () => {
      const header = () => screen.getByLabelText(/^Select all \d+ bills shown$/) as HTMLInputElement

      it('ticks every bill that can be selected, skips one still in review, and clears them again', async () => {
        await setup({ bills: [...two(), bill({ id: 'cb:lc3:1', loadCarrierId: 'lc3', status: 'IN_REVIEW', billNumber: 'IR-1' })] })
        fireEvent.click(screen.getByRole('tab', { name: /^Aging(?! by carrier)/ }))
        expect(header().getAttribute('aria-label')).toBe('Select all 2 bills shown')
        fireEvent.click(header())
        expect(screen.getByText('2 selected ($2,300.00)')).toBeTruthy()
        expect((screen.getByLabelText('Select bill BL-1') as HTMLInputElement).checked).toBe(true)
        expect(header().checked).toBe(true)
        fireEvent.click(header())
        expect(screen.getByText('0 selected ($0.00)')).toBeTruthy()
        expect((screen.getByLabelText('Select bill BL-1') as HTMLInputElement).checked).toBe(false)
      })

      it('shows a partly ticked list as indeterminate and completes it on click', async () => {
        await setup({ bills: two() })
        fireEvent.click(screen.getByRole('tab', { name: /^Aging(?! by carrier)/ }))
        fireEvent.click(screen.getByLabelText('Select bill BL-1'))
        expect(header().indeterminate).toBe(true)
        expect(header().checked).toBe(false)
        fireEvent.click(header())
        expect(screen.getByText('2 selected ($2,300.00)')).toBeTruthy()
        expect(header().indeterminate).toBe(false)
      })

      it('ticks only the bills the search leaves on screen', async () => {
        await setup({ bills: two() })
        fireEvent.click(screen.getByRole('tab', { name: /^Aging(?! by carrier)/ }))
        fireEvent.change(screen.getByTestId('ap-search'), { target: { value: 'Red Line' } })
        expect(header().getAttribute('aria-label')).toBe('Select all 1 bills shown')
        fireEvent.click(header())
        expect(screen.getByText('1 selected ($800.00)')).toBeTruthy()
        fireEvent.change(screen.getByTestId('ap-search'), { target: { value: '' } })
        expect((screen.getByLabelText('Select bill BL-1') as HTMLInputElement).checked).toBe(false)
        expect((screen.getByLabelText('Select bill RL-1') as HTMLInputElement).checked).toBe(true)
      })

      it('keeps the one-carrier warning and the disabled Pay selected when the selection spans two carriers', async () => {
        await setup({ bills: two().map((b) => ({ ...b, selectedForPayment: true })) })
        fireEvent.click(screen.getByRole('tab', { name: /^Selected/ }))
        fireEvent.click(header())
        expect(screen.getByText(/One payment covers one carrier/)).toBeTruthy()
        expect((screen.getByRole('button', { name: 'Record payment for selected bills' }) as HTMLButtonElement).disabled).toBe(true)
      })
    })

    it('does not let a bill still in review be ticked for payment', async () => {
      await setup({ bills: [bill({ status: 'IN_REVIEW', billNumber: 'IR-1' })] })
      fireEvent.click(screen.getByRole('tab', { name: /^Aging(?! by carrier)/ }))
      expect((screen.getByLabelText(/Bill IR-1 must be approved/) as HTMLInputElement).disabled).toBe(true)
    })

    it('pays a selection of one carrier from the Selected tab, and says when it spans two', async () => {
      await setup({ bills: two().map((b) => ({ ...b, selectedForPayment: true })) })
      fireEvent.click(screen.getByRole('tab', { name: /^Selected/ }))
      expect((screen.getByRole('button', { name: 'Record payment for selected bills' }) as HTMLButtonElement).disabled).toBe(true)
      fireEvent.click(screen.getByLabelText('Select bill BL-1'))
      expect((screen.getByRole('button', { name: 'Record payment for selected bills' }) as HTMLButtonElement).disabled).toBe(false)
      fireEvent.click(screen.getByLabelText('Select bill RL-1'))
      expect(screen.getByText(/One payment covers one carrier/)).toBeTruthy()
      expect((screen.getByRole('button', { name: 'Record payment for selected bills' }) as HTMLButtonElement).disabled).toBe(true)
    })

    it('shows a payment info link, the pay-to and the remittance e-mail on every row', async () => {
      await setup({ bills: [bill({ billNumber: 'BL-1', selectedForPayment: true, payeeKind: 'FACTOR', remitTo: { name: 'Blue Line', factorName: 'Triumph', payeeEmail: 'ap@triumph.test' } })] })
      fireEvent.click(screen.getByRole('tab', { name: /^Selected/ }))
      expect(screen.getByText('Triumph')).toBeTruthy()
      expect(screen.getByText('ap@triumph.test')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Payment info for bill BL-1' })).toBeTruthy()
    })

    it('puts the factor in Pay to for a factored carrier whose bill froze no payee, and keeps the carrier in Carrier', async () => {
      vi.mocked(listCarrierPaymentInfo).mockResolvedValue([
        { id: 'pmF', carrierId: 'car1', recipientType: 'FACTOR', factorName: 'Triumph Capital', payeeEmail: 'ap@triumph.test', isPreferred: true, status: 'ACTIVE' },
        { id: 'pmD', carrierId: 'car2', recipientType: 'CARRIER', bankName: 'Chase Bank', accountLast4: '9545', isPreferred: true, status: 'ACTIVE' },
      ] as never)
      try {
        await setup({ bills: [
          bill({ id: 'b-f', billNumber: 'BL-1', selectedForPayment: true, payeeKind: 'CARRIER', remitTo: null }),
          bill({ id: 'b-d', billNumber: 'AH-1', selectedForPayment: true, carrierId: 'car2', carrierName: 'Arctic Horizon Inc', payeeKind: 'CARRIER', remitTo: null }),
        ] })
        fireEvent.click(screen.getByRole('tab', { name: /^Selected/ }))
        const factored = screen.getByLabelText('Select bill BL-1').closest('tr') as HTMLElement
        expect(within(factored).getByText('Blue Line Trucking')).toBeTruthy()
        expect(within(factored).getByText('Triumph Capital')).toBeTruthy()
        const direct = screen.getByLabelText('Select bill AH-1').closest('tr') as HTMLElement
        expect(within(direct).getAllByText('Arctic Horizon Inc').length).toBe(2)
        expect(within(direct).queryByText('Triumph Capital')).toBeNull()
      } finally {
        vi.mocked(listCarrierPaymentInfo).mockResolvedValue([])
      }
    })

    describe('export', () => {
      beforeEach(() => { downloadCsvMock.mockClear() })

      it('is off while nothing is on the Selected tab', async () => {
        await setup({ bills: two() })
        fireEvent.click(screen.getByRole('tab', { name: /^Selected/ }))
        expect((screen.getByRole('button', { name: 'Export all selected payables' }) as HTMLButtonElement).disabled).toBe(true)
        expect(screen.queryByRole('button', { name: 'Export the selected payables showing' })).toBeNull()
      })

      it('is not on the Aging tab', async () => {
        await setup({ bills: two() })
        fireEvent.click(screen.getByRole('tab', { name: /^Aging(?! by carrier)/ }))
        expect(screen.queryByRole('button', { name: 'Export all selected payables' })).toBeNull()
      })

      it('saves every bill on the tab with a total per payee, whether or not it is ticked', async () => {
        await setup({ bills: two().map((b) => ({ ...b, selectedForPayment: true })) })
        fireEvent.click(screen.getByRole('tab', { name: /^Selected/ }))
        fireEvent.click(screen.getByLabelText('Select bill BL-1'))
        fireEvent.click(screen.getByRole('button', { name: 'Export all selected payables' }))
        expect(downloadCsvMock).toHaveBeenCalledTimes(1)
        const [name, csv] = downloadCsvMock.mock.calls[0] as [string, string]
        expect(name).toBe(`selected-payables-${TODAY}.csv`)
        expect(csv).toContain('BL-1')
        expect(csv).toContain('RL-1')
        expect(csv).toContain('Acme Foods')
        expect(csv).toContain('PAY RUN TOTALS BY PAYEE')
        expect(csv).toContain('GRAND TOTAL,2,2300.00,1,1500.00')
      })

      it('offers the filtered list too once a page filter narrows the tab', async () => {
        await setup({ bills: two().map((b) => ({ ...b, selectedForPayment: true })) })
        fireEvent.click(screen.getByRole('tab', { name: /^Selected/ }))
        fireEvent.click(screen.getByRole('button', { name: /Carrier is/ }))
        fireEvent.change(screen.getByLabelText('Filter carrier'), { target: { value: 'car2' } })
        fireEvent.click(screen.getByRole('button', { name: 'Export the selected payables showing' }))
        let csv = (downloadCsvMock.mock.calls[0] as [string, string])[1]
        expect(csv).toContain('RL-1')
        expect(csv).not.toContain('BL-1')
        fireEvent.click(screen.getByRole('button', { name: 'Export all selected payables' }))
        csv = (downloadCsvMock.mock.calls[1] as [string, string])[1]
        expect(csv).toContain('BL-1')
        expect(csv).toContain('RL-1')
      })
    })

    it('shows the summary strip figures in cents-exact dollars when opened', async () => {
      await setup({ bills: two() })
      fireEvent.click(screen.getByRole('tab', { name: /^Aging(?! by carrier)/ }))
      expect(screen.queryByRole('region', { name: 'Summary' })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: /Summary/ }))
      const strip = within(screen.getByRole('region', { name: 'Summary' }))
      expect(strip.getAllByText('$2,300.00').length).toBeGreaterThan(0)
      expect(strip.getByText('Aging').closest('.tms-kpi-card')?.querySelector('.tms-kpi-card-value')?.textContent).toBe('2')
    })
  })
})

describe('the Paid tab', () => {
  it('lists every payment ever, files each under the month it was paid, and names an imported bill by its PRO', async () => {
    const apiClient = await import('@/lib/apiClient')
    const paidThisMonth = bill({
      id: 'cb:lcr-abcc:1', status: 'PAID', billNumber: '14525', shipmentNumber: '14525', balanceCents: 0, paidCents: 95_000, netCents: 95_000,
      billDate: '2026-10-02', billMonth: '2026-10', paidAt: `${TODAY}T21:40:14.191Z`, carrierName: 'Matt Hennings Trucki',
    })
    const importedOld = bill({
      id: 'cb:lcr-aljex25-14375:1', status: 'PAID', billNumber: null, shipmentNumber: '14375', balanceCents: 0, paidCents: 12_500, netCents: 12_500,
      billDate: '2025-06-01', billMonth: '2025-06', paidAt: '2025-06-05T12:00:00.000Z', carrierName: 'Mmbest Transportation Inc',
    })
    // The bills come back month by month, the way the billMonth index returns them.
    vi.mocked(apiClient.listBillsByMonth).mockImplementation(async (month: string) => (
      [paidThisMonth, importedOld].filter((b) => b.billMonth === month)
    ))
    await setup({ bills: [] })
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /^Paid/ })) })
    // All time is the default: the October-dated bill paid today and the 2025 payment both show.
    await waitFor(() => expect(screen.getByText('Matt Hennings Trucki')).toBeTruthy())
    expect(screen.getByText('Mmbest Transportation Inc')).toBeTruthy()
    expect(screen.getByText('PRO 14375')).toBeTruthy()
    expect(screen.queryByText('cb:lcr-aljex25-14375:1')).toBeNull()
    // Picking the month it was paid in keeps only that month's payments.
    const picker = screen.getByLabelText('Paid month') as HTMLSelectElement
    expect([...picker.options].map((o) => o.value)).toEqual(['', TODAY.slice(0, 7), '2025-06'])
    await act(async () => { fireEvent.change(picker, { target: { value: TODAY.slice(0, 7) } }) })
    expect(screen.getByText('Matt Hennings Trucki')).toBeTruthy()
    expect(screen.queryByText('Mmbest Transportation Inc')).toBeNull()
  })

  it('hides bills paid outside BCAT Ops (archived) and shows them again only to an admin who asks (Ryne 2026-11-18)', async () => {
    const apiClient = await import('@/lib/apiClient')
    const live = bill({
      id: 'cb:live:1', status: 'PAID', billNumber: '14525', shipmentNumber: '14525', balanceCents: 0, paidCents: 95_000, netCents: 95_000,
      billDate: '2026-10-02', billMonth: '2026-10', paidAt: `${TODAY}T21:40:14.191Z`, carrierName: 'Matt Hennings Trucki',
    })
    const archived = bill({
      id: 'cb:old:1', status: 'PAID', billNumber: null, shipmentNumber: '9001', balanceCents: 0, paidCents: 50_000, netCents: 50_000,
      billDate: '2025-06-01', billMonth: '2025-06', paidAt: '2025-06-05T12:00:00.000Z', carrierName: 'Old Outside Carrier',
      archivedAt: '2026-11-18T23:00:00.000Z', archivedReason: 'Paid outside BCAT Ops (on or before 2026-11-12)',
    })
    vi.mocked(apiClient.listBillsByMonth).mockImplementation(async (month: string) => [live, archived].filter((b) => b.billMonth === month))
    authState.isAdmin = false
    try {
      await setup({ bills: [] })
      await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /^Paid/ })) })
      await waitFor(() => expect(screen.getByText('Matt Hennings Trucki')).toBeTruthy())
      expect(screen.queryByText('Old Outside Carrier')).toBeNull()
      // A non-admin never sees the toggle.
      expect(screen.queryByLabelText(/Include archived/)).toBeNull()
    } finally {
      authState.isAdmin = false
    }
    cleanup()
    authState.isAdmin = true
    try {
      await setup({ bills: [] })
      await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /^Paid/ })) })
      await waitFor(() => expect(screen.getByText('Matt Hennings Trucki')).toBeTruthy())
      expect(screen.queryByText('Old Outside Carrier')).toBeNull()
      const toggle = await screen.findByLabelText(/Include archived \(1\)/)
      await act(async () => { fireEvent.click(toggle) })
      expect(screen.getByText('Old Outside Carrier')).toBeTruthy()
    } finally {
      authState.isAdmin = false
    }
  })
})



describe('Pay-to needed: bills whose carrier has nowhere to send money (Ryne 2026-11-18)', () => {
  // Carrier car1 has a method on file; car9 (Landstar) has none, so its bills have no payee to resolve.
  const methods = [{ id: 'pm1', carrierId: 'car1', recipientType: 'CARRIER', bankName: 'Chase Bank', accountLast4: '9545', isPreferred: true, status: 'ACTIVE' }]
  const mixed = () => [
    bill({ id: 'ok', billNumber: 'OK-1', selectedForPayment: true, remitTo: null }),
    bill({ id: 'bad', billNumber: 'LS-1', selectedForPayment: true, carrierId: 'car9', carrierName: 'Landstar Ranger', remitTo: null, balanceCents: 130_000 }),
  ]

  it('flags the bill in the PAY TO column, banners the count and the money waiting, and filters to it', async () => {
    vi.mocked(listCarrierPaymentInfo).mockResolvedValue(methods as never)
    try {
      await setup({ bills: mixed() })
      expect((await screen.findByTestId('payto-banner')).textContent).toBe('1 payee needs a pay-to · $1,300.00 waiting')
      fireEvent.click(screen.getByRole('tab', { name: /^Selected/ }))
      const bad = screen.getByLabelText('Select bill LS-1').closest('tr') as HTMLElement
      expect(within(bad).getByRole('button', { name: /Pay-to needed for Landstar Ranger/ })).toBeTruthy()
      const ok = screen.getByLabelText('Select bill OK-1').closest('tr') as HTMLElement
      expect(within(ok).queryByText('Pay-to needed')).toBeNull()

      fireEvent.click(screen.getByRole('button', { name: /Pay-to needed \(1\)/ }))
      expect(screen.queryByLabelText('Select bill OK-1')).toBeNull()
      expect(screen.getByLabelText('Select bill LS-1')).toBeTruthy()
    } finally {
      vi.mocked(listCarrierPaymentInfo).mockResolvedValue([])
    }
  })

  it('opens the pay-to editor for that carrier from the flag, and the worklist from the banner', async () => {
    vi.mocked(listCarrierPaymentInfo).mockResolvedValue(methods as never)
    try {
      await setup({ bills: mixed() })
      fireEvent.click(await screen.findByTestId('payto-banner'))
      expect(await screen.findByRole('table', { name: 'Payees that need a pay-to' })).toBeTruthy()
      expect(screen.getByText('Landstar Ranger')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Add pay-to for Landstar Ranger' }))
      expect(await screen.findByText('pay-to editor for Landstar Ranger')).toBeTruthy()
    } finally {
      vi.mocked(listCarrierPaymentInfo).mockResolvedValue([])
    }
  })

  it('shows no flag and no banner while the payment methods have not loaded, or when every payee resolves', async () => {
    await setup({ bills: mixed() })
    expect(screen.queryByTestId('payto-banner')).toBeNull()
    vi.mocked(listCarrierPaymentInfo).mockResolvedValue([...methods, { ...methods[0], id: 'pm9', carrierId: 'car9' }] as never)
    try {
      await setup({ bills: mixed() })
      expect(screen.queryByTestId('payto-banner')).toBeNull()
    } finally {
      vi.mocked(listCarrierPaymentInfo).mockResolvedValue([])
    }
  })
})
