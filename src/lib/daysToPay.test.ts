import { describe, expect, it } from 'vitest'
import { customerDaysToPay, paymentLinesByInvoice, settlementOf } from './daysToPay'
import type { ArPaymentRecord, InvoiceRecord } from '@/types/tms'

const inv = (id: string, patch: Partial<InvoiceRecord> = {}): InvoiceRecord => ({
  id, number: id, customerId: 'c1', status: 'PAID', invoiceDate: '2026-10-01', balanceCents: 0, totalCents: 1000, paidCents: 1000,
  ...patch,
} as InvoiceRecord)
const pay = (id: string, receivedAt: string, applications: { invoiceId: string; amountCents: number }[], patch: Partial<ArPaymentRecord> = {}): ArPaymentRecord => ({
  id, customerId: 'c1', kind: 'PAYMENT', receivedAt, method: 'CHECK', reference: `#${id}`, amountCents: 0, appliedCents: 0, unappliedCents: 0,
  applications, createdBy: 'x', ...patch,
} as ArPaymentRecord)

describe('days to pay', () => {
  it('counts from the invoice date to the payment that settled it, not the partial before', () => {
    const payments = [
      pay('p1', '2026-10-11T12:00:00.000Z', [{ invoiceId: 'a', amountCents: 400 }], { method: 'ACH', reference: null }),
      pay('p2', '2026-10-31T12:00:00.000Z', [{ invoiceId: 'a', amountCents: 600 }]),
    ]
    const s = settlementOf(inv('a'), paymentLinesByInvoice(payments).get('a'))
    expect(s).toEqual({ paidOn: '2026-10-31', method: 'CHECK', reference: '#p2', daysToPay: 30 })
  })

  it('ignores a reversed receipt and falls back to paidAt with no cash rows', () => {
    const payments = [pay('p1', '2026-10-05T12:00:00.000Z', [{ invoiceId: 'a', amountCents: 1000 }], { reversedByPaymentId: 'r1' })]
    expect(paymentLinesByInvoice(payments).get('a')).toBeUndefined()
    expect(settlementOf(inv('a', { paidAt: '2026-10-21T15:00:00.000Z' }), undefined).daysToPay).toBe(20)
  })

  it('is nothing while a balance is open', () => {
    expect(settlementOf(inv('a', { status: 'PARTIAL', balanceCents: 500 }), []).paidOn).toBeNull()
  })

  it('averages a customer over their paid invoices only', () => {
    const invoices = [inv('a'), inv('b', { invoiceDate: '2026-10-10' }), inv('c', { status: 'ISSUED', balanceCents: 1000 })]
    const payments = [
      pay('p1', '2026-10-11T12:00:00.000Z', [{ invoiceId: 'a', amountCents: 1000 }]),
      pay('p2', '2026-10-31T12:00:00.000Z', [{ invoiceId: 'b', amountCents: 1000 }]),
    ]
    expect(customerDaysToPay(invoices, payments)).toEqual({ averageDays: 15.5, count: 2 })
  })
})
