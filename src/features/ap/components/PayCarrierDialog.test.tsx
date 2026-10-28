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
  return screen.getByRole('button', { name: 'Post' }) as HTMLButtonElement
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

  it("refuses to put more against a bill than it owes, in the carrier's words", async () => {
    await openForm()

    type('Payment amount', '2000.00')
    type('Apply to bill BLT-1001', '1500.00')

    await waitFor(() => expect(postButton().disabled).toBe(true))
    expect(screen.getByText('Bill BLT-1001 has $1,000.00 outstanding; $1,500.00 was applied')).toBeTruthy()
  })
})
