// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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

  describe('last aging report', () => {
    const sentReport = buildAgingReport([
      inv({ id: 'a', number: 'A', customerName: 'Acme' }),
      inv({ id: 'b', number: 'B', customerId: 'c2', customerName: 'Beta' }),
      inv({ id: 'g', number: 'G', customerId: 'c3', customerName: 'Gamma' }),
    ], '2026-11-15', {
      lastStatementOf: (id) => (id === 'c1' ? { at: '2026-11-14T16:00:00Z', to: 'ap@acme.com' } : id === 'c2' ? { at: '2026-10-01T16:00:00Z', to: null } : null),
    })
    const draw = () => render(<AgingReportTable report={sentReport} onOpenInvoice={vi.fn()} onPreview={vi.fn()} onStatement={vi.fn()} selected={[]} onSelect={vi.fn()} busy={false} />)
    const rowOf = (name: string) => within(screen.getByRole('table', { name: 'Aging by customer' })).getAllByTestId('aging-customer-row').find((r) => (r.textContent ?? '').includes(name))!
    beforeEach(() => {
      try { window.localStorage.clear() } catch { /* jsdom */ }
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-11-17T18:00:00Z'))
    })
    afterEach(() => { vi.useRealTimers() })

    it('shows the day it went out, how long ago, and who got it on hover; Never when none was sent', () => {
      draw()
      const acme = within(rowOf('Acme')).getByTestId('aging-last-statement')
      expect(acme.textContent).toContain('Nov 14, 2026')
      expect(acme.textContent).toContain('3d ago')
      expect(acme.getAttribute('title')).toContain('sent to ap@acme.com')
      expect(within(rowOf('Gamma')).getByTestId('aging-last-statement').textContent).toBe('Never')
      expect(within(rowOf('Gamma')).getByTestId('aging-last-statement').getAttribute('title')).toBe('Never sent')
    })

    it('shows the same line when a customer is expanded', () => {
      draw()
      fireEvent.click(screen.getByRole('button', { name: 'Expand Acme' }))
      expect(screen.getByTestId('aging-last-statement-detail').textContent).toContain('sent to ap@acme.com')
    })

    it('the first click on the header lists never-sent customers first, the second the most recent', () => {
      draw()
      const order = () => within(screen.getByRole('table', { name: 'Aging by customer' })).getAllByTestId('aging-customer-row').map((r) => (r.textContent ?? '').slice(0, 5))
      fireEvent.click(screen.getByTitle('Sort by Last aging report'))
      expect(order()[0]).toContain('Gamma')
      fireEvent.click(screen.getByTitle('Sort by Last aging report'))
      expect(order()[0]).toContain('Acme')
    })

    it('filters to customers nobody has e-mailed, or not in 14+ days', () => {
      draw()
      fireEvent.change(screen.getByLabelText('Filter by last aging report sent'), { target: { value: 'never' } })
      expect(within(screen.getByRole('table', { name: 'Aging by customer' })).getAllByTestId('aging-customer-row')).toHaveLength(1)
      fireEvent.change(screen.getByLabelText('Filter by last aging report sent'), { target: { value: 'stale' } })
      const names = within(screen.getByRole('table', { name: 'Aging by customer' })).getAllByTestId('aging-customer-row').map((r) => r.textContent ?? '')
      expect(names).toHaveLength(2)
      expect(names.join(' ')).toContain('Beta')
      expect(names.join(' ')).toContain('Gamma')
    })
  })
})
