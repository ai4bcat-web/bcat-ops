// @vitest-environment jsdom
/**
 * The AP desk's job is to be believed about money going out.
 *
 * Four of these five assertions are about honesty rather than layout: a bill whose amount
 * disagrees with its lines wears that variance where the approve button is; an approved
 * bill says how late it already is; the strip's figures are `@/lib/arAging`'s, not a
 * second arithmetic written in the page; and an assignment nobody has billed offers the
 * one action that can move it. The fifth pins the six tabs, because the page is the only
 * route to five of them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ApWorklistRow } from '@/hooks/useApWorklist'
import type { CarrierBillRecord, LoadCarrierRecord, ShipmentRecord } from '@/types/tms'
import { ageOpenItems } from '@/lib/arAging'
import { chicagoDateStr } from '@/lib/date'
import { ApPage } from './ApPage'

const worklistMock = vi.hoisted(() => vi.fn())
const openBillsMock = vi.hoisted(() => vi.fn())
const carrierApMock = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/useApWorklist', () => ({ useApWorklist: worklistMock }))
vi.mock('@/hooks/useOpenBills', () => ({ useOpenBills: openBillsMock }))
vi.mock('@/hooks/useCarrierAp', () => ({ useCarrierAp: carrierApMock }))
vi.mock('@/hooks/useCarriers', () => ({
  useCarriers: () => ({ carriers: [], loading: false, error: null, refresh: vi.fn(), replace: vi.fn() }),
}))
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ isAdmin: false, isOwner: false, hasPageAccess: () => true }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))
vi.mock('@/lib/apiClient', () => ({
  graphqlErrorText: (e: unknown) => String(e),
  getTmsSettings: vi.fn().mockResolvedValue({ apRequireSignedRateCon: true }),
  listBillsByMonth: vi.fn().mockResolvedValue([]),
  voidBill: vi.fn(),
  unapproveBill: vi.fn(),
  reverseApPayment: vi.fn(),
}))
// The dialogs fetch their own context and have their own tests; here they would only drag
// the finance Lambda into a test about the board.
vi.mock('./components/RecordBillDialog', () => ({ RecordBillDialog: () => null }))
vi.mock('./components/ApproveBillDialog', () => ({ ApproveBillDialog: () => null }))
vi.mock('./components/UpdateCarrierChargesDialog', () => ({ UpdateCarrierChargesDialog: () => null }))
vi.mock('./components/PayCarrierDialog', () => ({ PayCarrierDialog: () => null }))
vi.mock('./components/ApCreditDialog', () => ({ ApCreditDialog: () => null }))
vi.mock('./components/SendRemittanceDialog', () => ({ SendRemittanceDialog: () => null }))

/** Dates are relative to the day the suite runs, so no clock makes this flaky. */
const TODAY = chicagoDateStr(new Date())
const daysAgo = (days: number) => chicagoDateStr(new Date(Date.now() - days * 86_400_000))

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

function setup(options: { rowsByTab?: Partial<Record<string, ApWorklistRow[]>>; bills?: CarrierBillRecord[] } = {}) {
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
  return render(<MemoryRouter><ApPage /></MemoryRouter>)
}

beforeEach(() => vi.clearAllMocks())

describe('the AP board', () => {
  it('offers every view of the money, and each one renders', () => {
    setup({ rowsByTab: { AWAITING_INVOICE: [worklistRow()] } })
    for (const label of ['Awaiting invoice', 'In review', 'To be paid', 'Paid', 'Payments & credits', 'Aging']) {
      const tab = screen.getByRole('tab', { name: new RegExp(`^${label}`) })
      fireEvent.click(tab)
      expect(tab.getAttribute('aria-selected')).toBe('true')
    }
    // The last click landed on Aging, whose body is the strip.
    expect(screen.getByLabelText('AP totals')).toBeTruthy()
  })

  /**
   * A bill that does not match its own lines cannot be approved at all. Showing the
   * variance beside the Approve button is how somebody knows to fix the lines instead of
   * opening the dialog to be refused.
   */
  it('shows the variance on a bill whose carrier invoice disagrees with the lines', () => {
    setup({
      rowsByTab: { IN_REVIEW: [worklistRow()] },
      bills: [bill({ status: 'IN_REVIEW', billedCents: 175_000, varianceCents: 25_000 })],
    })
    fireEvent.click(screen.getByRole('tab', { name: /^In review/ }))

    expect(screen.getByText('$250.00 variance')).toBeTruthy()
    expect(screen.getByText(/fix the lines or void the bill/)).toBeTruthy()
  })

  /** The pay run is worked oldest first, so how late a bill already is has to be on it. */
  it('ages an approved bill on the row that pays it', () => {
    setup()
    fireEvent.click(screen.getByRole('tab', { name: /^To be paid/ }))

    expect(screen.getByText('10 days late')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Pay bill BL-7788' })).toBeTruthy()
  })

  /**
   * The strip is what somebody reads before deciding what to fund. Every figure comes out
   * of `@/lib/arAging` — the page must not reach its own total, or the CSV and the screen
   * would disagree about what we owe.
   */
  it('leads the aging view with the lib\'s own totals', () => {
    setup({ rowsByTab: { AWAITING_INVOICE: [worklistRow()] } })
    fireEvent.click(screen.getByRole('tab', { name: /^Aging/ }))

    const strip = within(screen.getByLabelText('AP totals'))
    // One open bill of $1,500.00, ten days past due.
    expect(within(strip.getByText('Open AP').closest('div') as HTMLElement).getByText('$1,500.00')).toBeTruthy()
    expect(within(strip.getByText('Late').closest('div') as HTMLElement).getByText('$1,500.00')).toBeTruthy()
    // The delivered assignment no carrier has invoiced, counted off the worklist rows.
    expect(within(strip.getByText('Awaiting invoice').closest('div') as HTMLElement).getByText('1 assignment')).toBeTruthy()
    // Nothing has been settled this month, so the lag is unmeasured — not zero.
    expect(within(strip.getByText('Avg days to pay').closest('div') as HTMLElement).getByText('—')).toBeTruthy()
  })

  it('offers to record a bill against an assignment nobody has invoiced', () => {
    setup({ rowsByTab: { AWAITING_INVOICE: [worklistRow()] } })

    expect(screen.getByRole('button', { name: 'Record bill for S-1001' })).toBeTruthy()
    expect(screen.getByText('$1,500.00')).toBeTruthy()
  })

  /**
   * An own-fleet leg is paid through the driver's settlement. A Record button here would
   * raise a carrier bill for freight the driver is already being paid for.
   */
  it('refuses to bill an own-fleet leg and points at driver pay instead', () => {
    setup({
      rowsByTab: {
        AWAITING_INVOICE: [worklistRow({
          assignment: assignment({ kind: 'OWN_ASSET', driverName: 'Ivan P.', carrierName: null }),
        })],
      },
    })

    expect(screen.getByText(/Settled through driver pay/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Record bill/ })).toBeNull()
  })
})
