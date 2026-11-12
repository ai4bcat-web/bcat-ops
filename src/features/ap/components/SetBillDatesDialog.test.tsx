// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { CarrierBillRecord } from '@/types/tms'
import { SetBillDatesDialog } from './SetBillDatesDialog'

const setBillDates = vi.hoisted(() => vi.fn())
vi.mock('@/lib/apiClient', () => ({ setBillDates, graphqlErrorText: (e: unknown) => String(e) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

function bill(over: Partial<CarrierBillRecord> = {}): CarrierBillRecord {
  return {
    id: 'cb:lc-1:1', loadCarrierId: 'lc-1', loadId: 'l-1', shipmentId: 's-1', shipmentNumber: '20027', carrierId: 'car-1',
    carrierName: 'SHERIFAJ TRUCKING INC', payeeKind: 'CARRIER', status: 'IN_REVIEW', billNumber: null, billDate: '2026-11-12',
    billMonth: '2026-11', recordedAt: '2026-11-12T15:00:00.000Z', recordedBy: 'ryne@bcatcorp.com', dueAt: '2026-12-12', termsDays: 30,
    grossCents: 140_000, quickPayFeeCents: 0, netCents: 140_000, billedCents: 140_000, varianceCents: 0, paidCents: 0, creditedCents: 0,
    balanceCents: 140_000, datesPending: true, createdBy: 'x', updatedBy: 'x', version: 1,
    ...over,
  } as CarrierBillRecord
}

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement

describe('SetBillDatesDialog', () => {
  beforeEach(() => { setBillDates.mockReset().mockResolvedValue({ bill: bill({ datesPending: false }) }) })

  it('starts empty while the dates are placeholders, so one cannot be saved by accident', () => {
    render(<SetBillDatesDialog bill={bill()} open onOpenChange={vi.fn()} onDone={vi.fn()} />)
    expect(field('Invoice date').value).toBe('')
    expect(field('Due date').value).toBe('')
    expect((screen.getByRole('button', { name: 'Save dates' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('fills the due date from the carrier’s terms until it is typed by hand, then saves the dates and invoice number', async () => {
    const onDone = vi.fn()
    render(<SetBillDatesDialog bill={bill()} open onOpenChange={vi.fn()} onDone={onDone} />)
    fireEvent.change(field('Invoice date'), { target: { value: '2026-10-30' } })
    expect(field('Due date').value).toBe('2026-11-29')
    fireEvent.change(field('Carrier invoice number'), { target: { value: 'W-5512' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save dates' }))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(setBillDates).toHaveBeenCalledWith({ billId: 'cb:lc-1:1', billDate: '2026-10-30', dueAt: '2026-11-29', billNumber: 'W-5512' })
  })

  it('will not save a due date before the invoice date', () => {
    render(<SetBillDatesDialog bill={bill()} open onOpenChange={vi.fn()} onDone={vi.fn()} />)
    fireEvent.change(field('Invoice date'), { target: { value: '2026-10-30' } })
    fireEvent.change(field('Due date'), { target: { value: '2026-10-01' } })
    expect(screen.getByText('The due date cannot be before the invoice date.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Save dates' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows the real dates when correcting a bill that already has them', () => {
    render(<SetBillDatesDialog bill={bill({ datesPending: false, billDate: '2026-10-30', dueAt: '2026-11-29' })} open onOpenChange={vi.fn()} onDone={vi.fn()} />)
    expect(field('Invoice date').value).toBe('2026-10-30')
    expect(field('Due date').value).toBe('2026-11-29')
  })
})
