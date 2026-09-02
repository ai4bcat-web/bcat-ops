import { describe, it, expect } from 'vitest'
// debit reasons ride the same lookup — see the debit test below
import { CREDIT_REASONS, DEFAULT_CREDIT_REASON, creditReasonLabel, creditLineLabel } from './payCredits'

describe('pay credit reason codes', () => {
  it('has unique codes and a valid default', () => {
    const codes = CREDIT_REASONS.map((r) => r.code)
    expect(new Set(codes).size).toBe(codes.length)
    expect(codes).toContain(DEFAULT_CREDIT_REASON)
  })

  it('resolves a code to its label', () => {
    expect(creditReasonLabel('DETENTION')).toBe('Detention')
    expect(creditReasonLabel('TONU')).toBe('TONU')
  })

  it('falls back to the raw code so an old/unknown code never renders blank', () => {
    expect(creditReasonLabel('SOME_LEGACY_CODE')).toBe('SOME_LEGACY_CODE')
    expect(creditReasonLabel(null)).toBe('Credit')
    expect(creditReasonLabel('')).toBe('Credit')
  })

  it('builds the statement line from reason + note', () => {
    expect(creditLineLabel({ reasonCode: 'DETENTION', label: 'Kroger 4hr wait' })).toBe('Detention — Kroger 4hr wait')
    expect(creditLineLabel({ reasonCode: 'BONUS', label: '  ' })).toBe('Bonus')
    expect(creditLineLabel({ reasonCode: 'LAYOVER' })).toBe('Layover')
  })
})

import { DEBIT_REASONS, DEFAULT_DEBIT_REASON, creditReasonLabel as lbl } from './payCredits'

describe('debit reason codes', () => {
  it('has unique codes and a valid default', () => {
    const codes = DEBIT_REASONS.map((r) => r.code)
    expect(new Set(codes).size).toBe(codes.length)
    expect(codes).toContain(DEFAULT_DEBIT_REASON)
  })
  it('debit codes resolve through the shared label lookup', () => {
    expect(lbl('CASH_ADVANCE')).toBe('Cash advance')
    expect(lbl('DAMAGE')).toBe('Damage / claim')
  })
})
