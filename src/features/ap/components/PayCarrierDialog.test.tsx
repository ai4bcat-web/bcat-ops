// @vitest-environment jsdom
/**
 * The one rule that separates paying a carrier from receiving cash: every cent of an
 * AP payment has to land on a bill.
 *
 * `planPayment` is deliberately NOT mocked. What a person reads before posting has to be
 * what `RECORD_AP_PAYMENT` would decide, so the dialog is driven with real bills and a
 * real credit and the footer is read back.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { PayCarrierDialog } from './PayCarrierDialog'
import type { ApPaymentRecord, CarrierBillRecord } from '@/types/tms'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

const { listBillsByCarrier, listApPaymentsByCarrier, recordApPayment } = vi.hoisted(() => ({
  listBillsByCarrier: vi.fn(),
  listApPaymentsByCarrier: vi.fn(),
  recordApPayment: vi.fn(),
}))
vi.mock('@/lib/apiClient', () => ({
  listBillsByCarrier,
  listApPaymentsByCarrier,
  recordApPayment,
  graphqlErrorText: (err: unknown) => (err instanceof Error ? err.message : 'failed'),
}))

const WHEN = { createdBy: 'ap@bcat.test', updatedBy: 'ap@bcat.test', version: 1 }

function bill(id: string, billNumber: string, netCents: number, dueAt: string): CarrierBillRecord {
  return {
    id,
    loadCarrierId: `lc-${id}`,
    loadId: `ld-${id}`,
    shipmentId: 'shp-1',
    carrierId: 'car-1',
    carrierName: 'Blue Line Trucking',
    payeeKind: 'CARRIER',
    remitTo: { name: 'Blue Line Trucking', method: 'ACH' },
    status: 'TO_BE_PAID',
    billNumber,
    billDate: dueAt,
    billMonth: dueAt.slice(0, 7),
    recordedAt: `${dueAt}T12:00:00.000Z`,
    recordedBy: 'ap@bcat.test',
    dueAt,
    termsDays: 30,
    grossCents: netCents,
    quickPayFeeCents: 0,
    netCents,
    billedCents: netCents,
    varianceCents: 0,
    paidCents: 0,
    creditedCents: 0,
    balanceCents: netCents,
    apOpen: 'OPEN',
    ...WHEN,
  }
}

const BILLS: CarrierBillRecord[] = [
  bill('cb-1', 'BLT-1001', 100_000, '2026-01-10'),
  bill('cb-2', 'BLT-1002', 250_000, '2026-02-10'),
]

/** A TONU adjustment we hold against this carrier, unspent. */
const PAYMENTS: ApPaymentRecord[] = [
  {
    id: 'ap-credit', carrierId: 'car-1', kind: 'CREDIT_MEMO', paidAt: '2026-01-05T12:00:00.000Z',
    reference: 'TONU-9', amountCents: 25_000, appliedCents: 0, unappliedCents: 25_000, createdBy: 'ap@bcat.test',
  },
]

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

function total(label: string): string {
  return screen.getByLabelText(label).textContent ?? ''
}

function postButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Post payment' }) as HTMLButtonElement
}

beforeEach(() => {
  vi.clearAllMocks()
  listBillsByCarrier.mockResolvedValue(BILLS)
  listApPaymentsByCarrier.mockResolvedValue(PAYMENTS)
})

/** Waits for the carrier's account to load, then returns the amount box. */
async function openForm(): Promise<HTMLInputElement> {
  render(<PayCarrierDialog carrierId="car-1" open onOpenChange={vi.fn()} onDone={vi.fn()} />)
  return await screen.findByLabelText('Payment amount') as HTMLInputElement
}

