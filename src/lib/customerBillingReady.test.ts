import { customerApEmailRequired } from './reviewRequirements'
import { describe, expect, it } from 'vitest'
import { customerApEmails, customerBillingGaps, customerBillingSummary } from './customerBillingReady'

describe('customer billing readiness (Ryne 2026-11-16)', () => {
  it('needs a billing method and an AP e-mail, factored customers included', () => {
    expect(customerBillingGaps({ billingMethod: 'FACTOR', apEmail: 'ap@x.com' })).toEqual([])
    expect(customerBillingGaps({ billingMethod: 'FACTOR' })).toEqual(['CUSTOMER_AP_EMAIL'])
    expect(customerBillingGaps({ apEmail: 'ap@x.com' })).toEqual(['CUSTOMER_BILLING_METHOD'])
    expect(customerBillingGaps({ billingMethod: 'LEGACY', apEmail: 'nope' })).toEqual(['CUSTOMER_BILLING_METHOD', 'CUSTOMER_AP_EMAIL'])
    expect(customerBillingGaps(null)).toEqual([])
  })
  it('counts the extra AP e-mails and the legacy factored flag', () => {
    expect(customerBillingGaps({ factored: true, apEmailsExtra: [null, 'b@y.co'] })).toEqual([])
    expect(customerApEmails({ apEmail: ' a@x.com ', apEmailsExtra: ['bad', 'b@y.co'] })).toEqual(['a@x.com', 'b@y.co'])
  })
  it('summarizes for the Customer column', () => {
    expect(customerBillingSummary({ billingMethod: 'FACTOR', apEmail: 'ap@x.com' })).toBe('Factor · ap@x.com')
    expect(customerBillingSummary({ billingMethod: 'MANUAL' })).toBe('Manual invoice')
  })
})

describe('AP e-mail waiver (Ryne 2026-11-16: AUTO SHIPPER)', () => {
  const autoShipper = { name: 'AUTO SHIPPER', billingMethod: 'MANUAL', reviewRequirements: ['revDivision', 'referenceNumber', 'salesRep'] }
  it('drops the AP e-mail gap when the customer waives it, keeps the billing method', () => {
    const required = customerApEmailRequired(autoShipper, null)
    expect(required).toBe(false)
    expect(customerBillingGaps(autoShipper, { apEmailRequired: required })).toEqual([])
    expect(customerBillingGaps({ ...autoShipper, billingMethod: null }, { apEmailRequired: required })).toEqual(['CUSTOMER_BILLING_METHOD'])
    expect(customerBillingSummary(autoShipper, { apEmailRequired: required })).toBe('Manual invoice · AP e-mail: not required')
  })
  it('a factored customer can never waive it', () => {
    const factored = { ...autoShipper, name: 'Acme Freight', billingMethod: 'FACTOR' }
    expect(customerApEmailRequired(factored, null)).toBe(true)
    expect(customerBillingGaps(factored, { apEmailRequired: customerApEmailRequired(factored, null) })).toEqual(['CUSTOMER_AP_EMAIL'])
  })
  it('the AUTO SHIPPER is never factored (Ryne 2026-11-27), so even a stray FACTOR on it may still waive it', () => {
    expect(customerApEmailRequired({ ...autoShipper, billingMethod: 'FACTOR' }, null)).toBe(false)
  })
  it('defaults to required (no list, or a list that keeps it)', () => {
    expect(customerApEmailRequired({ billingMethod: 'MANUAL' }, null)).toBe(true)
    expect(customerApEmailRequired({ billingMethod: 'MANUAL', reviewRequirements: ['apEmail'] }, null)).toBe(true)
    expect(customerBillingGaps({ billingMethod: 'MANUAL' })).toEqual(['CUSTOMER_AP_EMAIL'])
  })
})

describe('Load Review customer columns (Ryne 2026-11-16)', () => {
  it('reads the invoice method and the AP email on their own', async () => {
    const { customerInvoiceMethodText, customerApEmailText } = await import('./customerBillingReady')
    expect(customerInvoiceMethodText({ billingMethod: 'FACTOR' })).toBe('Factor')
    expect(customerInvoiceMethodText({ billingMethod: 'MANUAL' })).toBe('Manual invoice')
    expect(customerInvoiceMethodText({ billingMethod: null })).toBe('')
    expect(customerApEmailText({ apEmail: 'ap@x.com' })).toBe('ap@x.com')
    expect(customerApEmailText({ apEmail: null }, { apEmailRequired: false })).toBe('Not required')
    expect(customerApEmailText({ apEmail: null })).toBe('')
  })
})
