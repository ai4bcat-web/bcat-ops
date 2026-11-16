// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
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

  describe('sorting and filtering', () => {
    const big = buildAgingReport([
      inv({ id: 'z', number: 'Z', customerId: 'cz', customerName: 'Zeta', balanceCents: 90000, totalCents: 90000 }),
      inv({ id: 'm', number: 'M', customerId: 'cm', customerName: 'Mid', invoiceDate: '2026-07-01', dueAt: '2026-07-31', balanceCents: 5000, totalCents: 5000 }),
      inv({ id: 'a', number: 'A', customerId: 'ca', customerName: 'Alpha', balanceCents: 1000, totalCents: 1000 }),
    ], '2026-11-15')
    const draw = () => render(<AgingReportTable report={big} onOpenInvoice={vi.fn()} onPreview={vi.fn()} onStatement={vi.fn()} selected={[]} onSelect={vi.fn()} busy={false} />)
    const names = () => within(screen.getByRole('table', { name: 'Aging by customer' })).getAllByTestId('aging-customer-row').map((r) => r.textContent ?? '')
    beforeEach(() => { try { window.localStorage.clear() } catch { /* jsdom */ } })

    it('defaults to customer A→Z', () => {
      draw()
      const n = names()
      expect(n[0]).toContain('Alpha'); expect(n[1]).toContain('Mid'); expect(n[2]).toContain('Zeta')
    })

    it('sorts by a bucket when its header is clicked', () => {
      draw()
      fireEvent.click(screen.getByTitle('Sort by 90+'))
      expect(names()[0]).toContain('Mid')
    })

    it('filters to customers with 90+ and the totals follow the filter', () => {
      draw()
      fireEvent.click(screen.getByTestId('aging-has-D91_PLUS'))
      expect(names()).toHaveLength(1)
      expect(names()[0]).toContain('Mid')
      const total = screen.getByTestId('aging-total-row').textContent ?? ''
      expect(total).toContain('$50.00')
      expect(total).toContain('Filtered total')
      expect(screen.getByTestId('aging-filtered-note').textContent).toContain('$960.00')
      fireEvent.click(screen.getByTestId('aging-reset'))
      expect(names()).toHaveLength(3)
    })

    it('searches by customer and past due only', () => {
      draw()
      fireEvent.change(screen.getByLabelText('Search the aging report'), { target: { value: 'zet' } })
      expect(names()).toHaveLength(1)
      fireEvent.change(screen.getByLabelText('Search the aging report'), { target: { value: '' } })
      fireEvent.click(screen.getByTestId('aging-past-due-only'))
      expect(names().map((n) => n.includes('Mid'))).toEqual([true])
    })
  })
})
