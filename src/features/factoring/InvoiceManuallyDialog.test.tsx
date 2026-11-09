// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { InvoiceManuallyDialog } from './InvoiceManuallyDialog'
import type { FactoringItem } from '@/types'

const api = vi.hoisted(() => ({ markManualInvoice: vi.fn() }))
vi.mock('@/lib/otrClient', () => api)
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

function item(over: Partial<FactoringItem> = {}): FactoringItem {
  return { id: '14538', proNumber: '14538', status: 'NEED_TO_FACTOR', subject: '', fromEmail: '', receivedAt: '', messageId: '', createdAt: '', updatedAt: '', ...over } as FactoringItem
}
const acme = { id: 'c1', name: 'ACME Freight', billingMethod: 'FACTOR' as const, apEmail: 'ap@acme.com' }
const noBuyRow = () => item({ status: 'MANUAL_INVOICE', manualReason: 'NO_BUY', brokerCheckResult: 'NO_BUY', otrError: 'OTR will not buy from MC 592002 (No Buy)' })

function open(row: FactoringItem, customer: typeof acme | { id: string; name: string; billingMethod: 'FACTOR'; apEmail: string | null } | null = acme, canChangeDefault = true) {
  const onDone = vi.fn()
  const onClose = vi.fn()
  render(<InvoiceManuallyDialog item={row} customer={customer} canChangeDefault={canChangeDefault} onClose={onClose} onDone={onDone} />)
  return { onDone, onClose }
}

beforeEach(() => { vi.clearAllMocks(); api.markManualInvoice.mockResolvedValue({ status: 'MANUAL_INVOICE' }) })

describe('Invoice manually on a No buy row', () => {
  it('says the customer, old -> new method and what happens to the invoice, then changes both', async () => {
    const { onDone } = open(noBuyRow())
    expect(screen.getByText(/OTR will not buy from MC 592002/)).toBeInTheDocument()
    expect(screen.getByText('ACME Freight', { exact: false, selector: 'strong' })).toBeInTheDocument()
    expect(screen.getByText('Factor', { selector: 'strong' })).toBeInTheDocument()
    expect(screen.getByText('Manual', { selector: 'strong' })).toBeInTheDocument()
    expect(screen.getByText(/leaves the factoring queue/)).toBeInTheDocument()
    expect(screen.getByText(/Nothing is e-mailed now/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Invoice manually' }))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(api.markManualInvoice).toHaveBeenCalledWith('14538', { reason: 'NO_BUY', changeCustomerDefault: true })
  })

  it('asks for the AP e-mail first when the customer has none, validates it, and sends it along', async () => {
    const { onDone } = open(noBuyRow(), { ...acme, apEmail: null })
    fireEvent.click(screen.getByRole('button', { name: 'Invoice manually' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/no valid AP e-mail/)
    expect(api.markManualInvoice).not.toHaveBeenCalled()
    fireEvent.change(screen.getByPlaceholderText('ap@customer.com'), { target: { value: 'nope' } })
    fireEvent.click(screen.getByRole('button', { name: 'Invoice manually' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/does not look like/)
    fireEvent.change(screen.getByPlaceholderText('ap@customer.com'), { target: { value: 'ap@acme.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Invoice manually' }))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(api.markManualInvoice).toHaveBeenCalledWith('14538', { reason: 'NO_BUY', changeCustomerDefault: true, customerApEmail: 'ap@acme.com' })
  })

  it('leaves the default alone, and says why, without the billing release permission', () => {
    open(noBuyRow(), acme, false)
    expect(screen.getByText(/needs the billing release permission/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Invoice manually' }))
    return waitFor(() => expect(api.markManualInvoice).toHaveBeenCalledWith('14538', { reason: 'NO_BUY', changeCustomerDefault: false }))
  })

  it('shows the server refusal and offers the AP field when the server finds no AP e-mail', async () => {
    api.markManualInvoice.mockRejectedValueOnce(new Error('ACME has no valid AP e-mail, so its invoices cannot be e-mailed.'))
    open(noBuyRow(), null)
    fireEvent.click(screen.getByRole('button', { name: 'Invoice manually' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/no valid AP e-mail/)
    expect(screen.getByPlaceholderText('ap@customer.com')).toBeInTheDocument()
  })
})

describe('Invoice manually on any other row', () => {
  it('leaves the customer alone unless the box is ticked', async () => {
    const { onDone } = open(item())
    expect(screen.getByText(/stays/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Invoice manually' }))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(api.markManualInvoice).toHaveBeenLastCalledWith('14538', { reason: 'MANUAL', changeCustomerDefault: false })
  })

  it('changes the default only when "Also change this customer\u2019s default to Manual" is ticked, and says old -> new', async () => {
    open(item())
    fireEvent.click(screen.getByLabelText(/Also change this customer's default to Manual/))
    expect(screen.getByText(/ACME Freight: Factor → Manual/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Invoice manually' }))
    await waitFor(() => expect(api.markManualInvoice).toHaveBeenLastCalledWith('14538', { reason: 'MANUAL', changeCustomerDefault: true }))
  })

  it('has no checkbox without the permission', () => {
    open(item(), acme, false)
    expect(screen.queryByLabelText(/Also change/)).not.toBeInTheDocument()
  })

  it('confirms taking back an invoice OTR is still working on', async () => {
    open(item({ status: 'PENDING_WITH_OTR', otrInvoiceId: '99', otrStatus: 1 }))
    expect(screen.getByText(/already submitted to OTR/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Invoice manually' }))
    await waitFor(() => expect(api.markManualInvoice).toHaveBeenLastCalledWith('14538', { reason: 'MANUAL', changeCustomerDefault: false, confirmSubmitted: true }))
  })
})
