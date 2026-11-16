import { describe, expect, it } from 'vitest'
import { OVERPAY_REASON, SHORT_PAY_REASON, differenceReason, isShortPayNote } from './paymentDifference'

describe('paymentDifference', () => {
  it('marks a short pay by its standard reason, with or without the person\'s own words', () => {
    expect(isShortPayNote(SHORT_PAY_REASON)).toBe(true)
    expect(isShortPayNote(differenceReason(SHORT_PAY_REASON, ' disputed lumper '))).toBe(true)
    expect(isShortPayNote('Factoring fee (OTR 2%)')).toBe(false)
    expect(isShortPayNote(null)).toBe(false)
  })
  it('puts the person\'s words after the standard reason', () => {
    expect(differenceReason(OVERPAY_REASON, 'rounded up')).toBe('Overpay accepted as paid in full: rounded up')
    expect(differenceReason(OVERPAY_REASON, '  ')).toBe('Overpay accepted as paid in full')
    expect(differenceReason(OVERPAY_REASON, undefined)).toBe('Overpay accepted as paid in full')
  })
})
