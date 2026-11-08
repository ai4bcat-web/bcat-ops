import { describe, expect, it } from 'vitest'
import {
  billingIssues,
  isDanisco,
  parseEmailList,
  paymentTermsFor,
  seedFromAljexRow,
  validateBillingFields,
} from './billingMethod'

const row = (over: Record<string, unknown> = {}) => ({ accountNumber: '900001', name: 'ZETA FREIGHT CO', eBillingEmail: 'ap@zeta-example.com', ...over })

describe('seedFromAljexRow', () => {
  it('ivanfactoring@ and invoicefactoring@ are FACTOR with no AP e-mail', () => {
    for (const email of ['ivanfactoring@bcatcorp.com', 'IvanFactoring@bcatcorp.com ', 'invoicefactoring@bcatcorp.com']) {
      expect(seedFromAljexRow(row({ name: 'ALPHA SUPPLY', eBillingEmail: email }))).toMatchObject({
        action: 'IMPORT_CUSTOMER', billingMethod: 'FACTOR', apEmail: null, billingNeedsReview: null,
      })
    }
  })

  it('an external address is MANUAL with that address as the AP e-mail', () => {
    expect(seedFromAljexRow(row({ name: 'ALPHA SUPPLY', eBillingEmail: 'Billing@Alpha-Example.com' }))).toMatchObject({
      billingMethod: 'MANUAL', apEmail: 'billing@alpha-example.com', billingNeedsReview: null,
    })
  })

  it('another internal BCAT address is MANUAL, never FACTOR, with no AP e-mail and a review flag', () => {
    const seed = seedFromAljexRow(row({ name: 'ALPHA SUPPLY', eBillingEmail: 'invoices@bcatcorp.com' }))
    expect(seed).toMatchObject({ billingMethod: 'MANUAL', apEmail: null })
    expect(seed.billingNeedsReview).toMatch(/internal/)
  })

  it('no address leaves the method unset and flagged', () => {
    const seed = seedFromAljexRow(row({ name: 'ALPHA SUPPLY', eBillingEmail: '  ' }))
    expect(seed).toMatchObject({ action: 'IMPORT_CUSTOMER', billingMethod: null })
    expect(seed.billingNeedsReview).toBeTruthy()
  })

  it('Status N becomes a Location with no billing method', () => {
    expect(seedFromAljexRow(row({ name: 'ALPHA SUPPLY', status: 'N' }))).toMatchObject({ action: 'IMPORT_LOCATION', billingMethod: null, apEmail: null })
  })

  it('excludes TEST CUSTOMER (100003) and ZZ/test names but imports GUEST SUPPLY', () => {
    expect(seedFromAljexRow(row({ accountNumber: '100003', name: 'TEST CUSTOMER' })).action).toBe('EXCLUDE')
    expect(seedFromAljexRow(row({ name: 'ZZ DO NOT USE' })).action).toBe('EXCLUDE')
    expect(seedFromAljexRow(row({ name: 'Some Test Account' })).action).toBe('EXCLUDE')
    expect(seedFromAljexRow(row({ name: 'GUEST SUPPLY' })).action).toBe('IMPORT_CUSTOMER')
  })
})

describe('payment terms', () => {
  it('defaults to Net 30', () => {
    expect(paymentTermsFor({ accountNumber: '900001', name: 'ALPHA SUPPLY' })).toBe(30)
  })
  it('uses the Aljex terms when present', () => {
    expect(paymentTermsFor({ accountNumber: '900001', name: 'ALPHA SUPPLY', aljexTermsDays: 45 })).toBe(45)
  })
  it('Danisco is 120 days for both accounts and for name variants, regardless of Aljex terms', () => {
    expect(paymentTermsFor({ accountNumber: '100338', name: 'DANISCO US INC.', aljexTermsDays: 30 })).toBe(120)
    expect(paymentTermsFor({ accountNumber: '100629', name: 'DANISCO USA INC.' })).toBe(120)
    expect(paymentTermsFor({ accountNumber: '', name: 'DANISCO US, INC.' })).toBe(120)
    expect(seedFromAljexRow(row({ accountNumber: '777777', name: 'Danisco US, Inc.' })).paymentTermsDays).toBe(120)
  })
  it('does not catch other Danisco-like names', () => {
    expect(isDanisco('555', 'DANISCO UK LTD')).toBe(false)
  })
})

describe('billingIssues / validateBillingFields', () => {
  it('flags unset method, MANUAL without AP e-mail and review notes', () => {
    expect(billingIssues({})).toEqual(['METHOD_UNSET'])
    expect(billingIssues({ billingMethod: 'MANUAL' })).toEqual(['AP_EMAIL_MISSING'])
    expect(billingIssues({ billingMethod: 'MANUAL', apEmail: 'a@b.co', billingNeedsReview: 'x' })).toEqual(['NEEDS_REVIEW'])
    expect(billingIssues({ billingMethod: 'FACTOR' })).toEqual([])
  })
  it('MANUAL needs a valid AP e-mail and every copy address must be valid', () => {
    expect(validateBillingFields({ billingMethod: 'MANUAL' }).apEmail).toBeTruthy()
    expect(validateBillingFields({ billingMethod: 'MANUAL', apEmail: 'bad' }).apEmail).toBeTruthy()
    expect(validateBillingFields({ billingMethod: 'FACTOR', invoiceCopyEmails: ['x@y.co', 'nope'] }).invoiceCopyEmails).toMatch(/nope/)
    expect(validateBillingFields({ billingMethod: 'MANUAL', apEmail: 'a@b.co', invoiceCopyEmails: ['x@y.co'] })).toEqual({})
  })
  it('parseEmailList splits, lowercases and dedupes', () => {
    expect(parseEmailList('A@x.co, b@x.co;\na@x.co  c@x.co')).toEqual(['a@x.co', 'b@x.co', 'c@x.co'])
  })
})
