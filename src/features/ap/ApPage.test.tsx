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
import { render, screen, fireEvent, within, act } from '@testing-library/react'
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

async function setup(options: { rowsByTab?: Partial<Record<string, ApWorklistRow[]>>; bills?: CarrierBillRecord[] } = {}) {
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
  await act(async () => { view = render(<MemoryRouter><ApPage /></MemoryRouter>) })
  return view
}

beforeEach(() => vi.clearAllMocks())

describe('the AP board', () => {
  it('offers every view of the money, and each one renders', async () => {
    await setup({ rowsByTab: { AWAITING_INVOICE: [worklistRow()] } })
    for (const label of ['Awaiting invoice', 'In review', 'To be paid', 'Paid', 'Payments & credits', 'Aging', 'AP inbox']) {
      const tab = screen.getByRole('tab', { name: new RegExp(`^${label}`) })
      fireEvent.click(tab)
      expect(tab.getAttribute('aria-selected')).toBe('true')
    }
    // The last click landed on the AP inbox, whose empty queue says so; Aging's body is the strip.
    expect(screen.getByText(/Invoice e-mails the AP inbox finds/)).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: /^Aging/ }))
    expect(screen.getByLabelText('AP totals')).toBeTruthy()
  })

  /**
   * A bill that does not match its own lines cannot be approved at all. Showing the
   * variance beside the Approve button is how somebody knows to fix the lines instead of
   * opening the dialog to be refused.
   */
  it('shows the variance on a bill whose carrier invoice disagrees with the lines', async () => {
    await setup({
      rowsByTab: { IN_REVIEW: [worklistRow()] },
      bills: [bill({ status: 'IN_REVIEW', billedCents: 175_000, varianceCents: 25_000 })],
    })
    fireEvent.click(screen.getByRole('tab', { name: /^In review/ }))

    expect(screen.getByText('$250.00 variance')).toBeTruthy()
    expect(screen.getByText(/fix the lines or void the bill/)).toBeTruthy()
  })

  /** The pay run is worked oldest first, so how late a bill already is has to be on it. */
  it('ages an approved bill on the row that pays it', async () => {
    await setup()
    fireEvent.click(screen.getByRole('tab', { name: /^To be paid/ }))

    expect(screen.getByText('10 days late')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Pay bill BL-7788' })).toBeTruthy()
  })

  /**
   * The strip is what somebody reads before deciding what to fund. Every figure comes out
   * of `@/lib/arAging` — the page must not reach its own total, or the CSV and the screen
   * would disagree about what we owe.
   */
  it('leads the aging view with the lib\'s own totals', async () => {
    await setup({ rowsByTab: { AWAITING_INVOICE: [worklistRow()] } })
    fireEvent.click(screen.getByRole('tab', { name: /^Aging/ }))

    const strip = within(screen.getByLabelText('AP totals'))
    // One open bill of $1,500.00, ten days past due.
    expect(within(strip.getByText('Open AP').closest('.tms-kpi-card') as HTMLElement).getByText('$1,500.00')).toBeTruthy()
    expect(within(strip.getByText('Late').closest('.tms-kpi-card') as HTMLElement).getByText('$1,500.00')).toBeTruthy()
    // The delivered assignment no carrier has invoiced, counted off the worklist rows.
    expect(within(strip.getByText('Awaiting invoice').closest('.tms-kpi-card') as HTMLElement).getByText('1 assignment')).toBeTruthy()
    // Nothing has been settled this month, so the lag is unmeasured — not zero.
    expect(within(strip.getByText('Avg days to pay').closest('.tms-kpi-card') as HTMLElement).getByText('—')).toBeTruthy()
  })

  it('offers to record a bill against an assignment nobody has invoiced', async () => {
    await setup({ rowsByTab: { AWAITING_INVOICE: [worklistRow()] } })

    expect(screen.getByRole('button', { name: 'Record bill for S-1001' })).toBeTruthy()
    expect(screen.getByText('$1,500.00')).toBeTruthy()
  })

  /**
   * An own-fleet leg is paid through the driver's settlement. A Record button here would
   * raise a carrier bill for freight the driver is already being paid for.
   */
  it('refuses to bill an own-fleet leg and points at driver pay instead', async () => {
    await setup({
      rowsByTab: {
        AWAITING_INVOICE: [worklistRow({
          assignment: assignment({ kind: 'OWN_ASSET', driverName: 'Ivan P.', carrierName: null }),
        })],
      },
    })

    expect(screen.getByText(/Settled through driver pay/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Record bill/ })).toBeNull()
  })

  /**
   * One bill per carrier per load: a two-carrier load is two awaiting rows on one PRO. Each
   * carries its own Record action (named for its carrier), and the single-carrier row beside
   * them wears no chip.
   */
  it('lists a two-carrier load as two awaiting rows, each with its own Record bill', async () => {
    const second = worklistRow({
      assignment: assignment({ id: 'lc2', carrierId: 'car2', carrierName: 'Red Line Freight', costCents: 80_000 }),
      loadCarrierId: 'lc2', carrierId: 'car2', carrierName: 'Red Line Freight', costCents: 80_000,
    })
    const solo = worklistRow({
      assignment: assignment({ id: 'lc9', loadId: 'l9', shipmentId: 's9', carrierName: 'Solo Haul' }),
      loadCarrierId: 'lc9', loadId: 'l9', shipmentId: 's9', shipmentNumber: 'S-2002', carrierName: 'Solo Haul',
    })
    await setup({ rowsByTab: { AWAITING_INVOICE: [worklistRow(), second, solo] }, bills: [] })

    expect(screen.getAllByText('Shared PRO · 2 carriers')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Record bill for S-1001 — Blue Line Trucking' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Record bill for S-1001 — Red Line Freight' })).toBeTruthy()
    // Byte-identical for a single-carrier load: same label, no chip.
    expect(screen.getByRole('button', { name: 'Record bill for S-2002' })).toBeTruthy()
  })

  it('pays, ages and shows each carrier bill of one load on its own row', async () => {
    const a = bill({ id: 'cb:lc1:1', billNumber: 'BL-1', dueAt: daysAgo(10), balanceCents: 150_000 })
    const b = bill({
      id: 'cb:lc2:1', loadCarrierId: 'lc2', carrierId: 'car2', carrierName: 'Red Line Freight',
      billNumber: 'RL-1', dueAt: daysAgo(45), balanceCents: 80_000, grossCents: 80_000, netCents: 80_000, billedCents: 80_000,
    })
    await setup({ bills: [a, b] })
    fireEvent.click(screen.getByRole('tab', { name: /^To be paid/ }))
    expect(screen.getByRole('button', { name: 'Pay bill BL-1' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Pay bill RL-1' })).toBeTruthy()
    expect(screen.getAllByText('Shared PRO · 2 carriers')).toHaveLength(2)

    // Aging: two carriers, two buckets, the shipment is counted once per bill and not twice.
    fireEvent.click(screen.getByRole('tab', { name: /^Aging/ }))
    const strip = within(screen.getByLabelText('AP totals'))
    expect(within(strip.getByText('Open AP').closest('.tms-kpi-card') as HTMLElement).getByText('$2,300.00')).toBeTruthy()
    expect(screen.getByText('Blue Line Trucking')).toBeTruthy()
    expect(screen.getByText('Red Line Freight')).toBeTruthy()
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
    const order = () => within(screen.getByRole('table', { name: 'AP to-pay' })).getAllByRole('row')
      .map((r) => r.textContent ?? '').filter((t) => /BL-1|RL-1/.test(t)).map((t) => (t.includes('BL-1') ? 'BL-1' : 'RL-1'))

    it('draws every view as the shared dense table with the Columns, density and summary controls', async () => {
      await setup({ bills: two() })
      fireEvent.click(screen.getByRole('tab', { name: /^To be paid/ }))
      expect(screen.getByRole('table', { name: 'AP to-pay' })).toBeTruthy()
      expect(screen.getByRole('button', { name: /Columns/ })).toBeTruthy()
      expect(screen.getByRole('button', { name: /Summary/ })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Filter CARRIER' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy()
      expect(screen.getByTestId('ap-count').textContent).toBe('2 items')
    })

    it('sorts a money column by its cents when the header is clicked', async () => {
      await setup({ bills: two() })
      fireEvent.click(screen.getByRole('tab', { name: /^To be paid/ }))
      const header = within(screen.getByRole('table', { name: 'AP to-pay' })).getByRole('columnheader', { name: /BALANCE/ })
      fireEvent.click(within(header).getAllByRole('button')[0])
      expect(order()).toEqual(['RL-1', 'BL-1'])
      fireEvent.click(within(header).getAllByRole('button')[0])
      expect(order()).toEqual(['BL-1', 'RL-1'])
    })

    it('still pays a selection of one carrier from the grid checkboxes', async () => {
      await setup({ bills: two() })
      fireEvent.click(screen.getByRole('tab', { name: /^To be paid/ }))
      expect((screen.getByRole('button', { name: 'Pay selected bills' }) as HTMLButtonElement).disabled).toBe(true)
      fireEvent.click(screen.getByLabelText('Select bill BL-1'))
      expect(screen.getByText('1 selected ($1,500.00)')).toBeTruthy()
      expect((screen.getByRole('button', { name: 'Pay selected bills' }) as HTMLButtonElement).disabled).toBe(false)
      fireEvent.click(screen.getByLabelText('Select bill RL-1'))
      expect(screen.getByText(/One payment covers one carrier/)).toBeTruthy()
      expect((screen.getByRole('button', { name: 'Pay selected bills' }) as HTMLButtonElement).disabled).toBe(true)
    })

    it('shows the summary strip figures in cents-exact dollars when opened', async () => {
      await setup({ bills: two() })
      fireEvent.click(screen.getByRole('tab', { name: /^To be paid/ }))
      expect(screen.queryByRole('region', { name: 'Summary' })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: /Summary/ }))
      const strip = within(screen.getByRole('region', { name: 'Summary' }))
      expect(strip.getAllByText('$2,300.00').length).toBeGreaterThan(0)
      expect(strip.getByText('Bills to pay').previousElementSibling?.textContent).toBe('2')
    })
  })
})
