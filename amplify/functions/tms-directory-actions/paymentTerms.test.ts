import { describe, it, expect } from 'vitest'
import { resolvePaymentTermsDays, DEFAULT_PAYMENT_TERMS_DAYS } from './handler'

describe('resolvePaymentTermsDays (terms are required on every customer)', () => {
  it('uses the value typed', () => {
    expect(resolvePaymentTermsDays(120, 30, false)).toBe(120)
    expect(resolvePaymentTermsDays('45', null, true)).toBe(45)
  })
  it('a blank value keeps what the customer already has', () => {
    expect(resolvePaymentTermsDays(undefined, 120, false)).toBe(120)
    expect(resolvePaymentTermsDays(null, 60, false)).toBe(60)
    expect(resolvePaymentTermsDays('', 15, false)).toBe(15)
  })
  it('a new customer with no terms gets Net 30', () => {
    expect(DEFAULT_PAYMENT_TERMS_DAYS).toBe(30)
    expect(resolvePaymentTermsDays(undefined, undefined, true)).toBe(30)
  })
  it('an edit never invents terms the record lacks (that would demand a reason)', () => {
    expect(resolvePaymentTermsDays(undefined, null, false)).toBeNull()
  })
  it('rejects a negative or fractional value', () => {
    expect(() => resolvePaymentTermsDays(-1, 30, false)).toThrow()
    expect(() => resolvePaymentTermsDays(2.5, 30, false)).toThrow()
  })
})
