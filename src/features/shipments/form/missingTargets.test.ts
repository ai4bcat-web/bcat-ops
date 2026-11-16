import { describe, expect, it } from 'vitest'
import { missingTargetOf, FACTOR_STOP_FIELD } from './missingTargets'
import { LABEL } from './labels'

describe('What\'s missing: every item points somewhere (Ryne 2026-11-16: "click that piece and have it take you to that spot")', () => {
  const keys = [
    'salesRep', 'revDivision', 'customerRate', 'expense', 'profit', 'po', 'doc:POD', 'doc:RATE_CON',
    'customer:CUSTOMER_BILLING_METHOD', 'customer:CUSTOMER_AP_EMAIL', 'factor:CUSTOMER_MC', 'factor:BILLING_METHOD',
    ...Object.keys(FACTOR_STOP_FIELD).map((c) => `factor:${c}`),
  ]
  for (const key of keys) {
    it(`${key} has a field or the customer dialog`, () => {
      const t = missingTargetOf(key, true)
      expect(t).not.toBeNull()
      expect(Boolean(t!.fieldKey) || t!.action === 'editCustomer').toBe(true)
      expect(t!.hint.length).toBeGreaterThan(0)
    })
  }

  it('carrier cost goes to the carrier rate, and falls back to booking the carrier', () => {
    const t = missingTargetOf('expense', true)!
    expect(t.fieldKey).toBe(LABEL.rates.carrierLhRate.testId)
    expect(t.fallbackKeys).toContain(LABEL.carrier.cover.testId)
  })

  it('sales rep, division and customer rate go to their own fields', () => {
    expect(missingTargetOf('salesRep', true)!.fieldKey).toBe(LABEL.roles.salesRepId.testId)
    expect(missingTargetOf('revDivision', true)!.fieldKey).toBe(LABEL.shipping.revDivision.testId)
    expect(missingTargetOf('customerRate', true)!.fieldKey).toBe(LABEL.rates.customerLhRate.testId)
  })

  it('what lives on the customer opens the customer dialog; with no customer it points at the Link customer control', () => {
    expect(missingTargetOf('customer:CUSTOMER_AP_EMAIL', true)).toMatchObject({ action: 'editCustomer' })
    expect(missingTargetOf('factor:CUSTOMER_MC', true)).toMatchObject({ action: 'editCustomer' })
    const t = missingTargetOf('customer:CUSTOMER_BILLING_METHOD', false)!
    expect(t.action).toBeUndefined()
    expect(t.fieldKey).toBe('f-customer-change')
  })

  it('a stop gap points at the stop\'s own field', () => {
    expect(missingTargetOf('factor:PICKUP_ZIP', true)!.fieldKey).toBe('f-pickup-zip')
    expect(missingTargetOf('factor:DELIVERY_CITY', true)!.fieldKey).toBe('f-consignee-city')
  })

  it('an unknown key is left to the caller', () => {
    expect(missingTargetOf('mystery', true)).toBeNull()
  })
})
