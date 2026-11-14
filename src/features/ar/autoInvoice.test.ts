import { describe, expect, it } from 'vitest'
import { billsThroughOtr, isQueueOnlyRow, ordersNeedingInvoice, unsentLabel } from './autoInvoice'
import type { FactoringItem, InvoiceRecord } from '@/types/tms'

describe('factored rows are never e-mailed (Ryne 2026-11-14)', () => {
  it('bills through OTR when the row is factored or the customer is factor-billed, not when manual', () => {
    expect(billsThroughOtr({ factored: true }, undefined)).toBe(true)
    expect(billsThroughOtr({ factored: false }, { billingMethod: 'FACTOR' })).toBe(true)
    expect(billsThroughOtr({ factored: false }, { billingMethod: 'MANUAL', factored: true })).toBe(false)
    expect(billsThroughOtr({ factored: false }, null)).toBe(false)
  })

  it('reads "Factored via OTR" before the queue, "In OTR queue" after, and "Not sent" only for manual invoices', () => {
    const invoice = { id: 'inv-1', factoringItemId: null } as unknown as InvoiceRecord
    expect(unsentLabel({ invoiceId: 'inv-1', invoice, factorItem: null }, true)).toBe('Factored via OTR')
    expect(unsentLabel({ invoiceId: 'inv-1', invoice: { ...invoice, factoringItemId: 'fi-1' }, factorItem: null }, true)).toBe('In OTR queue')
    expect(unsentLabel({ invoiceId: null, invoice: null, factorItem: { id: 'fi-1' } as FactoringItem }, true)).toBe('In OTR queue')
    expect(unsentLabel({ invoiceId: 'inv-1', invoice, factorItem: null }, false)).toBe('Not sent')
    expect(unsentLabel({ invoiceId: null, invoice: null, factorItem: null }, false)).toBe('—')
  })
})

const inv = { id: 'inv-1' } as InvoiceRecord

describe('ordersNeedingInvoice', () => {
  it('lists Ready to invoice orders with no invoice yet', () => {
    expect(ordersNeedingInvoice([{ orderId: 'o1', invoice: null }, { orderId: 'o2', invoice: inv }], new Set())).toEqual(['o1'])
  })

  it('skips factoring queue rows, which have no order to invoice', () => {
    expect(ordersNeedingInvoice([{ orderId: 'factor:fi-1', invoice: null }], new Set())).toEqual([])
    expect(isQueueOnlyRow({ orderId: 'factor:fi-1' })).toBe(true)
  })

  it('asks once per order: an attempted order is not asked again (its refusal shows on the row)', () => {
    expect(ordersNeedingInvoice([{ orderId: 'o1', invoice: null }], new Set(['o1']))).toEqual([])
  })

  it('leaves a row that already says what is missing (the server would refuse it the same way)', () => {
    expect(ordersNeedingInvoice([{ orderId: 'o1', invoice: null, reasons: ['The POD has not been accepted yet.'] }], new Set())).toEqual([])
  })

  it('never lists an order twice', () => {
    expect(ordersNeedingInvoice([{ orderId: 'o1', invoice: null }, { orderId: 'o1', invoice: null }], new Set())).toEqual(['o1'])
  })
})
