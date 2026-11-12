import { describe, expect, it } from 'vitest'
import { ACCOUNTING_PAGES, accountingAccessMessage, hasAccountingPage } from './accountingAccess'

describe('hasAccountingPage', () => {
  it('opens every accounting page to the owner and the ADMIN group', () => {
    for (const { key } of ACCOUNTING_PAGES) {
      expect(hasAccountingPage([], 'ryne@bcatcorp.com', key)).toBe(true)
      expect(hasAccountingPage(['ADMIN'], 'a@bcatcorp.com', key)).toBe(true)
    }
  })

  it('opens a page on its own grant and nothing else', () => {
    expect(hasAccountingPage(['page-carrierPay'], 'b@bcatcorp.com', 'carrierPay')).toBe(true)
    expect(hasAccountingPage(['page-carrierPay'], 'b@bcatcorp.com', 'invoicing')).toBe(false)
    expect(hasAccountingPage(['page-tms', 'page-loads'], 'b@bcatcorp.com', 'invoicing')).toBe(false)
    expect(hasAccountingPage(null, null, 'invoicing')).toBe(false)
  })

  it('reads the old billing-release grant as Load review and Invoicing, and Invoicing as Factoring', () => {
    expect(hasAccountingPage(['page-billingRelease'], 'j@bcatcorp.com', 'loadReview')).toBe(true)
    expect(hasAccountingPage(['page-billingRelease'], 'j@bcatcorp.com', 'invoicing')).toBe(true)
    expect(hasAccountingPage(['page-billingRelease'], 'j@bcatcorp.com', 'carrierPay')).toBe(false)
    expect(hasAccountingPage(['page-invoicing'], 'j@bcatcorp.com', 'factoring')).toBe(true)
    expect(hasAccountingPage(['page-factoring'], 'j@bcatcorp.com', 'invoicing')).toBe(false)
  })

  it('names the page in the refusal', () => {
    expect(accountingAccessMessage('carrierPay')).toBe('You need access to Accounts payable (Settings > Users).')
  })
})
