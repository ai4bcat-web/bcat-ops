// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { CarrierBillRecord } from '@/types/tms'
import { SetBillDatesDialog } from './SetBillDatesDialog'

const setBillDates = vi.hoisted(() => vi.fn())
const getShipmentBundle = vi.hoisted(() => vi.fn())
const updateCarrierCharges = vi.hoisted(() => vi.fn())
vi.mock('@/lib/apiClient', () => ({ setBillDates, getShipmentBundle, updateCarrierCharges, graphqlErrorText: (e: unknown) => String(e) }))
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

function carrierLine(code: string, rateCents: number, sortOrder: number, isRate = false) {
  return { id: `c${sortOrder}`, side: 'CARRIER', code, calculatedBy: 'FLAT', rateCents, count: 1, isRate, sortOrder, amountCents: rateCents, loadCarrierId: 'lc-1', loadId: 'l-1' }
}

describe('SetBillDatesDialog', () => {
  beforeEach(() => {
    setBillDates.mockReset().mockResolvedValue({ bill: bill({ datesPending: false }) })
    getShipmentBundle.mockReset().mockResolvedValue({
      shipment: { version: 7 },
      orders: [],
      loads: [{ id: 'l-1', miles: 400 }],
      loadCarriers: [{ id: 'lc-1', kind: 'CARRIER', loadId: 'l-1' }],
      charges: [carrierLine('LINEHAUL', 490_000, 0, true), carrierLine('DETENTION', 22_500, 1)],
    })
    // The server stores what it is sent; the amounts are the flat rates here.
    updateCarrierCharges.mockReset().mockImplementation(async (input: { charges: Array<{ rateCents: number }> }) => ({
      charges: input.charges.map((c, i) => ({ ...c, side: 'CARRIER', loadCarrierId: 'lc-1', sortOrder: i, amountCents: c.rateCents, id: `n${i}` })),
    }))
  })

  it('records the carrier’s invoice amount with the dates: the rate moves first, with the reason, then the dates are saved', async () => {
    const onDone = vi.fn()
    render(<SetBillDatesDialog bill={bill({ grossCents: 512_500, netCents: 512_500, billedCents: 512_500, balanceCents: 512_500 })} open onOpenChange={vi.fn()} onDone={onDone} />)
    expect(field('Carrier invoice amount').value).toBe('5125.00')
    fireEvent.change(field('Invoice date'), { target: { value: '2026-10-05' } })
    fireEvent.change(field('Carrier invoice amount'), { target: { value: '5000.00' } })
    expect(screen.getByText(/\$125\.00 lower than BCAT Ops \(\$5,125\.00\)/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Reason for amount change'), { target: { value: 'Detention' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save amount and dates' }))

    await waitFor(() => expect(onDone).toHaveBeenCalled())
    const sent = updateCarrierCharges.mock.calls[0][0]
    expect(sent).toMatchObject({ loadCarrierId: 'lc-1', expectedVersion: 7 })
    expect(sent.charges.map((c: { code: string; rateCents: number }) => [c.code, c.rateCents])).toEqual([['LINEHAUL', 477_500], ['DETENTION', 22_500]])
    expect(sent.changeReason).toBe('Detention: carrier invoice $5,000.00, was $5,125.00')
    expect(sent.amountReason).toBe(sent.changeReason)
    expect(updateCarrierCharges.mock.invocationCallOrder[0]).toBeLessThan(setBillDates.mock.invocationCallOrder[0])
    expect(setBillDates).toHaveBeenCalledWith(expect.objectContaining({ billId: 'cb:lc-1:1', billDate: '2026-10-05' }))
  })

  it('needs the details when the reason is Other, and touches nothing when the amount is left as it is', async () => {
    render(<SetBillDatesDialog bill={bill()} open onOpenChange={vi.fn()} onDone={vi.fn()} />)
    fireEvent.change(field('Invoice date'), { target: { value: '2026-10-05' } })
    fireEvent.change(field('Carrier invoice amount'), { target: { value: '1300.00' } })
    fireEvent.change(screen.getByLabelText('Reason for amount change'), { target: { value: 'Other' } })
    expect(screen.getByText('Say what the amount change is for.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Save amount and dates' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(field('Carrier invoice amount'), { target: { value: '1400.00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save dates' }))
    await waitFor(() => expect(setBillDates).toHaveBeenCalled())
    expect(getShipmentBundle).not.toHaveBeenCalled()
    expect(updateCarrierCharges).not.toHaveBeenCalled()
  })

  it('does not save the dates when the amount cannot be applied, and says why', async () => {
    getShipmentBundle.mockResolvedValue({
      shipment: { version: 7 }, orders: [], loads: [{ id: 'l-1' }],
      loadCarriers: [{ id: 'lc-1', kind: 'CARRIER', loadId: 'l-1' }],
      charges: [carrierLine('DETENTION', 22_500, 0)],
    })
    render(<SetBillDatesDialog bill={bill({ grossCents: 22_500 })} open onOpenChange={vi.fn()} onDone={vi.fn()} />)
    fireEvent.change(field('Invoice date'), { target: { value: '2026-10-05' } })
    fireEvent.change(field('Carrier invoice amount'), { target: { value: '100.00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save amount and dates' }))
    await waitFor(() => expect(screen.getByText(/no rate line/)).toBeTruthy())
    expect(updateCarrierCharges).not.toHaveBeenCalled()
    expect(setBillDates).not.toHaveBeenCalled()
  })

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

  it('offers quick pay: 6% off for 2 days, 3% off for 10, and previews the discount, amount and forced due date', async () => {
    const onDone = vi.fn()
    render(<SetBillDatesDialog bill={bill()} open onOpenChange={vi.fn()} onDone={onDone} />)
    fireEvent.change(field('Invoice date'), { target: { value: '2026-11-02' } })
    expect(field('Due date').value).toBe('2026-12-02') // Net 30 by default
    fireEvent.click(screen.getByLabelText(/2-day quick pay/))
    expect(field('Due date').value).toBe('2026-11-04')
    const amounts = screen.getByLabelText('Quick pay amounts')
    expect(amounts.textContent).toContain('$1,400.00')
    expect(amounts.textContent).toContain('−$84.00')
    expect(amounts.textContent).toContain('$1,316.00')
    fireEvent.click(screen.getByLabelText(/10-day quick pay/))
    expect(field('Due date').value).toBe('2026-11-12')
    expect(screen.getByLabelText('Quick pay amounts').textContent).toContain('$1,358.00')
    fireEvent.click(screen.getByRole('button', { name: 'Save dates' }))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(setBillDates).toHaveBeenCalledWith({ billId: 'cb:lc-1:1', billDate: '2026-11-02', dueAt: '2026-11-12', billNumber: null, quickPayDays: 10 })
  })

  it('goes back to the standard due date when quick pay is switched off, and sends no quick pay when none was chosen', async () => {
    render(<SetBillDatesDialog bill={bill()} open onOpenChange={vi.fn()} onDone={vi.fn()} />)
    fireEvent.change(field('Invoice date'), { target: { value: '2026-11-02' } })
    fireEvent.click(screen.getByLabelText(/2-day quick pay/))
    fireEvent.click(screen.getByLabelText('No quick pay'))
    expect(field('Due date').value).toBe('2026-12-02')
    fireEvent.click(screen.getByRole('button', { name: 'Save dates' }))
    await waitFor(() => expect(setBillDates).toHaveBeenCalled())
    expect(setBillDates.mock.calls[0][0]).not.toHaveProperty('quickPayDays')
  })

  it('does not offer quick pay to a carrier paid through a factor', () => {
    render(<SetBillDatesDialog bill={bill({ payeeKind: 'FACTOR' })} open onOpenChange={vi.fn()} onDone={vi.fn()} />)
    expect((screen.getByLabelText(/2-day quick pay/) as HTMLInputElement).closest('fieldset')?.disabled).toBe(true)
    expect(screen.getByText(/Paid through a factor/)).toBeTruthy()
  })
})
