// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { ArQueueRow } from '../arQueue'

const { previewOtrDocs, submitToOtr, batchGenerateInvoices, sendToFactor } = vi.hoisted(() => ({
  previewOtrDocs: vi.fn(), submitToOtr: vi.fn(), batchGenerateInvoices: vi.fn(), sendToFactor: vi.fn(),
}))
vi.mock('@/lib/otrClient', () => ({ previewOtrDocs, submitToOtr, uploadOtrDocs: vi.fn() }))
vi.mock('@/lib/apiClient', () => ({ batchGenerateInvoices, sendToFactor }))
vi.mock('../batchFactor', async (orig) => ({ ...(await orig<typeof import('../batchFactor')>()), sleep: () => () => Promise.resolve() }))
vi.mock('./InvoicePacketFrame', () => ({ InvoicePacketFrame: ({ invoiceId }: { invoiceId: string }) => <div data-testid="invoice-frame">{invoiceId}</div> }))
import { BatchFactorDialog } from './BatchFactorDialog'

const row = (pro: string, cents: number): ArQueueRow => ({
  key: `order:${pro}`, orderId: `o-${pro}`, shipmentNumber: pro, invoiceId: `inv-${pro}`, customerName: `Customer ${pro}`, amountCents: cents, factorItem: null,
} as unknown as ArQueueRow)
const docs = (pro: string, have: { pod?: boolean; rc?: boolean } = { pod: true, rc: true }) => ({
  pro, found: true,
  pod: have.pod === false ? null : { name: `POD-${pro}.pdf`, url: `https://s3.test/pod-${pro}` },
  rateCon: have.rc === false ? null : { name: `RC-${pro}.pdf`, url: `https://s3.test/rc-${pro}` },
})

const setup = (rows: ArQueueRow[]) => render(<BatchFactorDialog rows={rows} factorName="OTR Capital, LLC" onClose={() => {}} onDone={() => {}} />)

beforeEach(() => {
  vi.clearAllMocks()
  sendToFactor.mockResolvedValue({ factoringItem: { id: 'f1' } })
  submitToOtr.mockResolvedValue({ invoiceId: 555, documentErrors: [] })
  previewOtrDocs.mockImplementation(async ({ pro }: { pro: string }) => docs(pro))
})

describe('BatchFactorDialog review step', () => {
  it('shows the rate confirmation and the POD page by page and sends nothing before Send', async () => {
    setup([row('1001', 100_000), row('1002', 200_000)])
    expect(await screen.findByTitle('POD preview')).toBeTruthy()
    expect(screen.getByTitle('Customer rate confirmation preview').getAttribute('src')).toBe('https://s3.test/rc-1001')
    expect(screen.getByLabelText('Page').textContent).toBe('1 of 2')
    fireEvent.click(screen.getByLabelText('Next load'))
    await waitFor(() => expect(screen.getByTitle('POD preview').getAttribute('src')).toBe('https://s3.test/pod-1002'))
    expect(screen.getByLabelText('Page').textContent).toBe('2 of 2')
    expect(previewOtrDocs).toHaveBeenCalledWith({ pro: '1002' })
    expect(submitToOtr).not.toHaveBeenCalled()
    expect(batchGenerateInvoices).not.toHaveBeenCalled()
  })

  it('shows the invoice and keeps Factor off until every load has been looked at; Cancel submits nothing', async () => {
    const onClose = vi.fn()
    render(<BatchFactorDialog rows={[row('1001', 100_000), row('1002', 200_000)]} factorName="OTR Capital, LLC" onClose={onClose} onDone={() => {}} />)
    await screen.findByTitle('POD preview')
    expect(screen.getByTestId('invoice-frame').textContent).toBe('inv-1001')
    const factor = screen.getByTestId('batch-factor-submit') as HTMLButtonElement
    expect(factor.disabled).toBe(true)
    expect(factor.textContent).toBe('Factor 2 (1 not viewed)')
    fireEvent.click(factor)
    expect(submitToOtr).not.toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText('Next load'))
    await waitFor(() => expect(factor.disabled).toBe(false))
    expect(factor.textContent).toBe('Factor 2 invoices')
    expect(submitToOtr).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Cancel'))
    expect(onClose).toHaveBeenCalled()
    expect(submitToOtr).not.toHaveBeenCalled()
    expect(batchGenerateInvoices).not.toHaveBeenCalled()
  })

  it('flags a load with no POD and leaves it out of the send', async () => {
    previewOtrDocs.mockImplementation(async ({ pro }: { pro: string }) => docs(pro, { pod: pro !== '1002', rc: true }))
    setup([row('1001', 100_000), row('1002', 200_000)])
    await screen.findByTitle('POD preview')
    fireEvent.click(screen.getByLabelText('Next load'))
    expect((await screen.findByRole('alert', { name: 'Cannot send' })).textContent).toMatch(/no POD on file/)
    fireEvent.click(screen.getByLabelText('Previous load'))
    await waitFor(() => expect((screen.getByTestId('batch-factor-submit') as HTMLButtonElement).disabled).toBe(false))
    expect(screen.getByTestId('batch-factor-submit').textContent).toBe('Factor 1 invoice')
    fireEvent.click(screen.getByTestId('batch-factor-submit'))
    expect(await screen.findByTestId('batch-factor-results')).toBeTruthy()
    expect(submitToOtr).toHaveBeenCalledTimes(1)
  })

  it('Skip takes a load out of the batch', async () => {
    setup([row('1001', 100_000), row('1002', 200_000)])
    await screen.findByTitle('POD preview')
    fireEvent.click(screen.getByLabelText('Skip 1001'))
    expect(screen.getByLabelText('Page').textContent).toBe('1 of 1')
    expect(screen.getByTestId('batch-factor-submit').textContent).toBe('Factor 1 invoice')
  })

  it('a queue row is previewed by its row id', async () => {
    const r = { ...row('1003', 100_000), factorItem: { id: 'fi-9', status: 'NEED_TO_FACTOR' } } as unknown as ArQueueRow
    previewOtrDocs.mockResolvedValue(docs('1003'))
    setup([r])
    await screen.findByTitle('POD preview')
    expect(previewOtrDocs).toHaveBeenCalledWith({ id: 'fi-9' })
  })

  it('a preview that fails does not block a load that was already ready to factor', async () => {
    previewOtrDocs.mockRejectedValue(new Error('boom'))
    setup([row('1001', 100_000)])
    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not load the documents/)
    expect((screen.getByTestId('batch-factor-submit') as HTMLButtonElement).disabled).toBe(false)
  })
})