describe('PayCarrierDialog', () => {
  it('says in plain words what Post payment does: no money moves, bills are marked Paid, remittance is e-mailed', async () => {
    await openForm()
    const text = screen.getByTestId('pay-dialog-explainer').textContent ?? ''
    expect(text).toMatch(/does not send any money/)
    expect(text).toMatch(/marks the bills you apply it to as Paid/)
    expect(text).toMatch(/e-mails remittance/)
    expect(text).toMatch(/nothing\s+is sent/)
    expect(screen.getByRole('heading', { name: /Record payment/ })).toBeTruthy()
  })

  it('refuses to post cash that is not against a bill, and posts once every cent is', async () => {
    await openForm()

    type('Payment amount', '1000.00')
    await waitFor(() => expect(total('Unallocated total')).toBe('$1,000.00'))
    expect(postButton().disabled).toBe(true)
    expect(screen.getByText(/is unallocated/)).toBeTruthy()

    type('Apply to bill BLT-1001', '1000.00')

    await waitFor(() => expect(total('Applied total')).toBe('$1,000.00'))
    expect(total('Unallocated total')).toBe('$0.00')
    expect(postButton().disabled).toBe(false)
  })

  it('lets a held credit cover part of a bill so less cash leaves the bank', async () => {
    await openForm()

    type('Payment amount', '750.00')
    type('Use credit TONU-9', '250.00')
    type('Apply to bill BLT-1001', '1000.00')

    await waitFor(() => expect(total('Applied total')).toBe('$1,000.00'))
    expect(total('From credits total')).toBe('$250.00')
    expect(total('Unallocated total')).toBe('$0.00')
    expect(postButton().disabled).toBe(false)
  })

  it('posts with the no-remittance flag only when the already-paid box is ticked', async () => {
    recordApPayment.mockResolvedValue({ payment: { amountCents: 100000 }, bills: [], duplicate: false })
    await openForm()
    type('Payment amount', '1000.00')
    type('Apply to bill BLT-1001', '1000.00')
    await waitFor(() => expect(postButton().disabled).toBe(false))
    fireEvent.click(postButton())
    await waitFor(() => expect(recordApPayment).toHaveBeenCalledTimes(1))
    expect(recordApPayment.mock.calls[0][0]).not.toHaveProperty('suppressRemittance')
  })

  it('sends suppressRemittance when "Already paid outside the app" is ticked', async () => {
    recordApPayment.mockClear()
    recordApPayment.mockResolvedValue({ payment: { amountCents: 100000 }, bills: [], duplicate: false })
    await openForm()
    type('Payment amount', '1000.00')
    type('Apply to bill BLT-1001', '1000.00')
    fireEvent.click(screen.getByLabelText(/Already paid outside the app/))
    await waitFor(() => expect(postButton().disabled).toBe(false))
    fireEvent.click(postButton())
    await waitFor(() => expect(recordApPayment).toHaveBeenCalledTimes(1))
    expect(recordApPayment.mock.calls[0][0]).toMatchObject({ suppressRemittance: true })
  })

  it("refuses to put more against a bill than it owes, in the carrier's words", async () => {
    await openForm()

    type('Payment amount', '2000.00')
    type('Apply to bill BLT-1001', '1500.00')

    await waitFor(() => expect(postButton().disabled).toBe(true))
    expect(screen.getByText('Bill BLT-1001 has $1,000.00 outstanding; $1,500.00 was applied')).toBeTruthy()
  })

  it('says Pay-to needed when the carrier has nowhere to send money, and offers to add it; it blocks nothing', async () => {
    const onFix = vi.fn()
    render(
      <PayCarrierDialog
        carrierId="car-1"
        payToNeeded={{ label: 'Pay-to needed', title: 'This carrier has no payment method on file.', onFix }}
        open
        onOpenChange={vi.fn()}
        onDone={vi.fn()}
      />,
    )
    await screen.findByLabelText('Payment amount')
    expect(screen.getByTestId('pay-dialog-payto-needed').textContent).toMatch(/Pay-to needed\./)
    fireEvent.click(screen.getByRole('button', { name: 'Add pay-to' }))
    expect(onFix).toHaveBeenCalledTimes(1)
  })

  it('will not post money against a bill whose payee has no bank info, and says why (Ryne 2026-11-19)', async () => {
    render(
      <PayCarrierDialog
        carrierId="car-1"
        payBlocks={{ [BILLS[0].id]: 'Blue Line Trucking has no bank details on file for ACH.' }}
        open
        onOpenChange={vi.fn()}
        onDone={vi.fn()}
      />,
    )
    await screen.findByLabelText('Payment amount')
    type('Payment amount', '1000.00')
    type('Apply to bill BLT-1001', '1000.00')
    await waitFor(() => expect(total('Applied total')).toBe('$1,000.00'))
    expect(screen.getByTestId('pay-dialog-payment-info-blocked').textContent).toMatch(/no bank details on file for ACH/)
    expect(postButton().disabled).toBe(true)
  })

  it('shows no pay-to notice when the carrier has one', async () => {
    await openForm()
    expect(screen.queryByTestId('pay-dialog-payto-needed')).toBeNull()
  })
})
