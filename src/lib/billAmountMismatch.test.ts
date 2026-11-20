import { describe, expect, it } from 'vitest'
import { amountMismatchCents, hasAmountMismatch } from './billAmountMismatch'

describe('amountMismatchCents', () => {
  it('is null with no invoice amount kept or when it equals the payable', () => {
    expect(amountMismatchCents({ grossCents: 140_000 })).toBeNull()
    expect(amountMismatchCents({ grossCents: 140_000, invoiceAmountCents: null })).toBeNull()
    expect(amountMismatchCents({ grossCents: 140_000, invoiceAmountCents: 140_000 })).toBeNull()
    expect(hasAmountMismatch({ grossCents: 140_000, invoiceAmountCents: 140_000 })).toBe(false)
  })

  it('is invoice minus payable, so a payable moved to the invoice clears the flag by itself', () => {
    expect(amountMismatchCents({ grossCents: 140_000, invoiceAmountCents: 155_000 })).toBe(15_000)
    expect(amountMismatchCents({ grossCents: 140_000, invoiceAmountCents: 130_000 })).toBe(-10_000)
    expect(hasAmountMismatch({ grossCents: 155_000, invoiceAmountCents: 155_000 })).toBe(false)
  })
})
