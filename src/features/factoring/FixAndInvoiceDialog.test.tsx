// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { FactoringItem } from '@/types'
import type { CustomerRecord, InvoiceRecord } from '@/types/tms'

const api = vi.hoisted(() => ({
  patchCustomer: vi.fn(),
  plainSaveError: (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback),
  moveToManualInvoice: vi.fn(),
  generateInvoice: vi.fn(),
  getShipment: vi.fn(),
  getLoads: vi.fn(),
  graphqlErrorText: (e: unknown) => String(e),
}))
vi.mock('@/lib/apiClient', () => api)
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
// The send review is the ordinary one; here it only has to open on the new invoice. Its Send is never pressed.
const carousel = vi.hoisted(() => vi.fn())
vi.mock('@/features/ar/components/SendReviewCarousel', () => ({
  SendReviewCarousel: (p: { invoices: InvoiceRecord[]; customerById: Map<string, CustomerRecord> }) => {
    carousel(p)
    return <div data-testid="send-review">{p.invoices.map((i) => i.number).join(',')}</div>
  },
}))

import { FixAndInvoiceDialog } from './FixAndInvoiceDialog'

const dead = {
  id: 'fi1', proNumber: '14700', status: 'PENDING_WITH_OTR', otrStatus: 4, otrInvoiceId: '25884230',
  otrStatusSyncedAt: '2026-11-10T17:05:00Z', customerId: 'c1', loadId: 'l1', brokerCheckResult: 'APPROVED',
} as unknown as FactoringItem
const customer = {
  id: 'c1', name: 'ACME BROKERAGE', billingMethod: 'FACTOR', factored: true, apEmail: '', apEmailsExtra: [],
  paymentTermsDays: 30, updatedAt: '2026-11-01T00:00:00Z',
} as unknown as CustomerRecord

beforeEach(() => { vi.clearAllMocks() })

describe('Fix & invoice manually', () => {
  it('says why OTR turned it down', () => {
    render(<FixAndInvoiceDialog item={dead} customers={[customer]} isAdmin onClose={() => {}} onChanged={() => {}} />)
    const reason = screen.getByTestId('fix-invoice-reason')
    expect(reason).toHaveTextContent('OTR: Dead — this invoice will not be funded')
    expect(reason).toHaveTextContent('OTR invoice #25884230')
  })

  it('runs the three steps in order and opens the send review without sending anything', async () => {
    const onChanged = vi.fn()
    api.patchCustomer.mockResolvedValue({ ...customer, apEmail: 'ap@acme.com' })
    api.moveToManualInvoice.mockResolvedValue({ proNumber: '14700', orderId: 'o1', customerId: 'c1', voidedInvoice: null, note: '' })
    api.generateInvoice.mockResolvedValue({ invoice: { id: 'inv1', number: '14700', customerId: 'c1', shipmentId: 's1' }, gate: {} })
    api.getShipment.mockResolvedValue({ id: 's1' })
    render(<FixAndInvoiceDialog item={dead} customers={[customer]} isAdmin onClose={() => {}} onChanged={onChanged} />)

    // Step 2 and 3 wait for step 1.
    expect(screen.getByTestId('fix-move-manual')).toBeDisabled()
    expect(screen.getByTestId('fix-create-invoice')).toBeDisabled()

    // An AP e-mail is required.
    fireEvent.click(screen.getByTestId('fix-save-customer'))
    expect(screen.getByRole('alert')).toHaveTextContent('AP e-mail')
    expect(api.patchCustomer).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('AP e-mail'), { target: { value: 'ap@acme.com' } })
    fireEvent.keyDown(screen.getByLabelText('AP e-mail'), { key: 'Enter' })
    fireEvent.click(screen.getByTestId('fix-save-customer'))
    await waitFor(() => expect(api.patchCustomer).toHaveBeenCalledWith('c1', expect.objectContaining({
      apEmail: 'ap@acme.com', paymentTermsDays: 30, changeSource: 'Factoring · OTR rejected',
    }), '2026-11-01T00:00:00Z'))

    await waitFor(() => expect(screen.getByTestId('fix-move-manual')).not.toBeDisabled())
    fireEvent.click(screen.getByTestId('fix-move-manual'))
    await waitFor(() => expect(api.moveToManualInvoice).toHaveBeenCalledWith({ factoringItemId: 'fi1' }))

    await waitFor(() => expect(screen.getByTestId('fix-create-invoice')).not.toBeDisabled())
    fireEvent.click(screen.getByTestId('fix-create-invoice'))
    await waitFor(() => expect(api.generateInvoice).toHaveBeenCalledWith({ orderId: 'o1' }))

    fireEvent.click(await screen.findByTestId('fix-send-now'))
    expect(screen.getByTestId('send-review')).toHaveTextContent('14700')
    // The review sees the customer as Manual invoice now, so it prints our remit-to and e-mails their AP.
    const passed = carousel.mock.calls.at(-1)![0].customerById.get('c1')
    expect(passed).toMatchObject({ billingMethod: 'MANUAL', factored: false })
    expect(onChanged).toHaveBeenCalled()
  })
  it('says it plainly when the customer save is refused, never a raw validation message', async () => {
    api.patchCustomer.mockRejectedValue(new Error('A field was missing from the save'))
    render(<FixAndInvoiceDialog item={dead} customers={[customer]} isAdmin onClose={() => {}} onChanged={() => {}} />)
    fireEvent.change(screen.getByLabelText('AP e-mail'), { target: { value: 'ap@acme.com' } })
    fireEvent.keyDown(screen.getByLabelText('AP e-mail'), { key: 'Enter' })
    fireEvent.click(screen.getByTestId('fix-save-customer'))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('missing'))
    expect(screen.getByTestId('fix-move-manual')).toBeDisabled()
  })
})
