// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { RepointCustomerDialog } from './RepointCustomerDialog'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

const { repointShipmentCustomer, repointInvoicedCustomer, resolveRevTag, getShipmentBundle, getInvoice } = vi.hoisted(() => ({
  repointShipmentCustomer: vi.fn(),
  repointInvoicedCustomer: vi.fn(),
  resolveRevTag: vi.fn(),
  getShipmentBundle: vi.fn(),
  getInvoice: vi.fn(),
}))

vi.mock('@/lib/apiClient', () => ({
  repointShipmentCustomer,
  repointInvoicedCustomer,
  resolveRevTag,
  getShipmentBundle,
  getInvoice,
}))

const shipment = {
  id: 'shp-1',
  number: 'S001',
  customerId: 'cust-1',
  customerName: 'Acme Freight',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const customers = [
  { id: 'cust-1', name: 'Acme Freight' },
  { id: 'cust-2', name: 'Globex' },
]

/** A bundle with one invoiced order — unpaid, so the plan has no `moneyApplied`. */
function invoicedBundle() {
  return {
    orders: [{ id: 'ord-1', invoiceId: 'inv-1', invoiceNumber: 'INV-000025', customerId: 'cust-1' }],
    shipment: { id: 'shp-1' },
    loads: [],
    loadCarriers: [],
    charges: [],
    financials: [],
    documents: [],
  } as never
}

function unpaidInvoice() {
  return {
    id: 'inv-1',
    number: 'INV-000025',
    status: 'ISSUED',
    totalCents: 250_000,
    paidCents: 0,
    writtenOffCents: 0,
    balanceCents: 250_000,
    factoringItemId: null,
    orderId: 'ord-1',
  } as never
}

/** A bundle where the invoice has received a $50k payment. */
function partlyPaidBundle() {
  return {
    orders: [{ id: 'ord-1', invoiceId: 'inv-1', invoiceNumber: 'INV-000025', customerId: 'cust-1' }],
    shipment: { id: 'shp-1' },
    loads: [],
    loadCarriers: [],
    charges: [],
    financials: [],
    documents: [],
  } as never
}

function partlyPaidInvoice() {
  return {
    id: 'inv-1',
    number: 'INV-000025',
    status: 'PARTIAL',
    totalCents: 250_000,
    paidCents: 50_000,
    writtenOffCents: 0,
    balanceCents: 200_000,
    factoringItemId: null,
    orderId: 'ord-1',
  } as never
}

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
    getShipmentBundle.mockResolvedValue(invoicedBundle())
    getInvoice.mockResolvedValue(unpaidInvoice())
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
    const firstCall = repointInvoicedCustomer.mock.calls[0][0] as { idempotencyKey: string }
    const firstKey = firstCall.idempotencyKey

    // Wait for success close, then reopen.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    getShipmentBundle.mockResolvedValue(invoicedBundle())
    getInvoice.mockResolvedValue(unpaidInvoice())
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
    const secondCall = repointInvoicedCustomer.mock.calls[1][0] as { idempotencyKey: string }
    const secondKey = secondCall.idempotencyKey

    expect(secondKey).not.toBe(firstKey)
  })

  it('reuses the same idempotency key for repeated confirms within one opening', async () => {
    getShipmentBundle.mockResolvedValue(invoicedBundle())
    getInvoice.mockResolvedValue(unpaidInvoice())
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

    const call1 = repointInvoicedCustomer.mock.calls[0][0] as { idempotencyKey: string }
    const call2 = repointInvoicedCustomer.mock.calls[1][0] as { idempotencyKey: string }
    expect(call1.idempotencyKey).toBe(call2.idempotencyKey)
  })

  it('resolves the revenue tag after a credit-and-rebill and surfaces failure separately', async () => {
    getShipmentBundle.mockResolvedValue(invoicedBundle())
    getInvoice.mockResolvedValue(unpaidInvoice())
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

describe('RepointCustomerDialog credit-and-rebill acknowledgement', () => {
  it('shows per-invoice arithmetic and requires acknowledgement when money was applied', async () => {
    getShipmentBundle.mockResolvedValue(partlyPaidBundle())
    getInvoice.mockResolvedValue(partlyPaidInvoice())
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

    // Wait for the plan to load
    await waitFor(() => expect(screen.getByText(/INV-000025 — credit/)).toBeTruthy())
    expect(screen.getByText(/\$2,000\.00 to the open balance/)).toBeTruthy()
    expect(screen.getByText(/\$500\.00 becomes an account credit for Acme Freight/)).toBeTruthy()
    expect(screen.getByText(/Acme Freight is billed \$2,500\.00 through the normal release gate/)).toBeTruthy()

    // Acknowledgement checkbox is shown
    const checkbox = screen.getByRole('checkbox')
    expect(checkbox).toBeTruthy()
    expect(checkbox).not.toBeChecked()

    // Confirm button is disabled until checked
    const confirmBtn = screen.getByRole('button', { name: /Credit original and rebill/i })
    expect(confirmBtn).toBeDisabled()

    // Check the box
    fireEvent.click(checkbox)
    expect(confirmBtn).not.toBeDisabled()

    // Confirm with acknowledgePaid
    repointInvoicedCustomer.mockResolvedValueOnce({})
    fireEvent.click(confirmBtn)

    await waitFor(() => expect(repointInvoicedCustomer).toHaveBeenCalled())
    const callArg = repointInvoicedCustomer.mock.calls[0][0] as { acknowledgePaid?: boolean }
    const ack = callArg.acknowledgePaid
    expect(ack).toBe(true)
  })

  it('passes acknowledgePaid: true when the checkbox is checked', async () => {
    getShipmentBundle.mockResolvedValue(partlyPaidBundle())
    getInvoice.mockResolvedValue(partlyPaidInvoice())
    repointShipmentCustomer.mockRejectedValueOnce(new Error('INVOICED: already billed'))
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

    await waitFor(() => expect(screen.getByRole('checkbox')).toBeTruthy())
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: /Credit original and rebill/i }))

    await waitFor(() => expect(repointInvoicedCustomer).toHaveBeenCalled())
    const callArg = repointInvoicedCustomer.mock.calls[0][0] as { acknowledgePaid?: boolean }
    const ack = callArg.acknowledgePaid
    expect(ack).toBe(true)
  })
})