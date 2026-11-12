import { describe, it, expect } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { AGING_STATEMENT_EMAIL_BODY, agingStatementEmail, agingStatementFilename, buildAgingStatement } from './agingStatement'
import { buildAgingStatementPdf } from './agingStatementPdf'
import type { InvoiceRecord } from '@/types/tms'

const inv = (over: Partial<InvoiceRecord>): InvoiceRecord => ({
  id: 'i', number: '20027', orderId: 'o', shipmentId: 's1', shipmentNumber: '20027', customerId: 'c', status: 'ISSUED',
  invoiceDate: '2026-11-01', issuedAt: '2026-11-01T12:00:00Z', issuedBy: 'x', dueAt: '2026-12-01', termsDays: 30,
  invoiceMonth: '2026-11', subtotalCents: 100_000, totalCents: 100_000, paidCents: 0, writtenOffCents: 0, balanceCents: 100_000,
  createdBy: 'x', updatedBy: 'x', version: 1,
  references: [{ code: 'PO', value: 'FR-1', level: 'ORDER', visibility: 'CUSTOMER' }],
  ...over,
})

describe('aging statement', () => {
  const statement = buildAgingStatement({
    customerName: 'The Royal Group',
    asOf: '2026-12-15',
    invoices: [
      inv({ id: 'a' }),
      inv({ id: 'b', number: '19990', shipmentNumber: '19990', shipmentId: 's2', invoiceDate: '2026-08-01', totalCents: 50_000, paidCents: 20_000, balanceCents: 30_000, status: 'PARTIAL' }),
      inv({ id: 'c', status: 'PAID', balanceCents: 0 }),
    ],
    shipmentsById: new Map([['s1', { revDivision: 'BROKERAGE' }], ['s2', { revDivision: 'ASSETS' }]]),
  })

  it('ages every open invoice from its invoice date and totals the buckets', () => {
    expect(statement.rows.map((r) => [r.pro, r.po, r.days, r.bucket])).toEqual([
      ['19990', 'FR-1', 136, 'D91_PLUS'],
      ['20027', 'FR-1', 44, 'D31_60'],
    ])
    expect(statement.byBucket).toEqual({ D1_30: 0, D31_60: 100_000, D61_90: 0, D91_PLUS: 30_000 })
    expect(statement.totalCents).toBe(130_000)
    // Mixed divisions read as BCAT Logistics.
    expect(statement.companyName).toBe('BCAT Logistics Corporation')
  })

  it("uses Ryne's body word for word and names the customer, date and company", () => {
    const email = agingStatementEmail(statement)
    expect(email.body).toBe('Hi, please find your aging report attached. Please advise when payment will be issued.')
    expect(email.body).toBe(AGING_STATEMENT_EMAIL_BODY)
    expect(email.subject).toBe('Aging report — The Royal Group — 12/15/2026 — BCAT Logistics Corporation')
    expect(agingStatementFilename('The Royal Group', '2026-12-15')).toBe('Aging report The Royal Group 2026-12-15.pdf')
  })

  it('renders a PDF and the e-mail carries no carrier pay, cost or margin', async () => {
    const bytes = await buildAgingStatementPdf(statement)
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1)
    const { subject, body } = agingStatementEmail(statement)
    expect(`${subject} ${body}`).not.toMatch(/carrier pay|cost|margin/i)
  })
})
