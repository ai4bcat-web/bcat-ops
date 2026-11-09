import { describe, expect, it } from 'vitest'
import { NO_ALJEX_INVOICE_DATE_PROS } from './noAljexInvoiceDatePros'
import { needsBillingReview, noAljexInvoiceDate, reviewBillingNote, REVIEW_BILLING_NO_INVOICE_NOTE, REVIEW_BILLING_NOTE } from './reviewBilling'

const noInvoicePro = NO_ALJEX_INVOICE_DATE_PROS[0]

describe('Review billing', () => {
  it('flags pre-cutover shipments (imported or backfilled originals) in Docs needed, and only those', () => {
    expect(needsBillingReview({ arStatus: 'DOCS_NEEDED', legacyImported: true })).toBe(true)
    expect(needsBillingReview({ arStatus: 'DOCS_NEEDED', source: 'BACKFILL' })).toBe(true)
    expect(needsBillingReview({ arStatus: 'DOCS_NEEDED', source: 'MANUAL' })).toBe(false)
    expect(needsBillingReview({ arStatus: 'UNBILLED', legacyImported: true })).toBe(false)
    expect(needsBillingReview({ arStatus: null, legacyImported: true })).toBe(false)
  })

  it('names possible unbilled freight only for an imported shipment Aljex never invoiced', () => {
    expect(noAljexInvoiceDate({ legacyImported: true, number: ` ${noInvoicePro} ` })).toBe(true)
    expect(noAljexInvoiceDate({ legacyImported: false, number: noInvoicePro })).toBe(false)
    expect(noAljexInvoiceDate({ legacyImported: true, number: '99999999' })).toBe(false)
    expect(reviewBillingNote({ legacyImported: true, number: noInvoicePro })).toBe(REVIEW_BILLING_NO_INVOICE_NOTE)
    expect(reviewBillingNote({ legacyImported: true, number: '99999999' })).toBe(REVIEW_BILLING_NOTE)
  })

  it('ships the 41 no-invoice-date PROs of the 62 imported', () => {
    expect(new Set(NO_ALJEX_INVOICE_DATE_PROS).size).toBe(41)
  })
})
