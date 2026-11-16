// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { AgingReportTable } from './AgingReportTable'
import { buildAgingReport } from '../agingReport'
import type { InvoiceRecord } from '@/types/tms'

const inv = (over: Partial<InvoiceRecord>): InvoiceRecord => ({
  id: 'i', number: '1', customerId: 'c1', customerName: 'Acme', shipmentId: 's', shipmentNumber: '100',
  status: 'ISSUED', invoiceDate: '2026-11-01', dueAt: '2026-12-01', termsDays: 30,
  subtotalCents: 0, totalCents: 10000, paidCents: 0, writtenOffCents: 0, balanceCents: 10000, ...over,
} as InvoiceRecord)

describe('AgingReportTable', () => {
  const report = buildAgingReport([
    inv({ id: 'a', number: 'A', shipmentNumber: '14001' }),
    inv({ id: 'b', number: 'B', shipmentNumber: '14002', customerId: 'c2', customerName: 'Beta', balanceCents: 2500, totalCents: 2500 }),
  ], '2026-11-15')

  it('shows customers with amounts, expands to invoices, and totals the open balance', () => {
    const onPreview = vi.fn()
    const onOpenInvoice = vi.fn()
    render(<AgingReportTable report={report} onOpenInvoice={onOpenInvoice} onPreview={onPreview} onStatement={vi.fn()} selected={[]} onSelect={vi.fn()} busy={false} />)
    const table = screen.getByRole('table', { name: 'Aging by customer' })
    const rows = within(table).getAllByTestId('aging-customer-row')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('Acme')
    expect(rows[0].textContent).toContain('$100.00')
    expect(within(table).getByTestId('aging-total-row').textContent).toContain('$125.00')
    expect(within(table).queryAllByTestId('aging-invoice-row')).toHaveLength(0)

    fireEvent.click(within(table).getByRole('button', { name: 'Expand Acme' }))
    const invRows = within(table).getAllByTestId('aging-invoice-row')
    expect(invRows).toHaveLength(1)
    fireEvent.click(within(invRows[0]).getByRole('button', { name: 'Open invoice A' }))
    expect(onOpenInvoice).toHaveBeenCalledWith('a')

    fireEvent.click(screen.getByRole('button', { name: 'Expand all customers' }))
    expect(within(table).getAllByTestId('aging-invoice-row')).toHaveLength(2)

    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Preview aging email for Acme' }))
    expect(onPreview).toHaveBeenCalledWith('c1', 'Acme')
  })
})
