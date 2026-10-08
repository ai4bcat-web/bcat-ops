// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { FactoringItem } from '@/types'

const api = { setManualStep: vi.fn(), setApEmail: vi.fn(), returnToOtrQueue: vi.fn() }
vi.mock('@/lib/otrClient', () => api)
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const { ManualInvoicePanel } = await import('./ManualInvoicePanel')

function item(over: Partial<FactoringItem> = {}): FactoringItem {
  return {
    id: '14529', proNumber: '14529', status: 'MANUAL_INVOICE', manualReason: 'NO_BUY',
    brokerMcChecked: '592002', brokerCheckResult: 'NO_BUY',
    otrReadiness: { customerName: 'Fox Transportation Services (IL)' },
    subject: '', fromEmail: '', receivedAt: '', messageId: '', createdAt: '', updatedAt: '',
    ...over,
  } as FactoringItem
}

beforeEach(() => vi.clearAllMocks())

describe('ManualInvoicePanel', () => {
  it('says why, lists the three steps in order, and shows progress', () => {
    render(<ManualInvoicePanel item={item()} onChanged={vi.fn()} />)
    expect(screen.getByText(/OTR will not buy from Fox Transportation Services \(IL\)/)).toBeInTheDocument()
    expect(screen.getByText('0 of 3 steps done')).toBeInTheDocument()
    const boxes = screen.getAllByRole('checkbox')
    expect(boxes.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Step 1: Update the bill-to in Aljex',
      'Step 2: Export the invoice PDF',
      'Step 3: Email the PDF to the AP contact',
    ])
    expect(screen.getByText(/cc invoices@bcatcorp.com/)).toBeInTheDocument()
  })

  it('ticks a step through the API and refreshes', async () => {
    api.setManualStep.mockResolvedValue({ status: 'MANUAL_INVOICE', progress: { done: 1, total: 3, complete: false } })
    const onChanged = vi.fn()
    render(<ManualInvoicePanel item={item()} onChanged={onChanged} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /Step 1/ }))
    await waitFor(() => expect(api.setManualStep).toHaveBeenCalledWith('14529', 'billToUpdated', true))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('shows who did a step and when, and names the AP address on the email step', () => {
    render(<ManualInvoicePanel item={item({
      apEmail: 'ap@foxtransportation.com',
      manualSteps: { billToUpdated: { at: '2026-10-08T16:00:00Z', by: 'jenny@bcatcorp.com' } },
    })} onChanged={vi.fn()} />)
    expect(screen.getByText('1 of 3 steps done')).toBeInTheDocument()
    expect(screen.getByText(/jenny@bcatcorp.com/)).toBeInTheDocument()
    expect(screen.getByText('ap@foxtransportation.com')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Open email/ }).getAttribute('href')).toContain('cc=invoices%40bcatcorp.com')
  })

  it('reads as finished once every step is marked', () => {
    const mark = { at: '2026-10-08T16:00:00Z', by: 'ryne@bcatcorp.com' }
    render(<ManualInvoicePanel item={item({
      status: 'INVOICED_MANUALLY', manualInvoicedAt: '2026-10-08T17:00:00Z',
      manualSteps: { billToUpdated: mark, pdfExported: mark, emailed: mark },
    })} onChanged={vi.fn()} />)
    expect(screen.getByText(/^Invoiced manually/)).toBeInTheDocument()
    expect(screen.getAllByRole('checkbox').every((b) => (b as HTMLInputElement).checked)).toBe(true)
  })

  it('saves the AP email and can send the row back to the OTR queue', async () => {
    api.setApEmail.mockResolvedValue({ apEmail: 'ap@x.com' })
    api.returnToOtrQueue.mockResolvedValue({ status: 'NEED_TO_FACTOR' })
    render(<ManualInvoicePanel item={item()} onChanged={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Broker AP email'), { target: { value: 'ap@x.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.setApEmail).toHaveBeenCalledWith('14529', 'ap@x.com'))
    fireEvent.click(screen.getByRole('button', { name: /Send back to OTR queue/ }))
    await waitFor(() => expect(api.returnToOtrQueue).toHaveBeenCalledWith('14529'))
  })
})
