// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { OtrOffsetChip } from './OtrOffsetChip'
import { buildAgingReport } from '../agingReport'
import type { InvoiceRecord, OtrOffsetFlag } from '@/types/tms'

const flag: OtrOffsetFlag = { flaggedAt: '2026-11-27T16:00:00.000Z', flaggedBy: 'ryne@bcatcorp.com', note: 'OTR said the customer paid us directly' }

describe('OtrOffsetChip', () => {
  it('draws nothing without a flag', () => {
    const { container } = render(<OtrOffsetChip flag={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the chip with what OTR said, who recorded it and when', () => {
    render(<OtrOffsetChip flag={flag} />)
    const chip = screen.getByTestId('otr-offset-chip')
    expect(chip).toHaveTextContent('OTR offset')
    expect(chip.getAttribute('title')).toContain('ryne@bcatcorp.com · 2026-11-27')
    expect(chip.getAttribute('title')).toContain('OTR said the customer paid us directly')
  })
})

describe('the OTR offset flag stays internal', () => {
  const inv = (id: string, otrOffset?: OtrOffsetFlag): InvoiceRecord => ({
    id, number: id, orderId: `o${id}`, shipmentId: `s${id}`, shipmentNumber: id, customerId: 'c1', customerName: 'Acme', status: 'ISSUED',
    invoiceDate: '2026-09-30', issuedAt: '2026-09-30T12:00:00Z', issuedBy: 'x', dueAt: '2026-10-30', termsDays: 30, invoiceMonth: '2026-09',
    subtotalCents: 50000, totalCents: 50000, paidCents: 0, writtenOffCents: 0, balanceCents: 50000, createdBy: 'x', updatedBy: 'x', version: 1,
    ...(otrOffset ? { otrOffset } : {}),
  }) as InvoiceRecord

  it('carries onto the aging invoice rows', () => {
    const report = buildAgingReport([inv('14178', flag), inv('14179')], new Date('2026-11-27T12:00:00Z'), {})
    const rows = report.customers.flatMap((c) => c.invoices)
    expect(rows.find((r) => r.id === '14178')?.otrOffset).toEqual(flag)
    expect(rows.find((r) => r.id === '14179')?.otrOffset).toBeNull()
  })

  // Nothing a customer sees may read the flag: invoice PDF and e-mail, past-due reminder, customer statement.
  it.each([
    'src/lib/invoicePdf.ts',
    'src/lib/agingStatement.ts',
    'src/lib/agingStatementPdf.ts',
    'src/lib/pastDueReminder.ts',
    'amplify/functions/tms-finance-actions/pastDueReminder.ts',
    'amplify/functions/tms-finance-actions/statements.ts',
    'amplify/functions/tms-finance-actions/invoicePacket.ts',
  ])('%s never reads otrOffset', (file) => {
    expect(readFileSync(file, 'utf8')).not.toMatch(/otrOffset|OTR offset/i)
  })
})
