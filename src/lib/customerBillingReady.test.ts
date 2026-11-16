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
