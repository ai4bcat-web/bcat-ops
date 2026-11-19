// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { BillDrawer } from './BillDrawer'
import type { CarrierBillRecord } from '@/types/tms'

const setBillQuickPay = vi.hoisted(() => vi.fn())
vi.mock('@/lib/apiClient', () => ({ setBillQuickPay, graphqlErrorText: (e: unknown) => String(e) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

function bill(patch: Partial<CarrierBillRecord> = {}): CarrierBillRecord {
  return {
    id: 'b1', loadCarrierId: 'lc1', loadId: 'l1', shipmentId: 's1', shipmentNumber: '20027', carrierId: 'c1', carrierName: 'SHERIFAJ TRUCKING INC',
    payeeKind: 'CARRIER', status: 'IN_REVIEW', billDate: '2026-11-12', billMonth: '2026-11', recordedAt: '2026-11-12T00:00:00Z',
    recordedBy: 'r', dueAt: '2026-12-03', termsDays: 21, grossCents: 147_000, quickPayFeeCents: 0, netCents: 147_000,
    billedCents: 147_000, varianceCents: 0, paidCents: 0, creditedCents: 0, balanceCents: 147_000, createdBy: 'r', updatedBy: 'r',
    version: 1, datesPending: true, ...patch,
  }
}

const facts = new Map([['s1', { shipmentNumber: '20027', customerRef: 'FR-113188-3', deliveredAt: '2026-11-12T07:11:00Z', delivered: true }]])

function draw(
  b: CarrierBillRecord,
  handlers: Partial<Record<'onChanged' | 'onAdjustPay' | 'onSetDates' | 'onClearReview' | 'onDelete', () => void>> = {},
  reviewFlag?: { financeReviewReason?: string | null; financeReviewApNote?: string | null },
) {
  render(
    <MemoryRouter>
      <BillDrawer bill={b} facts={facts} infos={[]} onClose={vi.fn()} onChanged={handlers.onChanged ?? vi.fn()}
        onAdjustPay={handlers.onAdjustPay ?? vi.fn()} onSetDates={handlers.onSetDates ?? vi.fn()} onPaymentInfo={vi.fn()}
        reviewFlag={reviewFlag} onClearReview={handlers.onClearReview} onDelete={handlers.onDelete} />
    </MemoryRouter>,
  )
}

describe('BillDrawer', () => {
  beforeEach(() => { setBillQuickPay.mockReset() })

  it('shows the load, flags the missing invoice date, and offers carrier pay and invoice date', () => {
    const onSetDates = vi.fn()
    const onAdjustPay = vi.fn()
    draw(bill(), { onSetDates, onAdjustPay })
    expect(screen.getByText('Customer ref #')).toBeTruthy()
    expect(screen.getByText('FR-113188-3')).toBeTruthy()
    expect(screen.getByText('Needs invoice date')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add invoice date' }))
    fireEvent.click(screen.getByRole('button', { name: 'Adjust carrier pay' }))
    expect(onSetDates).toHaveBeenCalled()
    expect(onAdjustPay).toHaveBeenCalled()
  })

  it('names the factor on the Pay to line for a factored carrier whose bill froze no payee, and Direct for one paid directly', () => {
    const factored = [{ id: 'pmF', carrierId: 'c1', recipientType: 'FACTOR', factorName: 'Triumph Capital', payeeEmail: 'remit@triumph.test', isPreferred: true, status: 'ACTIVE' }] as never
    const { unmount } = render(
      <MemoryRouter>
        <BillDrawer bill={bill({ datesPending: false })} facts={facts} infos={factored} onClose={vi.fn()} onChanged={vi.fn()}
          onAdjustPay={vi.fn()} onSetDates={vi.fn()} onPaymentInfo={vi.fn()} />
      </MemoryRouter>,
    )
    expect(screen.getByText('Triumph Capital')).toBeTruthy()
    expect(screen.queryByText('Direct')).toBeNull()
    unmount()
    draw(bill({ datesPending: false }))
    expect(screen.getByText('Direct')).toBeTruthy()
  })

  it('shows a Needs review flag with its reasons and a Mark reviewed button; no flag, no section', () => {
    const onClearReview = vi.fn()
    draw(bill(), { onClearReview }, { financeReviewReason: 'Rate differs', financeReviewApNote: 'Carrier billed 1,100' })
    expect(screen.getByText('Rate differs · Carrier billed 1,100')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Mark reviewed' }))
    expect(onClearReview).toHaveBeenCalledWith(expect.objectContaining({ id: 'b1' }))
  })

  it('has no Needs review section when the shipment is not flagged', () => {
    draw(bill())
    expect(screen.queryByRole('button', { name: 'Mark reviewed' })).toBeNull()
  })

  it('offers Delete bill on an open bill and hands the bill to the page; none on a paid one', () => {
    const onDelete = vi.fn()
    draw(bill(), { onDelete })
    fireEvent.click(screen.getByRole('button', { name: 'Delete bill' }))
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'b1' }))
  })

  it('has no Delete bill on a bill that has been paid', () => {
    draw(bill({ status: 'PAID', paidCents: 100_000, balanceCents: 0 }), { onDelete: vi.fn() })
    expect(screen.queryByRole('button', { name: 'Delete bill' })).toBeNull()
  })

  it('puts the bill on 2-day quick pay and shows each fee before the click', async () => {
    setBillQuickPay.mockResolvedValue({ bill: bill() })
    const onChanged = vi.fn()
    draw(bill(), { onChanged })
    expect(screen.getByText(/6% fee · \$88\.20/)).toBeTruthy()
    expect(screen.getByText(/3% fee · \$44\.10/)).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: /^2 days/ }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(setBillQuickPay).toHaveBeenCalledWith({ billId: 'b1', quickPayDays: 2 })
  })

  it('locks quick pay for a factored carrier and carrier pay for an approved bill', () => {
    draw(bill({ payeeKind: 'FACTOR', status: 'TO_BE_PAID', datesPending: false }))
    expect((screen.getByRole('radio', { name: /^2 days/ }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Adjust carrier pay' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Send the bill back to review first')).toBeTruthy()
  })
})
