// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('@/lib/apiClient', () => ({
  graphqlErrorText: (e: unknown) => String(e),
  listOpenInvoices: vi.fn(async () => [
    { id: 'a', number: 'A', shipmentNumber: '20001', customerId: 'c1', customerName: 'Acme Foods', status: 'ISSUED', invoiceDate: '2026-10-01', dueAt: '2026-10-31', termsDays: 30, totalCents: 100_00, paidCents: 0, balanceCents: 100_00 },
  ]),
  listInvoicesByMonth: vi.fn(async () => []),
  listArPayments: vi.fn(async () => []),
  listApPayments: vi.fn(async () => []),
  listOpenBills: vi.fn(async () => []),
  listBillsByMonth: vi.fn(async () => []),
  listFinanceReviewShipments: vi.fn(async () => []),
}))
vi.mock('@/lib/reportsClient', () => ({ loadSamples: vi.fn(async () => ({ rows: [], months: [], failedMonths: [] })) }))
const downloadCsv = vi.fn()
vi.mock('@/lib/directoryCsv', () => ({ downloadCsv: (...a: unknown[]) => downloadCsv(...a) }))

import { AccountingReportsDialog } from './AccountingReportsDialog'

describe('AccountingReportsDialog', () => {
  it('lists the AR reports, runs one into a preview and downloads the CSV', async () => {
    render(<AccountingReportsDialog side="AR" asOf="2026-11-14" onClose={() => {}} />)
    const select = screen.getByRole('combobox', { name: 'Report' }) as HTMLSelectElement
    expect([...select.options].map((o) => o.textContent)).toContain('Payments received')
    expect([...select.options].map((o) => o.textContent)).not.toContain('Bills paid')
    fireEvent.click(screen.getByTestId('report-run'))
    await waitFor(() => expect(screen.getByTestId('report-count').textContent).toContain('1 row'))
    expect(screen.getByTestId('report-preview').textContent).toContain('Acme Foods')
    fireEvent.click(screen.getByTestId('report-download'))
    expect(downloadCsv).toHaveBeenCalledWith('ar-aging-by-customer-2026-11-14.csv', expect.stringContaining('Acme Foods'))
  })

  it('opens on the report a card linked to', () => {
    render(<AccountingReportsDialog side="AP" asOf="2026-11-14" initialKind="carrierPaidNotBilled" onClose={() => {}} />)
    expect((screen.getByRole('combobox', { name: 'Report' }) as HTMLSelectElement).value).toBe('carrierPaidNotBilled')
  })

  it('shows the AP reports on Payable', () => {
    render(<AccountingReportsDialog side="AP" asOf="2026-11-14" onClose={() => {}} />)
    const select = screen.getByRole('combobox', { name: 'Report' }) as HTMLSelectElement
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'AP aging by carrier', 'Open bills', 'Bills paid', 'Expected carrier cost (not yet billed)', 'Margin by load (internal)',
      'Customer paid, carrier unpaid', 'Carrier paid, not billed', 'Needs review list',
    ])
  })
})
