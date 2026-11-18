import { describe, it, expect } from 'vitest'
import { factorItemWasSubmitted, isInvoiceSentToCustomerOrFactor, isOutstandingInvoice } from './invoiceOutstanding'

describe('an invoice is outstanding while it is ISSUED or PARTIAL with a balance', () => {
  it('counts issued and partial invoices with money still owed', () => {
    expect(isOutstandingInvoice({ status: 'ISSUED', balanceCents: 100 })).toBe(true)
    expect(isOutstandingInvoice({ status: 'PARTIAL', balanceCents: 100 })).toBe(true)
  })
  it('does not count paid, void or empty balances', () => {
    expect(isOutstandingInvoice({ status: 'PAID', balanceCents: 0 })).toBe(false)
    expect(isOutstandingInvoice({ status: 'VOID', balanceCents: 0 })).toBe(false)
    expect(isOutstandingInvoice({ status: 'ISSUED', balanceCents: 0 })).toBe(false)
  })
})

describe('an invoice that went out stays sent, whatever OTR does to its queue row afterwards', () => {
  // Every OTR outcome the queue row can end up in after the invoice was handed over.
  const outcomes: Array<[string, Parameters<typeof isInvoiceSentToCustomerOrFactor>[1]]> = [
    ['waiting on OTR', { status: 'PENDING_WITH_OTR', otrInvoiceId: '1' }],
    ['funded', { status: 'FACTORED', otrInvoiceId: '1' }],
    ['marked Dead by OTR', { status: 'PENDING_WITH_OTR', otrInvoiceId: '1', otrSubmittedAt: '2026-11-17T00:00:00Z' }],
    ['Duplicate at OTR', { status: 'PENDING_WITH_OTR', otrInvoiceId: '2' }],
    ['reset to Need to factor after a send (OTR fields cleared, history kept)', { status: 'NEED_TO_FACTOR', otrInvoiceId: null, otrSubmittedAt: null, otrPriorInvoices: [{ otrInvoiceId: '1', replacedAt: 'x', replacedBy: 'y' }] }],
    ['sent again with a new OTR invoice', { status: 'PENDING_WITH_OTR', otrInvoiceId: '3', otrPriorInvoices: [{ otrInvoiceId: '1', replacedAt: 'x', replacedBy: 'y' }] }],
    ['archived after OTR refused it', { status: 'ARCHIVED', otrInvoiceId: '1', otrSubmittedAt: '2026-11-17T00:00:00Z' }],
    ['moved to manual after OTR refused it', { status: 'MANUAL_INVOICE', otrSubmittedAt: '2026-11-17T00:00:00Z' }],
  ]
  it.each(outcomes)('%s', (_name, item) => {
    expect(factorItemWasSubmitted(item)).toBe(true)
    expect(isInvoiceSentToCustomerOrFactor({}, item)).toBe(true)
  })

  it('remembers the OTR leg on the invoice itself once the queue row is gone', () => {
    expect(isInvoiceSentToCustomerOrFactor({ factorSubmittedAt: '2026-11-17T00:00:00Z' }, null)).toBe(true)
    expect(isInvoiceSentToCustomerOrFactor({ factorSubmittedAt: '2026-11-17T00:00:00Z' }, { status: 'ARCHIVED' })).toBe(true)
  })

  it('every way of sending to the customer counts', () => {
    expect(isInvoiceSentToCustomerOrFactor({ sentAt: '2026-11-17T00:00:00Z' })).toBe(true)
    expect(isInvoiceSentToCustomerOrFactor({ markedSentAt: '2026-11-17T00:00:00Z' })).toBe(true)
    expect(isInvoiceSentToCustomerOrFactor({ sentCount: 1 })).toBe(true)
  })

  it('a genuine draft is still a draft: never sent, never handed to OTR', () => {
    expect(isInvoiceSentToCustomerOrFactor({ sentCount: 0 }, null)).toBe(false)
    expect(isInvoiceSentToCustomerOrFactor({}, { status: 'NEED_TO_FACTOR' })).toBe(false)
    expect(isInvoiceSentToCustomerOrFactor({}, { status: 'ARCHIVED' })).toBe(false)
  })
})
