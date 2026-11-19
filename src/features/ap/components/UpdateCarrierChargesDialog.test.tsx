// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { UpdateCarrierChargesDialog } from './UpdateCarrierChargesDialog'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

const getShipmentBundle = vi.hoisted(() => vi.fn())
const getTmsSettings = vi.hoisted(() => vi.fn())
const listCustomers = vi.hoisted(() => vi.fn())
const updateCarrierCharges = vi.hoisted(() => vi.fn())
vi.mock('@/lib/apiClient', () => ({
  getShipmentBundle, getTmsSettings, listCustomers, updateCarrierCharges, graphqlErrorText: (e: unknown) => String(e),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const line = (code: string, rateCents: number, sortOrder: number, isRate = false) => ({
  id: `c${sortOrder}`, side: 'CARRIER', code, calculatedBy: 'FLAT', rateCents, count: 1, isRate, sortOrder, amountCents: rateCents,
  loadCarrierId: 'lc-1', loadId: 'l-1', shipmentId: 's-1',
})

function bundle(arStatus: string | null) {
  return {
    shipment: { id: 's-1', version: 4, customerId: 'cu-1' },
    orders: [{ id: 'o-1', arStatus, invoiceId: arStatus ? 'inv-1' : null }],
    loads: [{ id: 'l-1', miles: 400 }],
    loadCarriers: [{ id: 'lc-1', kind: 'CARRIER', loadId: 'l-1', carrierName: 'BISKA INC', invoiceId: null, chargesFinalizedAt: null }],
    charges: [line('LINEHAUL', 490_000, 0, true), line('TONU', 0, 1)],
  }
}

function open(onOpenChange = vi.fn()) {
  const onDone = vi.fn()
  render(<UpdateCarrierChargesDialog loadCarrierId="lc-1" shipmentId="s-1" open onOpenChange={onOpenChange} onDone={onDone} />)
  return { onOpenChange, onDone }
}

describe('UpdateCarrierChargesDialog', () => {
  beforeEach(() => {
    getTmsSettings.mockReset().mockResolvedValue({ chargeCodes: [
      { code: 'LINEHAUL', label: 'Linehaul', calculatedBy: 'FLAT' }, { code: 'TONU', label: 'Truck ordered not used', calculatedBy: 'FLAT' },
    ] })
    listCustomers.mockReset().mockResolvedValue([])
    updateCarrierCharges.mockReset().mockResolvedValue({})
  })

  it('asks for the reason up front on an invoiced shipment and holds Save until it is long enough', async () => {
    getShipmentBundle.mockReset().mockResolvedValue(bundle('UNPAID'))
    const { onDone } = open()
    await waitFor(() => expect(screen.getByLabelText('Reason for change')).toBeTruthy())
    fireEvent.change(screen.getAllByLabelText('Rate')[0], { target: { value: '5000.00' } })
    fireEvent.blur(screen.getAllByLabelText('Rate')[0])
    expect(screen.getByText('Add the reason for the change to save.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Save charges' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('Reason for change'), { target: { value: 'Carrier invoice was lower' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save charges' }))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    const sent = updateCarrierCharges.mock.calls[0][0]
    expect(sent.changeReason).toBe('Carrier invoice was lower')
    // The $0 TONU placeholder is left out instead of being saved as a line.
    expect(sent.charges.map((c: { code: string }) => c.code)).toEqual(['LINEHAUL'])
  })

  it('does not ask for a reason on a shipment that has no invoice yet', async () => {
    getShipmentBundle.mockReset().mockResolvedValue(bundle(null))
    open()
    await waitFor(() => expect(screen.getAllByLabelText('Rate').length).toBeGreaterThan(0))
    expect(screen.queryByLabelText('Reason for change')).toBeNull()
  })

  it('asks before closing with edits that are not saved, and lets you keep editing or discard', async () => {
    getShipmentBundle.mockReset().mockResolvedValue(bundle(null))
    const { onOpenChange } = open()
    await waitFor(() => expect(screen.getAllByLabelText('Rate').length).toBeGreaterThan(0))
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!)
    expect(onOpenChange).toHaveBeenCalledWith(false)

    onOpenChange.mockClear()
    fireEvent.change(screen.getAllByLabelText('Rate')[0], { target: { value: '4800.00' } })
    fireEvent.blur(screen.getAllByLabelText('Rate')[0])
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!)
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.getByText('You have changes that are not saved.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(screen.queryByText('You have changes that are not saved.')).toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!)
    fireEvent.click(screen.getByRole('button', { name: 'Discard and close' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
  it('edits a line, adds one, deletes one, and saves carrier lines only', async () => {
    getShipmentBundle.mockReset().mockResolvedValue({
      ...bundle(null),
      charges: [{ ...line('LINEHAUL', 512_500, 0, true), side: 'CUSTOMER', loadCarrierId: null }, line('LINEHAUL', 490_000, 0, true), line('TONU', 12_500, 1)],
    })
    const { onDone } = open()
    await waitFor(() => expect(screen.getByLabelText('CARRIER charge code 1')).toBeTruthy())
    // The customer side is shown, read only, with a true profit.
    expect((screen.getByLabelText('CUSTOMER charge code 1') as HTMLSelectElement).disabled).toBe(true)
    expect(screen.getByText('AP record')).toBeTruthy()
    // Edit rate and count, delete the TONU, add a fuel line.
    fireEvent.change(screen.getAllByLabelText('Rate')[1], { target: { value: '5000.00' } })
    fireEvent.blur(screen.getAllByLabelText('Rate')[1])
    fireEvent.change(screen.getByLabelText('CARRIER count 1'), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove CARRIER line 2' }))
    fireEvent.click(screen.getByRole('button', { name: /Add line/ }))
    fireEvent.change(screen.getByLabelText('CARRIER charge code 2'), { target: { value: 'TONU' } })
    fireEvent.change(screen.getAllByLabelText('Rate')[2], { target: { value: '100.00' } })
    fireEvent.blur(screen.getAllByLabelText('Rate')[2])
    fireEvent.click(screen.getByRole('button', { name: 'Save charges' }))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    const sent = updateCarrierCharges.mock.calls[0][0]
    expect(sent.charges.map((c: { side: string; code: string; rateCents: number }) => [c.side, c.code, c.rateCents]))
      .toEqual([['CARRIER', 'LINEHAUL', 500_000], ['CARRIER', 'TONU', 10_000]])
  })

  it('shows dashes, not a made-up profit, when the shipment has no customer lines', async () => {
    getShipmentBundle.mockReset().mockResolvedValue(bundle(null))
    open()
    await waitFor(() => expect(screen.getByTestId('financial-totals')).toBeTruthy())
    expect(screen.getByTestId('financial-totals').textContent).not.toMatch(/-\$|\$-/)
    expect(screen.getByLabelText('Financial totals').textContent).toContain('—')
  })
})
