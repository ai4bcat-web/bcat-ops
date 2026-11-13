import { describe, expect, it } from 'vitest'
import { INVOICE_FROM_ADDRESS, isInternalAddress } from './sendReview'

describe('isInternalAddress', () => {
  it('tags our own mailboxes, not the customer', () => {
    expect(isInternalAddress('Invoices@BCATCorp.com ')).toBe(true)
    expect(isInternalAddress('royalinvoices@teamtrg.com')).toBe(false)
    expect(isInternalAddress('someone@notbcatcorp.com.evil')).toBe(false)
  })
  it('sends from billing@', () => {
    expect(INVOICE_FROM_ADDRESS).toBe('billing@bcatcorp.com')
  })
})
