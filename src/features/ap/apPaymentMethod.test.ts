import { describe, it, expect } from 'vitest'
import { AP_PAYMENT_METHOD_LABEL } from './apViews'

describe('AP payment method labels', () => {
  it('names the card method for the Amex payments and keeps Zelle', () => {
    expect(AP_PAYMENT_METHOD_LABEL.CARD).toBe('Credit card (Amex)')
    expect(AP_PAYMENT_METHOD_LABEL.ZELLE).toBe('Zelle')
  })
  it('labels every method, so none renders blank', () => {
    for (const label of Object.values(AP_PAYMENT_METHOD_LABEL)) expect(label.trim()).not.toBe('')
  })
})
