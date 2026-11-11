import { describe, expect, it } from 'vitest'
import { DEFAULT_CHARGE_CODES, withDefaultChargeCodes } from './chargeCodeDefaults'

describe('withDefaultChargeCodes', () => {
  it('offers every default when nothing is saved', () => {
    expect(withDefaultChargeCodes(null).map((c) => c.code)).toEqual(DEFAULT_CHARGE_CODES.map((c) => c.code))
  })
  it('keeps every saved code first and unchanged, and does not repeat a default the company already has (any case)', () => {
    const saved = [{ code: 'detention', label: 'Our detention', calculatedBy: 'PER_CWT' as const, defaultAmountCents: 5000 }, { code: 'CUSTOM1', label: 'Custom', calculatedBy: 'FLAT' as const }]
    const out = withDefaultChargeCodes(saved)
    expect(out.slice(0, 2)).toEqual(saved)
    expect(out.filter((c) => c.code.toUpperCase() === 'DETENTION')).toHaveLength(1)
    expect(out).toHaveLength(DEFAULT_CHARGE_CODES.length + 1)
  })
  it('has unique, upper-case codes the picker can match, and never carries an amount', () => {
    const codes = DEFAULT_CHARGE_CODES.map((c) => c.code)
    expect(new Set(codes).size).toBe(codes.length)
    for (const c of DEFAULT_CHARGE_CODES) { expect(c.code).toBe(c.code.toUpperCase()); expect(c.defaultAmountCents).toBeNull() }
    expect(codes).not.toContain('LINEHAUL')
    expect(codes).not.toContain('FSC')
  })
})
