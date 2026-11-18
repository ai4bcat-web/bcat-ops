// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { InvoiceRecord, ShipmentBundle } from '@/types/tms'

const mocks = vi.hoisted(() => ({ bundle: vi.fn(), recalc: vi.fn(), revise: vi.fn() }))
vi.mock('@/lib/apiClient', () => ({
  getShipmentBundle: mocks.bundle, recalcCharges: mocks.recalc, reviseInvoice: mocks.revise, graphqlErrorText: (e: unknown) => String(e),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
import { InvoiceRateEditor } from './InvoiceRateEditor'

const line = (over: Record<string, unknown>) => ({
  orderId: 'o-1', loadId: 'load-1', loadCarrierId: null, label: null, calculatedBy: 'FLAT', count: 1, release: null, note: null,
  createdBy: 'x', createdAt: 't', updatedAt: 't', ...over,
})
const bundle = {
  shipment: { id: 'shp-1', version: 4 },
  orders: [{ id: 'o-1' }],
  loads: [{ id: 'load-1', miles: 300, weight: 20000 }],
  loadCarriers: [{ id: 'lc-1', loadId: 'load-1', status: 'ACTIVE', kind: 'CARRIER', sequence: 0, carrierId: 'car-1', carrierName: 'SHERIFAJ TRUCKING INC' }],
  charges: [
    line({ id: 'c1', side: 'CUSTOMER', code: 'LINEHAUL', label: 'Linehaul', rateCents: 110000, amountCents: 110000, isRate: true, sortOrder: 0 }),
    line({ id: 'k1', side: 'CARRIER', orderId: null, loadCarrierId: 'lc-1', code: 'LINEHAUL', label: 'Line Haul', rateCents: 90000, amountCents: 90000, isRate: true, sortOrder: 1 }),
  ],
  financials: [{ id: 'load-1', frozenAt: '2026-11-18T00:00:00Z' }],
  documents: [],
} as unknown as ShipmentBundle

const invoice = { id: 'inv-1', number: '20073', orderId: 'o-1', shipmentId: 'shp-1', shipmentNumber: '20073', customerId: 'c', customerName: 'INTEGRITY',
  status: 'ISSUED', totalCents: 110000, subtotalCents: 110000, paidCents: 0, writtenOffCents: 0, balanceCents: 110000 } as unknown as InvoiceRecord

beforeEach(() => {
  cleanup(); vi.clearAllMocks()
  mocks.bundle.mockResolvedValue(bundle)
  mocks.recalc.mockResolvedValue(bundle)
  mocks.revise.mockResolvedValue({ invoice: { ...invoice, totalCents: 140587 }, revision: 1 })
})

describe('InvoiceRateEditor', () => {
  it('shows only the customer lines: carrier pay is never on screen', async () => {
    render(<InvoiceRateEditor invoice={invoice} onSaved={vi.fn()} onCancel={vi.fn()} />)
    expect(await screen.findByLabelText('Customer charges')).toBeTruthy()
    expect(screen.getByLabelText('Linehaul amount')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/SHERIFAJ|900\.00|margin|profit/i)
  })

  it('updates the new total as the amount is typed, and a quick charge adds a customer line', async () => {
    render(<InvoiceRateEditor invoice={invoice} onSaved={vi.fn()} onCancel={vi.fn()} />)
    const amount = await screen.findByLabelText('Linehaul amount')
    fireEvent.change(amount, { target: { value: '1,100.00' } })
    fireEvent.blur(amount)
    fireEvent.click(screen.getByRole('button', { name: 'Fuel surcharge' }))
    const fsc = await screen.findByLabelText('Fuel surcharge amount')
    fireEvent.change(fsc, { target: { value: '325.87' } })
    fireEvent.blur(fsc)
    await waitFor(() => expect(screen.getByLabelText('New invoice total').textContent).toBe('$1,425.87'))
  })

  it('saves through the shipment charges with the default reason, then reports the old and new amount', async () => {
    const onSaved = vi.fn()
    render(<InvoiceRateEditor invoice={invoice} onSaved={onSaved} onCancel={vi.fn()} />)
    const amount = await screen.findByLabelText('Linehaul amount')
    fireEvent.change(amount, { target: { value: '1405.87' } })
    fireEvent.blur(amount)
    fireEvent.click(screen.getByRole('button', { name: 'Save amount' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(mocks.recalc).toHaveBeenCalledWith(expect.objectContaining({ shipmentId: 'shp-1', changeReason: 'Rate edited before sending' }))
    expect(onSaved.mock.calls[0][1]).toEqual({ beforeCents: 110000, afterCents: 140587 })
  })

  it('will not save a zero amount or a missing reason', async () => {
    render(<InvoiceRateEditor invoice={invoice} onSaved={vi.fn()} onCancel={vi.fn()} />)
    const amount = await screen.findByLabelText('Linehaul amount')
    fireEvent.change(amount, { target: { value: '0' } })
    fireEvent.blur(amount)
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save amount' }) as HTMLButtonElement).disabled).toBe(true))
    fireEvent.change(amount, { target: { value: '1200' } })
    fireEvent.blur(amount)
    fireEvent.change(screen.getByLabelText('Reason for the change'), { target: { value: 'x' } })
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save amount' }) as HTMLButtonElement).disabled).toBe(true))
  })

  it('shows what went wrong and keeps the editor open when the save is refused', async () => {
    mocks.recalc.mockRejectedValue(new Error('conflict'))
    render(<InvoiceRateEditor invoice={invoice} onSaved={vi.fn()} onCancel={vi.fn()} />)
    await screen.findByLabelText('Linehaul amount')
    fireEvent.click(screen.getByRole('button', { name: 'Save amount' }))
    await waitFor(() => expect(screen.getByText(/conflict/)).toBeTruthy())
    expect(mocks.revise).not.toHaveBeenCalled()
  })
})
