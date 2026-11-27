/**
 * The AUTO SHIPPER customer is never factored (Ryne 2026-11-27): its payer pays BCAT directly through Square or by hand.
 * One helper decides who counts; every place that asks "is this factored?" must agree, whatever an old import left on the flag.
 */
import { describe, it, expect } from 'vitest'
import { isAutoShipperCustomer, isAutoShipperName, customerFactorsForOtr } from './reviewRequirements'
import { isFactorBilled, isFactoredLoad } from './factorBilling'
import { invoiceIsFactored } from './invoiceBuild'
import { whyNotFactorable } from './factorHandoff'
import { isFactoredInvoice as agingIsFactored } from './agingStatement'
import { isFactoredInvoice as paymentsIsFactored } from '../features/payments/outstanding'
import { isFactoredInvoice as sendReviewIsFactored } from '../features/ar/sendReview'
import type { CustomerRecord, InvoiceRecord } from '../types/tms'

const AUTO = { name: 'AUTO SHIPPER', billingMethod: 'FACTOR' as const, factored: true }
const FACTORED_OTHER = { name: 'Acme Logistics', billingMethod: 'FACTOR' as const, factored: true }

describe('who counts as the auto shipper', () => {
  it('matches the name loosely and the Square channel exactly', () => {
    expect(isAutoShipperName(' auto  shipper ')).toBe(true)
    expect(isAutoShipperName('AUTO SHIPPERS INC')).toBe(false)
    expect(isAutoShipperName(null)).toBe(false)
    expect(isAutoShipperCustomer({ name: 'Anything', invoiceChannel: 'SQUARE' })).toBe(true)
    expect(isAutoShipperCustomer({ name: 'Acme Logistics', invoiceChannel: null })).toBe(false)
    expect(isAutoShipperCustomer(null)).toBe(false)
  })
})

describe('the factoring rules say no for it, and still yes for everyone else', () => {
  it('customer and load level', () => {
    expect(isFactorBilled(AUTO)).toBe(false)
    expect(isFactoredLoad(AUTO, 'CAR_SHIPPING')).toBe(false)
    expect(customerFactorsForOtr(AUTO, null)).toBe(false)
    expect(isFactorBilled(FACTORED_OTHER)).toBe(true)
    expect(isFactoredLoad(FACTORED_OTHER, null)).toBe(true)
  })

  it('an invoice with a stale factored flag prints and counts as manual', () => {
    expect(invoiceIsFactored({ factored: true }, AUTO, null)).toBe(false)
    expect(invoiceIsFactored({ factored: true }, FACTORED_OTHER, null)).toBe(true)
  })

  it('the Payments Received Type, the aging statement and the send review all read Manual', () => {
    const stale = { factored: true, factoringItemId: null, customerName: 'AUTO SHIPPER' }
    expect(paymentsIsFactored(stale)).toBe(false)
    expect(agingIsFactored(stale)).toBe(false)
    expect(sendReviewIsFactored({ ...stale } as unknown as InvoiceRecord, AUTO as unknown as CustomerRecord)).toBe(false)
    expect(sendReviewIsFactored({ ...stale, customerName: 'AUTO SHIPPER' } as unknown as InvoiceRecord, undefined)).toBe(false)
    const other = { factored: true, factoringItemId: null, customerName: 'Acme Logistics' }
    expect(paymentsIsFactored(other)).toBe(true)
    expect(agingIsFactored(other)).toBe(true)
  })

  it('Send to Factor says why not, in plain words', () => {
    const refusal = whyNotFactorable({
      invoice: { status: 'ISSUED', number: '1', id: '1' } as never,
      order: {} as never,
      shipment: { number: 'S1', status: 'DELIVERED' } as never,
      customer: { ...AUTO, mcNumber: '123' } as never,
      load: null,
      existingRow: null,
      factorRemitToName: 'OTR Solutions',
    })
    expect(refusal).toMatch(/auto shipper invoices are never factored/i)
  })
})
