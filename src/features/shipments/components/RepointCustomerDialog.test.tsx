// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { RepointCustomerDialog } from './RepointCustomerDialog'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

const { repointShipmentCustomer, repointInvoicedCustomer, resolveRevTag } = vi.hoisted(() => ({
  repointShipmentCustomer: vi.fn(),
  repointInvoicedCustomer: vi.fn(),
  resolveRevTag: vi.fn(),
}))

vi.mock('@/lib/apiClient', () => ({
  repointShipmentCustomer,
  repointInvoicedCustomer,
  resolveRevTag,
}))

const shipment = {
  id: 'shp-1',
  number: 'S001',
  customerId: 'cust-1',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const customers = [
  { id: 'cust-1', name: 'Acme Freight' },
  { id: 'cust-2', name: 'Globex' },
]

function Wrapper() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open</button>
      <RepointCustomerDialog
        shipment={shipment}
        customers={customers}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  )
}

beforeEach(() => {
  vi.resetAllMocks()
})

describe('RepointCustomerDialog idempotency', () => {
  it('mints a fresh idempotency key each time the dialog opens', async () => {
    repointShipmentCustomer.mockRejectedValueOnce(new Error('INVOICED: already billed'))
    repointInvoicedCustomer.mockResolvedValueOnce({})

    render(<Wrapper />)

    // First opening: choose new customer, trigger credit path, confirm credit.
    fireEvent.click(screen.getByRole('button', { name: /Open/i }))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())

    fireEvent.change(screen.getByRole('combobox', { name: /New customer/i }), { target: { value: 'cust-2' } })
    fireEvent.change(screen.getByRole('textbox', { name: /Reason/i }), { target: { value: 'Sold to different division' } })
    fireEvent.click(screen.getByRole('button', { name: /^Re-point$/i }))

    await waitFor(() => expect(screen.getByRole('button', { name: /Credit original and rebill/i })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /Credit original and rebill/i }))

    await waitFor(() => expect(repointInvoicedCustomer).toHaveBeenCalled())
    const firstKey = repointInvoicedCustomer.mock.calls[0][0].idempotencyKey

    // Wait for success close, then reopen.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    repointShipmentCustomer.mockRejectedValueOnce(new Error('INVOICED: already billed'))
    repointInvoicedCustomer.mockResolvedValueOnce({})

    fireEvent.click(screen.getByRole('button', { name: /Open/i }))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())

    fireEvent.change(screen.getByRole('combobox', { name: /New customer/i }), { target: { value: 'cust-2' } })
    fireEvent.change(screen.getByRole('textbox', { name: /Reason/i }), { target: { value: 'Sold to different division' } })
    fireEvent.click(screen.getByRole('button', { name: /^Re-point$/i }))

    await waitFor(() => expect(screen.getByRole('button', { name: /Credit original and rebill/i })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /Credit original and rebill/i }))

    await waitFor(() => expect(repointInvoicedCustomer).toHaveBeenCalledTimes(2))
    const secondKey = repointInvoicedCustomer.mock.calls[1][0].idempotencyKey

    expect(secondKey).not.toBe(firstKey)
  })

  it('reuses the same idempotency key for repeated confirms within one opening', async () => {
    repointShipmentCustomer.mockRejectedValueOnce(new Error('INVOICED: already billed'))
    repointInvoicedCustomer.mockRejectedValueOnce(new Error('Network hiccup'))
    repointInvoicedCustomer.mockResolvedValueOnce({})

    render(
      <RepointCustomerDialog
        shipment={shipment}
        customers={customers}
        open
        onOpenChange={() => {}}
      />,
    )

    fireEvent.change(screen.getByRole('combobox', { name: /New customer/i }), { target: { value: 'cust-2' } })
    fireEvent.change(screen.getByRole('textbox', { name: /Reason/i }), { target: { value: 'Sold to different division' } })
    fireEvent.click(screen.getByRole('button', { name: /^Re-point$/i }))

    await waitFor(() => expect(screen.getByRole('button', { name: /Credit original and rebill/i })).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /Credit original and rebill/i }))
    await waitFor(() => expect(repointInvoicedCustomer).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: /Credit original and rebill/i }))
    await waitFor(() => expect(repointInvoicedCustomer).toHaveBeenCalledTimes(2))

    expect(repointInvoicedCustomer.mock.calls[0][0].idempotencyKey).toBe(repointInvoicedCustomer.mock.calls[1][0].idempotencyKey)
  })

  it('resolves the revenue tag after a credit-and-rebill and surfaces failure separately', async () => {
    repointShipmentCustomer.mockRejectedValueOnce(new Error('INVOICED: already billed'))

    render(
      <RepointCustomerDialog
        shipment={shipment}
        customers={customers}
        open
        onOpenChange={() => {}}
      />,
    )

    fireEvent.change(screen.getByRole('combobox', { name: /New customer/i }), { target: { value: 'cust-2' } })
    fireEvent.change(screen.getByRole('textbox', { name: /Reason/i }), { target: { value: 'Sold to different division' } })
    fireEvent.click(screen.getByRole('button', { name: /^Re-point$/i }))

    await waitFor(() => expect(screen.getByRole('button', { name: /Credit original and rebill/i })).toBeTruthy())

    repointInvoicedCustomer.mockResolvedValueOnce({})
    resolveRevTag.mockRejectedValueOnce(new Error('Tag resolver unavailable'))
    fireEvent.click(screen.getByRole('button', { name: /Credit original and rebill/i }))

    await waitFor(() => expect(resolveRevTag).toHaveBeenCalledWith({ shipmentId: 'shp-1' }))
    expect(screen.getByText('Tag resolver unavailable')).toBeTruthy()

    // A second confirm should not report success until resolveRevTag succeeds.
    resolveRevTag.mockResolvedValueOnce({})
    fireEvent.click(screen.getByRole('button', { name: /Credit original and rebill/i }))

    await waitFor(() => expect(resolveRevTag).toHaveBeenCalledTimes(2))
  })
})
